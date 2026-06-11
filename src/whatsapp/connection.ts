import type { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type proto,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import { EventEmitter } from "node:events";
import { accountIdFromMeId } from "../persistence/accounts.js";
import { loadAllChats, loadChat } from "../persistence/chatStore.js";
import { getLogger } from "./logger.js";

export type ConnectionStatus = "connecting" | "open" | "close" | "logged-out";

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 10000;
/**
 * How many times to retry before concluding the stored session is dead and
 * re-pairing. When the phone unlinks us, WhatsApp doesn't send a clean
 * `loggedOut` — it just terminates the stream with `connectionClosed` (428)
 * every time, so we'd otherwise reconnect forever behind a stale chat list.
 * That code is indistinguishable from a transient drop, so the only reliable
 * signal of an unlink is "we keep closing and never reach `open`". With the
 * backoff schedule (2,4,8,16,30,30s) this is ~90s of retrying before we wipe
 * creds and show a fresh QR — long enough to ride out brief network blips.
 */
const MAX_RECONNECT_ATTEMPTS = 6;
const MESSAGE_CACHE_LIMIT = 2_000;

const recentMessageContent = new Map<string, proto.IMessage>();
const recentMessageContentById = new Map<string, proto.IMessage>();

function messageCacheKey(jid: string, id: string): string {
  return `${jid}\0${id}`;
}

function rememberMessage(message: WAMessage): void {
  if (!message.key.remoteJid || !message.key.id || !message.message) return;
  const key = messageCacheKey(jidNormalizedUser(message.key.remoteJid), message.key.id);
  recentMessageContent.delete(key);
  recentMessageContent.set(key, message.message);
  recentMessageContentById.delete(message.key.id);
  recentMessageContentById.set(message.key.id, message.message);
  if (recentMessageContent.size > MESSAGE_CACHE_LIMIT) {
    const oldestKey = recentMessageContent.keys().next().value!;
    recentMessageContent.delete(oldestKey);
    const oldestId = oldestKey.slice(oldestKey.lastIndexOf("\0") + 1);
    recentMessageContentById.delete(oldestId);
  }
}

/**
 * Disconnect reasons that mean the stored session is dead and reconnecting with
 * the same creds can never recover — the user must re-pair. The phone unlinking
 * us is the motivating case: depending on timing WhatsApp surfaces it as a plain
 * `loggedOut` (401) failure, but also as `forbidden` (403, account-level) or
 * `multideviceMismatch` (411, our registration no longer matches). Treating only
 * 401 as terminal left the other two looping forever behind a stale chat list,
 * so the app never noticed it had been unlinked.
 *
 * Everything else (network drops, `restartRequired`, timeouts) is transient and
 * should reconnect.
 */
const LOGOUT_REASONS: ReadonlySet<number> = new Set([
  DisconnectReason.loggedOut, // 401 — device removed from phone / explicit logout
  DisconnectReason.forbidden, // 403 — account blocked
  DisconnectReason.multideviceMismatch, // 411 — re-pair required
]);

/** A close that invalidates our session — wipe creds and return to pairing. */
export function isLoggedOut(statusCode: number | undefined): boolean {
  return statusCode !== undefined && LOGOUT_REASONS.has(statusCode);
}

/** Reconnect on every close except one that invalidated our session. */
export function shouldReconnect(statusCode: number | undefined): boolean {
  return !isLoggedOut(statusCode);
}

/**
 * Resolve a message's content from our persisted store. Baileys needs this to
 * re-encrypt and resend a message when a recipient device reports it couldn't
 * decrypt it (retry receipt) — without it those sends are silently lost.
 * Errors degrade to "not found": during a fresh pairing no account is active
 * yet, so the chat store would throw rather than return nothing.
 */
async function getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
  try {
    return await resolveMessageContent(key);
  } catch (err) {
    getLogger().warn({ err, key }, "getMessage lookup failed — treating as not found");
    return undefined;
  }
}

export async function resolveMessageContent(
  key: WAMessageKey,
  deps: {
    loadChat: typeof loadChat;
    loadAllChats: typeof loadAllChats;
  } = { loadChat, loadAllChats },
): Promise<proto.IMessage | undefined> {
  if (!key.remoteJid || !key.id) return undefined;
  const jid = jidNormalizedUser(key.remoteJid);
  const cached = recentMessageContent.get(messageCacheKey(jid, key.id));
  if (cached) return cached;
  const cachedById = recentMessageContentById.get(key.id);
  if (cachedById) return cachedById;
  const chat = await deps.loadChat(jid);
  const raw = chat?.messages.find((m) => m.id === key.id)?.raw as WAMessage | null | undefined;
  if (raw?.message) return raw.message;

  // Encrypted edit target keys can use the editor's perspective of remoteJid,
  // which may point at our own LID instead of the chat that stores the message.
  for (const candidate of await deps.loadAllChats()) {
    const fallbackRaw = candidate.messages.find((message) => message.id === key.id)?.raw as
      | WAMessage
      | null
      | undefined;
    if (fallbackRaw?.message) return fallbackRaw.message;
  }
  return undefined;
}

interface ConnectionUpdateLike {
  connection?: "open" | "connecting" | "close";
  lastDisconnect?: { error?: unknown };
}

function statusCodeOf(update: ConnectionUpdateLike): number | undefined {
  return (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
}

/** Map a raw Baileys connection-update into our small status vocabulary. */
export function mapConnectionUpdate(
  update: ConnectionUpdateLike,
): ConnectionStatus | null {
  if (!update.connection) return null;
  if (update.connection === "close") {
    return isLoggedOut(statusCodeOf(update)) ? "logged-out" : "close";
  }
  return update.connection;
}

export interface ConnectionOptions {
  /** Where Baileys creds live — an account's auth dir, or a pending dir while linking. */
  authDir: string;
  /**
   * Pairing a not-yet-known account: when the post-QR close arrives with a
   * paired identity in creds, emit `paired` (with the normalized account id)
   * instead of reconnecting — the caller moves the auth dir into its permanent
   * account location and starts a fresh connection from there.
   */
  linkMode?: boolean;
}

export interface Connection extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(jid: string, text: string): ReturnType<WASocket["sendMessage"]>;
  getSocket(): WASocket | null;
}

export function createConnection(options: ConnectionOptions): Connection {
  const { authDir, linkMode = false } = options;
  const emitter = new EventEmitter() as Connection;
  const log = getLogger().child({ module: "connection" });

  let sock: WASocket | null = null;
  let started = false;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  /** Live creds of the current socket — pairing writes `me` here the moment the QR is scanned. */
  let creds: { me?: { id: string } } | null = null;

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || stopped) return;
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      log.warn(
        { attempts: reconnectAttempt },
        "reconnect attempts exhausted — assuming unlinked, reporting session dead",
      );
      sessionDead();
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt += 1;
    log.info({ delay, attempt: reconnectAttempt }, "scheduling reconnect");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => {
        log.error({ err }, "reconnect attempt failed");
        scheduleReconnect();
      });
    }, delay);
  }

  /**
   * The session is gone (explicit logout, or reconnects exhausted because the
   * phone unlinked us): stop and report `logged-out`. The owner (app store)
   * decides what that means — it removes the account's creds (never its chat
   * data) and returns to the account selector. The connection itself must not
   * touch the disk: creds removal is an account-level policy, not ours.
   */
  function sessionDead(): void {
    sock = null;
    clearReconnectTimer();
    reconnectAttempt = 0;
    emitter.emit("status", "logged-out");
  }

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    creds = state.creds;
    // WhatsApp rejects connections from clients reporting a stale WA Web
    // version with `<failure reason='405'/>` — before a QR is ever issued —
    // so we must always negotiate with the current version.
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log.info({ version, isLatest }, "using WA Web version");
    const socket = makeWASocket({
      auth: state,
      version,
      logger: getLogger().child({ module: "baileys" }),
      printQRInTerminal: false,
      // lurk-friendly per spec: never broadcast presence or read state
      markOnlineOnConnect: false,
      // Without this, Baileys defaults `shouldSyncHistoryMessage` to
      // `() => !!syncFullHistory` (false), so it never processes the
      // INITIAL_BOOTSTRAP/RECENT history notifications and never emits
      // `messaging-history.set` — chats show up (via chats.upsert) but every
      // conversation is empty. Enabling it makes WhatsApp deliver message
      // history on link.
      syncFullHistory: true,
      getMessage,
    });
    sock = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      if (update.qr) emitter.emit("qr", update.qr);

      const status = mapConnectionUpdate(update);
      if (status) emitter.emit("status", status);

      if (update.connection === "open") {
        reconnectAttempt = 0;
      } else if (update.connection === "close") {
        const statusCode = statusCodeOf(update);
        log.info(
          { statusCode, status, attempt: reconnectAttempt },
          "connection closed",
        );
        if (status === "logged-out") {
          sessionDead();
        } else if (linkMode && creds?.me?.id) {
          // QR scanned: pairing wrote our identity into creds, and WhatsApp
          // closes the stream (restartRequired) expecting a reconnect. Hand
          // control back instead — the owner relocates the auth dir to its
          // permanent account home and reconnects from there.
          const accountId = accountIdFromMeId(creds.me.id);
          log.info({ accountId }, "pairing complete — handing off to account finalization");
          sock = null;
          clearReconnectTimer();
          emitter.emit("paired", accountId);
        } else {
          scheduleReconnect();
        }
      }
    });

    socket.ev.on("messaging-history.set", (payload) => {
      for (const message of payload.messages) rememberMessage(message);
      emitter.emit("history", payload);
    });
    socket.ev.on("messages.upsert", (payload) => {
      for (const message of payload.messages) rememberMessage(message);
      emitter.emit("messages", payload);
    });
    socket.ev.on("messages.update", (payload) =>
      emitter.emit("message-update", payload),
    );
    socket.ev.on("messages.reaction", (payload) =>
      emitter.emit("reaction", payload),
    );
    socket.ev.on("message-receipt.update", (payload) =>
      emitter.emit("receipts", payload),
    );
    socket.ev.on("contacts.upsert", (payload) =>
      emitter.emit("contacts", payload),
    );
    // `contacts.update` carries push names and verified business names (Baileys
    // emits it for every inbound message with a pushName, and for app-state
    // contact changes). Without it, @lid chats never learn their display name.
    socket.ev.on("contacts.update", (payload) =>
      emitter.emit("contacts", payload),
    );
    socket.ev.on("chats.upsert", (payload) => emitter.emit("chats", payload));
    socket.ev.on("chats.update", (payload) => emitter.emit("chats", payload));
    socket.ev.on("groups.update", (payload) => emitter.emit("groups", payload));
    socket.ev.on("group-participants.update", (payload) =>
      emitter.emit("groups", payload),
    );
  }

  emitter.start = async () => {
    if (started) return;
    started = true;
    stopped = false;
    // The caches are module-level but sessions are per-account: a process that
    // returns to the selector and opens another account must not resolve
    // getMessage lookups against the previous account's messages.
    recentMessageContent.clear();
    recentMessageContentById.clear();
    emitter.emit("status", "connecting");
    await connect();
  };

  emitter.stop = async () => {
    stopped = true;
    started = false;
    clearReconnectTimer();
    if (sock) {
      const current = sock;
      sock = null;
      try {
        current.end(undefined);
      } catch {
        // socket already torn down
      }
    }
  };

  emitter.sendText = (jid, text) => {
    if (!sock) throw new Error("connection not started");
    return sock.sendMessage(jid, { text });
  };

  emitter.getSocket = () => sock;

  return emitter;
}
