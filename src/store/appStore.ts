import {
  cleanupPendingAuthDirs as defaultCleanupPendingAuthDirs,
  createPendingAuthDir as defaultCreatePendingAuthDir,
  finalizePendingAccount as defaultFinalizePendingAccount,
  listLinkedAccounts as defaultListLinkedAccounts,
  migrateLegacyLayout as defaultMigrateLegacyLayout,
  removeAccountCreds as defaultRemoveAccountCreds,
  type AccountInfo,
} from "../persistence/accounts.js";
import { loadAllChats as defaultLoadAllChats, loadChat as defaultLoadChat } from "../persistence/chatStore.js";
import { accountAuthDir, setActiveAccount } from "../persistence/paths.js";
import type { Chat, Message } from "../types/index.js";
import { createSerialQueues } from "../util/serialQueues.js";
import {
  createConnection as defaultCreateConnection,
  type Connection,
  type ConnectionOptions,
  type ConnectionStatus,
} from "../whatsapp/connection.js";
import { createIngestor, type Ingestor } from "../whatsapp/ingest.js";
import { getLogger } from "../whatsapp/logger.js";
import { createSender } from "../whatsapp/send.js";

export interface ConnectionInfo {
  connectionState: ConnectionStatus;
  qr: string | null;
}

/**
 * - `select`: the boot-time account picker (only when ≥1 linked account exists).
 * - `link`: pairing a new device — QR screen until the phone scans.
 * - `session`: an account is active; connect → chats, exactly the old app.
 * A dead session (unlinked phone) removes the account's creds — never its chat
 * data — and falls back to `select`, or straight to `link` if nothing is left.
 */
export type AppPhase = "select" | "link" | "session";

export interface AppStoreDeps {
  loadAllChats: () => Promise<Chat[]>;
  loadChat: (jid: string) => Promise<Chat | null>;
  createConnection: (options: ConnectionOptions) => Connection;
  listLinkedAccounts: () => Promise<AccountInfo[]>;
  migrateLegacyLayout: () => Promise<void>;
  cleanupPendingAuthDirs: () => Promise<void>;
  createPendingAuthDir: () => Promise<string>;
  finalizePendingAccount: (pendingAuthDir: string) => Promise<AccountInfo>;
  removeAccountCreds: (accountId: string) => Promise<void>;
  readonly?: boolean;
}

export interface AppStore {
  init(): Promise<void>;
  /** Stop ingesting and tear down the connection — for clean process shutdown. */
  stop(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getPhase(): AppPhase;
  getAccounts(): AccountInfo[];
  /** Boot the picked account: activate its data dir, connect, ingest — the old single-account flow. */
  selectAccount(accountId: string): Promise<void>;
  /** Pair a new device via QR; on success the account is finalized and its session starts. */
  linkNewDevice(): Promise<void>;
  getChats(): Chat[];
  getChat(jid: string): Chat | null;
  getConnection(): ConnectionInfo;
  isReadonly(): boolean;
  sendText(jid: string, text: string): Promise<Message>;
}

function sortByLastActivity(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Headless, framework-agnostic state bridge between the WhatsApp connection
 * (connection/ingest/send) and the React UI. Owns the account lifecycle
 * (selector → pairing → live session and back), keeps an in-memory sorted
 * copy of the active account's chats in sync with live events, and exposes a
 * `useSyncExternalStore`-friendly subscription API (stable references are
 * only replaced when something actually changes).
 */
export function createAppStore(deps: Partial<AppStoreDeps> = {}): AppStore {
  const loadAllChats = deps.loadAllChats ?? defaultLoadAllChats;
  const loadChat = deps.loadChat ?? defaultLoadChat;
  const createConnection = deps.createConnection ?? defaultCreateConnection;
  const listLinkedAccounts = deps.listLinkedAccounts ?? defaultListLinkedAccounts;
  const migrateLegacyLayout = deps.migrateLegacyLayout ?? defaultMigrateLegacyLayout;
  const cleanupPendingAuthDirs = deps.cleanupPendingAuthDirs ?? defaultCleanupPendingAuthDirs;
  const createPendingAuthDir = deps.createPendingAuthDir ?? defaultCreatePendingAuthDir;
  const finalizePendingAccount = deps.finalizePendingAccount ?? defaultFinalizePendingAccount;
  const removeAccountCreds = deps.removeAccountCreds ?? defaultRemoveAccountCreds;
  const readonly = deps.readonly ?? false;
  const log = getLogger().child({ module: "app-store" });

  const listeners = new Set<() => void>();
  // Per-jid reload queue so a slow earlier read can't clobber a faster later one.
  const queues = createSerialQueues();

  let phase: AppPhase = "select";
  let accounts: AccountInfo[] = [];
  let chats: Chat[] = [];
  let connectionInfo: ConnectionInfo = { connectionState: "connecting", qr: null };
  let connection: Connection | null = null;
  let ingestor: Ingestor | null = null;
  let sender: ReturnType<typeof createSender> | null = null;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function upsertChatInList(chat: Chat): void {
    const idx = chats.findIndex((c) => c.jid === chat.jid);
    const next = idx === -1 ? [...chats, chat] : chats.map((c, i) => (i === idx ? chat : c));
    chats = sortByLastActivity(next);
    notify();
  }

  function reloadChat(jid: string): void {
    queues.enqueue(jid, async () => {
      try {
        const chat = await loadChat(jid);
        if (chat) upsertChatInList(chat);
      } catch (err) {
        log.error({ err, jid }, "failed to reload chat for store");
      }
    });
  }

  function setQr(qr: string | null): void {
    if (connectionInfo.qr === qr) return;
    connectionInfo = { ...connectionInfo, qr };
    notify();
  }

  function setConnectionState(status: ConnectionStatus): void {
    const qr = status === "open" ? null : connectionInfo.qr;
    if (connectionInfo.connectionState === status && connectionInfo.qr === qr) return;
    connectionInfo = { connectionState: status, qr };
    notify();
  }

  async function teardownSession(): Promise<void> {
    const conn = connection;
    connection = null;
    ingestor?.stop();
    await ingestor?.flush();
    ingestor = null;
    sender = null;
    await conn?.stop();
    setActiveAccount(null);
    chats = [];
  }

  /**
   * The phone unlinked us (or the session is otherwise unrecoverable): forget
   * the account's creds so it leaves the selector — its chat history and media
   * stay on disk untouched and come back if the same phone re-links — then
   * fall back to the selector, or straight to pairing if no accounts remain.
   */
  async function handleSessionDead(accountId: string): Promise<void> {
    log.warn({ accountId }, "session dead — removing account creds (chat data kept)");
    await teardownSession();
    try {
      await removeAccountCreds(accountId);
    } catch (err) {
      log.error({ err, accountId }, "failed to remove dead account creds");
    }
    accounts = await listLinkedAccounts();
    if (accounts.length === 0) {
      await startLink();
    } else {
      phase = "select";
      connectionInfo = { connectionState: "connecting", qr: null };
      notify();
    }
  }

  async function startSession(accountId: string): Promise<void> {
    phase = "session";
    setActiveAccount(accountId);
    connectionInfo = { connectionState: "connecting", qr: null };
    notify();

    chats = sortByLastActivity(await loadAllChats());
    notify();

    const conn = createConnection({ authDir: accountAuthDir(accountId) });
    connection = conn;
    let deadHandled = false;
    conn.on("qr", (qr: string) => setQr(qr));
    conn.on("status", (status: ConnectionStatus) => {
      setConnectionState(status);
      if (status === "logged-out" && !deadHandled) {
        deadHandled = true;
        void handleSessionDead(accountId).catch((err) =>
          log.error({ err, accountId }, "failed to handle dead session"),
        );
      }
    });

    ingestor = createIngestor(conn);
    sender = createSender(conn);
    ingestor.on("chat-updated", (jid: string) => reloadChat(jid));
    sender.on("chat-updated", (jid: string) => reloadChat(jid));

    await conn.start();
  }

  async function startLink(): Promise<void> {
    phase = "link";
    connectionInfo = { connectionState: "connecting", qr: null };
    notify();

    const pendingDir = await createPendingAuthDir();
    const conn = createConnection({ authDir: pendingDir, linkMode: true });
    connection = conn;
    conn.on("qr", (qr: string) => setQr(qr));
    conn.on("status", (status: ConnectionStatus) => setConnectionState(status));
    conn.on("paired", () => {
      void (async () => {
        connection = null;
        await conn.stop();
        const account = await finalizePendingAccount(pendingDir);
        accounts = await listLinkedAccounts();
        await startSession(account.id);
      })().catch((err) => log.error({ err }, "failed to finalize newly linked account"));
    });

    await conn.start();
  }

  return {
    async init(): Promise<void> {
      await migrateLegacyLayout();
      await cleanupPendingAuthDirs();
      accounts = await listLinkedAccounts();
      if (accounts.length === 0) {
        await startLink();
      } else {
        phase = "select";
        notify();
      }
    },

    async stop(): Promise<void> {
      ingestor?.stop();
      await ingestor?.flush();
      await connection?.stop();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getPhase(): AppPhase {
      return phase;
    },

    getAccounts(): AccountInfo[] {
      return accounts;
    },

    async selectAccount(accountId: string): Promise<void> {
      if (phase !== "select") throw new Error(`cannot select an account during phase "${phase}"`);
      await startSession(accountId);
    },

    async linkNewDevice(): Promise<void> {
      if (phase !== "select") throw new Error(`cannot link a new device during phase "${phase}"`);
      await startLink();
    },

    getChats(): Chat[] {
      return chats;
    },

    getChat(jid: string): Chat | null {
      return chats.find((c) => c.jid === jid) ?? null;
    },

    getConnection(): ConnectionInfo {
      return connectionInfo;
    },

    isReadonly(): boolean {
      return readonly;
    },

    sendText(jid: string, text: string): Promise<Message> {
      if (readonly) throw new Error("send blocked — app is in read-only mode");
      if (!sender) throw new Error("no active session — select an account first");
      return sender.sendText(jid, text);
    },
  };
}
