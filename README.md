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

Everything lives under a `data/` directory created alongside wherever you run the app
(override the location with the `WHATSAPP_TERMINAL_DATA_DIR` environment variable):

| Path | Contents |
| --- | --- |
| `data/accounts/<id>/auth/` | Baileys session credentials for one account |
| `data/accounts/<id>/chats/<jid>/chats.json` | Full record for one chat: metadata, messages, delivery/deleted state |
| `data/accounts/<id>/chats/<jid>/media/` | Downloaded media (images, video, audio, documents, stickers, view-once) |
| `data/whatsapp-terminal.log` | Application log (structured JSON via pino — set `WHATSAPP_TERMINAL_LOG_LEVEL` to adjust verbosity, e.g. `debug`) |

`<id>` is the account's own normalized WhatsApp JID (e.g. `12025550100@s.whatsapp.net`).
`<jid>` is the chat's WhatsApp ID — a phone number for 1:1 chats or a group ID
(e.g. `120363000000000001@g.us`). Because chats are namespaced under their account, two
accounts can have separate conversations with the same contact without collision.

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
| `Esc` | — | — | Back to the chat list |
| `Ctrl+C` | Quit the app | Quit the app | Quit the app |
| _(typing)_ | — | — | Edits the draft input (navigation keys above still work) |

## v1 scope & limitations

- **Outbound: text only.** Sending media, replies, and reactions isn't supported yet
  (incoming media, replies and reactions are still received, downloaded/stored, and shown).
- **No reactions rendering.** Reactions are received and stored but not displayed.
- **No unread tracking.** The app never computes, stores, or displays unread counts.
- **No read receipts sent.** Opening a chat never notifies the sender (lurk-friendly) —
  delivery/read ticks shown for *your* outbound messages still update live as the recipient's
  device reports them.
- **No search/filter** in the chat list — just the full, sorted, scrollable list.

## Development

```sh
pnpm test        # vitest — core logic (persistence, reconciliation, mappers, stores, …)
pnpm test:watch  # vitest in watch mode
pnpm typecheck   # tsc --noEmit
```

UI screens are exercised manually (they depend on `@opentui/core`'s Bun-only renderer and
can't run under vitest/Node) — core logic and data-mapping have full automated coverage.
