# whatsapp-terminal

A terminal UI WhatsApp client — like WhatsApp Web, but in your terminal. Built on
[Baileys](https://github.com/WhiskeySockets/Baileys) and [OpenTUI](https://github.com/sst/opentui)
(with React bindings).

## Prerequisites

- Linux terminal (full-screen, alternate-screen UI — think `vim`)
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- [Bun](https://bun.sh/) — the app runs on the Bun runtime (`pnpm start` / `pnpm dev` invoke `bun` under the hood)

## Getting started

```sh
pnpm install
pnpm start
```

`pnpm dev` runs the same entry point with file-watching (`bun --watch`) for development.

### First run (no linked accounts)

A QR code is printed to the terminal:

1. On your phone: **WhatsApp → Settings → Linked devices → Link a device**.
2. Scan the QR code shown in the terminal.

Once paired, the app transitions straight to the chat list.

### Subsequent runs (one or more linked accounts)

A boot-time account selector is shown. Use `↑`/`↓` to navigate and `Enter` to open an
account. The last entry is always **Link new device**, which starts a fresh QR pairing flow
and adds the new account to the list.

### Session expiry / unlinking

If a device is removed from your phone, the app detects the dead session and removes that
account from the selector. Chat history and media are kept on disk — if the same phone
re-links later via QR, the account reappears in the selector and resumes its previous history.

## Where data is stored

Everything lives under the platform data directory — `~/.local/share/whatsapp-terminal`
on Linux (honouring `$XDG_DATA_HOME`), `~/Library/Application Support/whatsapp-terminal`
on macOS, `%LOCALAPPDATA%\whatsapp-terminal\Data` on Windows — overridable with the
`WHATSAPP_TERMINAL_DATA_DIR` environment variable:

| Path | Contents |
| --- | --- |
| `accounts/<id>/chats.db` | SQLite database for one account: chats, messages, reactions, group membership, the people directory (`accounts` + `account_jids` tables — every person's addresses and names), and the Baileys session credentials |
| `accounts/<id>/media/` | Downloaded media (images, video, audio, documents, stickers, view-once) |
| `accounts/<id>/queue/` | Durable sync queue: every WhatsApp event is journaled to `pending/` before processing and removed once applied, so a crash never loses data — leftover jobs simply resume on the next start. Jobs that keep failing are parked in `failed/` for inspection |
| `accounts/<id>/app.lock` | Single-instance lock (see below) |
| `whatsapp-terminal.log` | Application log (structured JSON via pino — set `WHATSAPP_TERMINAL_LOG_LEVEL` to adjust verbosity, e.g. `debug`) |
| `sync-queue.log` | Sync-queue processor log: every job lifecycle including payloads (capped at 100 MB, one rotated generation kept as `.1`) |

`<id>` is the account's own normalized WhatsApp JID (e.g. `12025550100@s.whatsapp.net`).
Because chats are namespaced under their account, two accounts can have separate
conversations with the same contact without collision.

**One instance per account.** Opening an account that is already open in another running
instance fails back to the account selector (two instances would fight over the WhatsApp
session, disconnecting each other every few seconds). The lock clears itself: if the
holding process died (even `kill -9`), the next start takes the lock over automatically.

> **Breaking change:** databases created by earlier versions (schema v1) are
> incompatible with this build. There is no migration — the app refuses to start with an
> error until you delete the data directory and re-link your device (history is then
> re-synced from your phone).

**Nothing is ever deleted.** Sync with your phone is purely additive: it can update or
extend local records, but a chat or message that exists locally is never removed — even if
it's deleted on the phone. Single-message deletions are reflected as a "deleted" marker
while the original content is retained locally. "Removing" an account from the selector only
deletes its credentials (`auth/`); chat history and media are never touched.

## Keybindings

| Key | Account selector | Chat list | Chat view |
| --- | --- | --- | --- |
| `↑` / `↓` | Move selection | Move chat selection | Scroll message history |
| `Enter` | Open account / link new device | Open the selected chat | Send the draft message |
| `R` | — | Toggle read receipts on/off | — |
| `H` | — | Show / hide help | — |
| `Esc` | — | Back to account selection | Back to the chat list |
| `Ctrl+C` | Quit the app | Quit the app | Quit the app |
| _(typing)_ | — | — | Edits the draft input (navigation keys above still work) |

## History sync

Linking a device makes the phone upload its full message history, and the app now ingests
**all** of it — including the deep-history (`FULL`) chunks that earlier builds silently
discarded — so old conversations are browsable after a fresh link. Media older than the
auto-download window (below) is still listed but not fetched.

## Media auto-download

Media attached to messages is downloaded automatically — but only for messages received
within the **last 7 days**. Older messages (e.g. from a fresh history sync on a newly
linked device) are skipped; their entry in the chat view shows a `[type — not downloaded]`
hint instead of a file path.

Downloaded media is shown as a plain-text `file://` URL pointing at a short symlink
(`<tmpdir>/wt/<hash>.<ext>`, e.g. `/tmp/wt/ab12cd34.jpg`) so the line stays compact —
most terminals let you open or copy it directly. Symlinks are created on the fly as
messages scroll into view; the temp directory is volatile (cleared on reboot), but links
are recreated automatically the next time the message is displayed.

Messages always appear immediately; their media is fetched in the background and the view
updates when it lands. Downloads survive restarts: an interrupted or failed download is
retried (with backoff) from the durable queue, and on every start the app sweeps recent
messages with missing media and re-fetches them.

**Re-fetchability caveat:** WhatsApp media URLs expire within roughly the same 7-day window.
Messages skipped by the auto-download gate may be permanently unrecoverable, even if you
could trigger a manual download later — the server-side URL will likely have expired by the
time a fresh device link completes its history sync. This is by design: the cutoff exists
precisely to avoid pulling years of unreachable media.

## Business & interactive messages

Template, button and list messages sent by business accounts (the kind the phone renders
with tappable buttons) are shown as plain text: title, body and footer lines followed by
one `[label]` line per button — `[label: url]` for link buttons. The buttons themselves
aren't interactive. On startup the app re-examines stored messages that had no renderable
text and backfills them, so business chats that previously showed empty entries populate
retroactively.

## v1 scope & limitations

- **Outbound: text only.** Sending media, replies, and reactions isn't supported yet
  (incoming media, replies and reactions are still received, downloaded/stored, and shown).
- **No reactions rendering.** Reactions are received and stored but not displayed.
- **No unread tracking.** The app never computes, stores, or displays unread counts.
- **Read receipts off by default.** Opening a chat never notifies the sender (lurk-friendly).
  Press `R` on the chat list to toggle read receipts on or off; the preference is saved per
  account. Delivery/read ticks shown for *your* outbound messages still update live as the
  recipient's device reports them regardless of this setting.
- **No search/filter** in the chat list — just the full, sorted, scrollable list.

## Development

```sh
pnpm test        # vitest — core logic (persistence, reconciliation, mappers, stores, …)
pnpm test:watch  # vitest in watch mode
pnpm typecheck   # tsc --noEmit
```

UI screens are exercised manually (they depend on `@opentui/core`'s Bun-only renderer and
can't run under vitest/Node) — core logic and data-mapping have full automated coverage.
