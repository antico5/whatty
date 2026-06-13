# wa-chat — session context

## What this is

Terminal WhatsApp client. React + @opentui (TUI renderer, Zig-based), Baileys 7
for the WA protocol. **Runs under Bun** (`bun src/index.ts`); tests run under
**vitest/Node** — hence the dual SQLite driver in `src/persistence/sqlite.ts`
(`bun:sqlite` at runtime, `node:sqlite` under vitest).

## Commands

| Command          | What it does                     |
| ---------------- | -------------------------------- |
| `pnpm start`     | Run the app (Bun)                |
| `pnpm typecheck` | Type-check only (`tsc --noEmit`) |

## Architecture

- `src/whatsapp/` — Baileys socket (`connection.ts`), message mappers, media download, outbound send
- `src/queue/` — durable fs job queue: every Baileys event is journaled to disk by the
  connection listener (zero logic there — WhatsApp acks before we ever see an event), then
  `processor.ts` executes idempotent handlers (`handlers/`) against the DB. Two lanes: db
  (strict FIFO) and media (concurrent, paused offline). Failed jobs back off and park in
  `failed/`; crash recovery = replaying `pending/` at startup
- `src/persistence/` — SQLite stores (`chatStore.ts`, `peerStore.ts` for person identity/names, `accounts.ts` for app logins), `paths.ts`, `mediaStore.ts`, `storageActions.ts`, `instanceLock.ts` (one instance per account)
- `src/store/appStore.ts` — app state machine + React context (single source of truth for UI); consumes the processor's `data-changed` events
- `src/ui/` — screens and components; `MessageItem.tsx` owns layout math

## Testing policy

**Do not write, read, or run tests.** Ignore all `*.test.ts` / `*.spec.ts`
files — they are excluded from `tsconfig.json` and should not be touched.

## Hard invariants

- **Never delete chat data or media in normal flows.** Account "removal" wipes
  auth credentials (`auth_kv`) only — chat DB and media files are untouched.
  The sole exceptions are the explicitly-destructive functions in
  `src/persistence/storageActions.ts` (all suffixed `Destructive`), called only
  from the Storage screen behind a confirm modal.
- Person identity is the **`accounts` table** (surrogate integer id, in
  `src/persistence/peerStore.ts` — distinct from `accounts.ts`, the app-login
  store); `account_jids` maps every address (`…@s.whatsapp.net`, `…@lid`) onto
  one account row. Individual chats are keyed by `peer_account_id`, so both
  address spaces reach the same chat with no folding; `chats.jid` holds the
  preferred (phone-first) jid. All names (push/contact/verified) live on the
  account row; display labels are derived at load time, never stored
  per-message or per-participant — the store must never write name fields
  from loaded aggregates (they contain resolved labels).
- **One DB per account**, WAL mode. Media lives flat on the filesystem under
  `<accountDir>/media/`; the DB stores only `MediaRef` JSON.
- **Lurk-friendly:** `markOnlineOnConnect: false` — we never broadcast presence
  or read state.
- `layoutLines` in `src/ui/components/MessageItem.tsx` is the single source of
  truth for row counts — render and scroll math must never drift from it.

## Data layout

```
<dataDir>/
  accounts/
    <accountId>/          ← raw JID, e.g. 5491100000000@s.whatsapp.net
      chats.db
      media/              ← flat; filenames: yyyy_MM_dd_HH_mm_ss_SSS__<id-suffix>.<ext>
      queue/
        tmp/              ← in-flight job writes (wiped at startup)
        pending/          ← durable jobs: <seq>-<type>.json (events), media-*/enc-edit-*/… (derived)
        failed/           ← jobs parked after exhausting retries (inspectable/replayable)
      app.lock            ← single-instance lock { pid, startedAt }; stale-pid takeover
    .pending-<ts>/        ← auth dir during "Link new device"
  whatsapp-terminal.log
  sync-queue.log          ← queue processor log incl. payloads (100 MB cap, .1 generation)
```

`dataDir` resolves as (in priority order):

1. `$WHATSAPP_TERMINAL_DATA_DIR` (env override)
2. `$XDG_DATA_HOME/whatsapp-terminal` → `~/.local/share/whatsapp-terminal` (Linux)
3. `~/Library/Application Support/whatsapp-terminal` (macOS)
4. `%LOCALAPPDATA%\whatsapp-terminal\Data` (Windows)

## Commit policy

Every prompt that modifies files produces exactly one commit — committed
immediately after the changes, before the next prompt. No batching across
prompts. No `Co-Authored-By` line in commit messages.

## README policy

Any user-facing feature change (new behavior, keybinding, screen, config,
data location) must update `README.md` in the same change. If unsure whether
or how the README should change, ask before finishing.

## Gotchas

- `syncFullHistory: true` is required for history sync; without it Baileys
  short-circuits and never processes the full message list. **Additionally**,
  Baileys rc13's default `shouldSyncHistoryMessage` discards `syncType=FULL`
  chunks — the socket config overrides it to `() => true` so deep history is
  processed. Don't remove either flag.
- WhatsApp acks every message **before** the app sees it (hardcoded in
  Baileys); a message lost in memory after the event handler fires is gone
  forever. That's why connection listeners must do nothing but journal the
  payload into the job queue — any logic belongs in an idempotent job handler.
- Job handlers see **JSON-round-tripped** Baileys payloads: protobuf `Long`
  timestamps arrive as strings, bytes as Buffers (BufferJSON). Always go
  through `timestampToMillis` for timestamps.
- WhatsApp 405s stale WA Web versions — always call `fetchLatestBaileysVersion()`
  before creating the socket.
- Message ids are only unique **per sender** (not globally unique per chat).
- Media is rendered as a plain-text `file://` URL pointing at a short symlink under
  `<os.tmpdir()>/wt/` (`src/ui/util/tmpMediaLink.ts`), created lazily from
  `layoutLines` as messages scroll into view. The link path is a pure function of
  the media path (md5 suffix), so row-count math never depends on the fs side effect.

## Debugging

When troubleshooting, always query the live database with real data rather than
reasoning from code alone. `sqlite3` is not installed; use `bun` instead:

```
bun -e "
const { Database } = await import('bun:sqlite');
const db = new Database('/home/USERNAME/.local/share/whatsapp-terminal/accounts/<accountId>/chats.db', { readonly: true });
console.log(db.query('SELECT ...').all());
"
```

Account dirs are under `~/.local/share/whatsapp-terminal/accounts/`. Always
inspect actual rows (accounts, account_jids, chats, messages, participants)
before concluding what the data does or doesn't contain.

The `events` table records every Baileys event that was ingested — query it to
see what actually arrived from WhatsApp vs. what the code expected:

```
db.query("SELECT event_type, payload FROM events ORDER BY rowid DESC LIMIT 20").all()
```

Also read the log file for runtime errors and warnings:

```
cat ~/.local/share/whatsapp-terminal/whatsapp-terminal.log | tail -100
```

The sync queue has its own log with full job payloads — the first place to look
when a message or media seems lost (`enqueued` → `started` → `completed` /
`failed` / `parked` per job), plus the on-disk queue itself:

```
tail -100 ~/.local/share/whatsapp-terminal/sync-queue.log
ls ~/.local/share/whatsapp-terminal/accounts/<accountId>/queue/{pending,failed}
```
