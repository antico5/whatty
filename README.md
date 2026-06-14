# whatty

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

## Where data is stored

Everything lives under the platform data directory — `~/.local/share/whatty`
on Linux (honouring `$XDG_DATA_HOME`), `~/Library/Application Support/whatty`
on macOS, `%LOCALAPPDATA%\whatty\Data` on Windows — overridable with the
`WHATTY_DATA_DIR` environment variable:

| Path | Contents |
| --- | --- |
| `accounts/<id>/chats.db` | SQLite database for one account: chats, messages, reactions, group membership, the people directory (`accounts` + `account_jids` tables — every person's addresses and names), and the Baileys session credentials |
| `accounts/<id>/media/` | Downloaded media (images, video, audio, documents, stickers, view-once) |
| `accounts/<id>/queue/` | Durable sync queue: every WhatsApp event is journaled to `pending/` before processing and removed once applied, so a crash never loses data — leftover jobs simply resume on the next start. Jobs that keep failing are parked in `failed/` for inspection |
| `accounts/<id>/app.lock` | Single-instance lock (see below) |
| `whatty.log` | Application log (structured JSON via pino — set `WHATTY_LOG_LEVEL` to adjust verbosity, e.g. `debug`) |
| `sync-queue.log` | Sync-queue processor log: every job lifecycle including payloads (capped at 100 MB, one rotated generation kept as `.1`) |


**Nothing is ever deleted.** Sync with your phone is purely additive: it can update or
extend local records, but a chat or message that exists locally is never removed — even if
it's deleted on the phone. Single-message deletions are reflected as a "deleted" marker
while the original content is retained locally. "Removing" an account from the selector only
deletes its credentials (`auth/`); chat history and media are never touched.


## Media download

Media attached to messages is downloaded **eagerly** for messages received within the
**last 7 days** — these land in the background shortly after the message arrives. Older
messages (e.g. from a fresh history sync on a newly linked device) aren't fetched up
front; their entry in the chat view shows a `[type — not downloaded]` hint instead of a
file path.

**Scrolling such a message into view downloads its media on demand**, regardless of age.
The fetch runs in the background and the entry switches from the hint to a file link when
it lands — no key to press. A download that failed for a transient reason (offline, a
network blip) retries when you scroll back to it.

If WhatsApp's servers no longer have the media — the blob was evicted from the CDN (HTTP
410) or the URL is rejected (HTTP 403) — it can't be recovered, so the entry switches to
a `[type — unavailable]` hint and the app stops retrying it (re-scrolling won't re-attempt
a dead URL).

Downloaded media is shown as a plain-text `file://` URL pointing at a short symlink
(`<tmpdir>/wt/<hash>.<ext>`, e.g. `/tmp/wt/ab12cd34.jpg`) so the line stays compact —
most terminals let you open or copy it directly. Symlinks are created on the fly as
messages scroll into view; the temp directory is volatile (cleared on reboot), but links
are recreated automatically the next time the message is displayed.

Downloads survive restarts: an interrupted or failed download is retried (with backoff)
from the durable queue, and on every start the app sweeps recent messages with missing
media and re-fetches them.

**Re-fetchability caveat:** WhatsApp media URLs expire within roughly the same 7-day
window. An on-demand fetch of much older media can still fail server-side if the URL has
expired and the original sender's device is unreachable for a re-upload — in that case
the entry keeps showing the "not downloaded" hint. The eager window stays small to avoid
pulling years of media up front; on-demand fetching only pays the cost for what you
actually look at.
