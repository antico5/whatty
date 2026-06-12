import {
  cleanupPendingAuthDirs as defaultCleanupPendingAuthDirs,
  createPendingAuthDir as defaultCreatePendingAuthDir,
  finalizePendingAccount as defaultFinalizePendingAccount,
  listLinkedAccounts as defaultListLinkedAccounts,
  removeAccountCreds as defaultRemoveAccountCreds,
  type AccountInfo,
} from "../persistence/accounts.js";
import { loadAllChats as defaultLoadAllChats, loadChat as defaultLoadChat } from "../persistence/chatStore.js";
import { closeActiveDb, getActiveDb, pruneEvents } from "../persistence/db.js";
import { getDiskUsage as defaultGetDiskUsage, type DiskUsage } from "../persistence/diskUsage.js";
import { acquireInstanceLock, type InstanceLock } from "../persistence/instanceLock.js";
import { setActiveAccount } from "../persistence/paths.js";
import { createFsQueue } from "../queue/fsQueue.js";
import { jobHandlers } from "../queue/handlers/index.js";
import { refreshGroupJobName } from "../queue/handlers/shared.js";
import { createProcessor, type ProcessorApi } from "../queue/processor.js";
import type { DataChange } from "../queue/types.js";
import type { Chat, Message } from "../types/index.js";
import { createSerialQueues } from "../util/serialQueues.js";
import {
  createConnection as defaultCreateConnection,
  type Connection,
  type ConnectionOptions,
  type ConnectionStatus,
} from "../whatsapp/connection.js";
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
  cleanupPendingAuthDirs: () => Promise<void>;
  createPendingAuthDir: () => Promise<string>;
  finalizePendingAccount: (pendingAuthDir: string) => Promise<AccountInfo>;
  removeAccountCreds: (accountId: string) => Promise<void>;
  getDiskUsage: (accountId: string) => Promise<DiskUsage>;
  /** Poll interval for disk usage in ms. Default 30 000. */
  diskUsagePollInterval?: number;
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
  /**
   * Leave the active session and return to the account selector.
   * Flushes pending writes, stops the connection (including any reconnect
   * timers), and transitions phase → "select". Chat data is never deleted.
   */
  leaveSession(): Promise<void>;
  getChats(): Chat[];
  getChat(jid: string): Chat | null;
  getConnection(): ConnectionInfo;
  isReadonly(): boolean;
  sendText(jid: string, text: string): Promise<Message>;
  getDiskUsage(): DiskUsage | null;
  /** If `jid` is a group with no participants stored, fetches fresh group metadata in the background. */
  refreshGroupIfNeeded(jid: string): void;
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
  const cleanupPendingAuthDirs = deps.cleanupPendingAuthDirs ?? defaultCleanupPendingAuthDirs;
  const createPendingAuthDir = deps.createPendingAuthDir ?? defaultCreatePendingAuthDir;
  const finalizePendingAccount = deps.finalizePendingAccount ?? defaultFinalizePendingAccount;
  const removeAccountCreds = deps.removeAccountCreds ?? defaultRemoveAccountCreds;
  const getDiskUsageFn = deps.getDiskUsage ?? defaultGetDiskUsage;
  const diskUsagePollInterval = deps.diskUsagePollInterval ?? 30_000;
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
  let processor: ProcessorApi | null = null;
  let sender: ReturnType<typeof createSender> | null = null;
  let diskUsage: DiskUsage | null = null;
  let diskUsageTimer: ReturnType<typeof setInterval> | null = null;
  let instanceLock: InstanceLock | null = null;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function stopDiskUsagePoller(): void {
    if (diskUsageTimer !== null) {
      clearInterval(diskUsageTimer);
      diskUsageTimer = null;
    }
    diskUsage = null;
  }

  function startDiskUsagePoller(accountId: string): void {
    stopDiskUsagePoller();
    async function poll(): Promise<void> {
      try {
        const usage = await getDiskUsageFn(accountId);
        diskUsage = usage;
        notify();
      } catch (err) {
        log.error({ err, accountId }, "failed to poll disk usage");
      }
    }
    void poll();
    diskUsageTimer = setInterval(() => void poll(), diskUsagePollInterval);
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
        if (!chat) return;
        // Alias resolution can move a chat to its canonical jid (lid → phone
        // jid); drop the entry keyed by the old address or both would render.
        if (chat.jid !== jid) chats = chats.filter((c) => c.jid !== jid);
        upsertChatInList(chat);
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
    stopDiskUsagePoller();
    const conn = connection;
    connection = null;
    // Stop the socket first so no new jobs are enqueued, then the processor —
    // it only awaits the in-flight job; pending work stays on disk for the
    // next session.
    await conn?.stop();
    await processor?.stop();
    processor = null;
    sender = null;
    closeActiveDb();
    setActiveAccount(null);
    await instanceLock?.release();
    instanceLock = null;
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

    // Two instances on one account fight over the WA session (conflict/replaced
    // loop) and double-process the queue — refuse and fall back to the selector.
    try {
      instanceLock = await acquireInstanceLock(accountId);
    } catch (err) {
      log.error({ err, accountId }, "account is already open in another instance");
      setActiveAccount(null);
      phase = "select";
      connectionInfo = { connectionState: "close", qr: null };
      notify();
      return;
    }

    connectionInfo = { connectionState: "connecting", qr: null };
    notify();

    // Trim the events ring buffer; a prune failure must not block the session.
    try {
      pruneEvents(await getActiveDb());
    } catch (err) {
      log.error({ err, accountId }, "failed to prune the events ring buffer");
    }

    chats = sortByLastActivity(await loadAllChats());
    notify();

    startDiskUsagePoller(accountId);

    const conn = createConnection({
      // The processor is created just below; events only flow after conn.start().
      enqueueJob: (type, payload) => {
        if (!processor) return Promise.reject(new Error("job processor not ready"));
        return processor.enqueueEvent(type, payload);
      },
    });
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

    const proc = createProcessor(createFsQueue(accountId), conn, jobHandlers);
    processor = proc;
    proc.on("data-changed", applyDataChanges);
    sender = createSender(conn);
    sender.on("chat-updated", (jid: string) => reloadChat(jid));

    // Resume whatever the last run left pending (crash replay), then self-heal
    // recent messages whose media never linked, then go live.
    await proc.start();
    await proc.enqueueNamed("sweep-unlinked-media", "sweep-unlinked-media", {});
    await conn.start();
  }

  /**
   * The processor reports what data changed; the UI decides what that means.
   * For now every affected jid maps to a full chat reload — finer-grained
   * updates can land here without touching the processor or handlers.
   */
  function applyDataChanges(changes: DataChange[]): void {
    const jids = new Set<string>();
    for (const change of changes) {
      if (change.table === "accounts") for (const jid of change.jids) jids.add(jid);
      else jids.add(change.jid);
    }
    for (const jid of jids) reloadChat(jid);
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
      stopDiskUsagePoller();
      await connection?.stop();
      await processor?.stop();
      await instanceLock?.release();
      instanceLock = null;
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

    async leaveSession(): Promise<void> {
      if (phase !== "session") throw new Error(`cannot leave a session during phase "${phase}"`);
      await teardownSession();
      accounts = await listLinkedAccounts();
      phase = "select";
      connectionInfo = { connectionState: "connecting", qr: null };
      notify();
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

    getDiskUsage(): DiskUsage | null {
      return diskUsage;
    },
    refreshGroupIfNeeded(jid: string): void {
      const chat = chats.find((c) => c.jid === jid);
      if (!chat || chat.type !== "group" || !processor) return;
      // No participants yet, or some still read as @lid after alias
      // canonicalization — their lid↔pn pairing is unknown, and fresh group
      // metadata is what delivers it (sender labels depend on the pairing).
      const needsRefresh =
        chat.participants.length === 0 || chat.participants.some((p) => p.jid.endsWith("@lid"));
      if (needsRefresh) {
        void processor
          .enqueueNamed("refresh-group-metadata", refreshGroupJobName(jid), { jid })
          .catch((err) => log.error({ err, jid }, "failed to enqueue group refresh"));
      }
    },
  };
}
