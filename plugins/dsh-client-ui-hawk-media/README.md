# dsh-client-ui-hawk-media

A DeepSeek Harness plugin that makes **video, audio and images play inside the chat** — with the
file reference as a clickable caption under the player.

Part of [`dsh-plugins`](../../README.md). Out-of-tree: nothing here patches or forks the harness.

## What it adds

### 1. In-chat player (`src/client/chat-video.js`)

Any message that names a media file — an absolute path written as inline code, a markdown link, or
a bare `http(s)` URL — gets a **native player right under that line**: controls, scrubber, volume,
fullscreen, download. Pressing play happens without leaving the conversation.

It also enhances history that is **already on screen**, not only new messages, and one reference
yields exactly **one** player: the line that carried the reference is hidden, and the player's
caption becomes the blue clickable reference instead. Prose around a reference is never touched.

### 2. Images get the same frame and the same caption

The scan, the frame and the caption are shared; an image simply has no transport, so it renders an
`<img>` in the same box. The core renderer already draws an image from an absolute path but gives it
**no label at all** — the reader cannot tell which file is on screen. That caption is the point of
this arm, and it also means an agent no longer has to copy a picture somewhere else just to show it.

| Arm | Extensions | Element |
|---|---|---|
| video | `mp4` `m4v` `webm` `mov` `mkv` `ogv` `mpg` `mpeg` `avi` | `<video controls>` |
| audio | `mp3` `m4a` `wav` `oga` `ogg` `opus` `flac` `aac` | `<audio controls>` |
| image | `png` `jpg` `jpeg` `webp` `gif` `avif` `bmp` | `<img>` |

A badge under the player names the byte source (`streamed` / `api/file` / `url`) plus size and
duration (or pixel dimensions for an image), and a failure is reported as a sentence rather than a
black box. The player is **invisible unless a media reference is present**.

### 3. The streaming route (`src/host.js`)

```
HEAD /api/hawk-media?path=<absolute path>   -> 200 + content-length / content-type, or 4xx
GET  /api/hawk-media?path=<absolute path>   -> 200 streamed (accept-ranges: bytes)
GET  /api/hawk-media?path=<absolute path>   -> 206 partial when `Range: bytes=…` is present
```

## Why the route has to exist

The chat's built-in inline-image mechanism resolves an absolute path to `GET /api/file?path=…`,
registered with `maxBytes = maxImageBytes`, which resolves to
`DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024`. That handler buffers the whole file and returns one
`Response`, and has **no `Range` support at all** — so a file over 20 MiB is a 413, and even an
allowed file cannot be seeked and is fully in memory before the first frame.

Real rendered clips run 4–90 MB, so the only route media had was the one route media could not use.

The plugin's own route streams from disk in chunks, answers `Range` with `206` and
`content-range`, answers `HEAD`, and enforces: an allowlisted media extension, an absolute path, no
NUL bytes, the same connection authorization the built-in `/api` routes apply, and a 2 GiB ceiling
so one absurd file cannot be pulled in a loop. It is **not** a general file-disclosure route.

## Why it is a DOM enhancer, not a slot occupant

The slots that render inline images (`conversation.message.images` and friends) are **single** slots
that already ship occupied — the slot catalog marks them `replaceRisk: "shadows-shipped-ui"`.
Registering there to add video would **replace** the shipped inline image gallery rather than sit
beside it, for no upside. The additive, tag-and-class-free DOM hook breaks no slot contract, and it
gets already-rendered history for free.

## Requirements

- Linux, **Node 20+** (tested on Node 24.14.1)
- `@deepseek-ai/dsh` **0.1.5-rc.1** (developed against it)
- No API keys, no network service, no database. The host half reads local files; the browser half
  uses the platform module table.

## Install

```bash
git clone https://github.com/bitcopath/dsh-plugins ~/dsh-plugins
cd ~/dsh-plugins/plugins/dsh-client-ui-hawk-media && pnpm install && pnpm build

dsh plugin --profile web add link:$HOME/dsh-plugins/plugins/dsh-client-ui-hawk-media
dsh plugin --profile web install
```

The package declares `dsh.bundle.patch`, so adding it appends this bundle to the profile's layer
stack and the row mounts on the next boot.

**Two kinds of change, two kinds of reload** — this matters and it is easy to get wrong:

| Change | What it needs |
|---|---|
| browser half only (`src/client/*`) | the combined `/plugins/??…` bundle is generated at **server start**, so a rebuilt client half needs a **`dsh web` restart** — a page refresh alone will not pick it up |
| host half (`src/host.js`, the route) | a `dsh web` restart, because the route is registered by the running server process |

Without the restart the browser half degrades to `/api/file` and still plays clips under 20 MiB.

## What it does not do

- **No Sidebar preview.** An earlier revision registered a `documentPreviews` type plus a
  `sidebar.right.tab.document` occupant, so media opened from the Files tab played in the right
  pane. The chat is the delivery path now, a second route to the same bytes is a second thing to
  keep working, and that pane was removed, slot and all.
- **It is an enhancement over markup it does not own.** A shell markup change can stop it finding
  references. The failure mode is deliberately *nothing appears* — never a broken or hidden message.
  A block that holds one of our players is never hidden, and the guard walks the ancestry rather
  than trusting an attribute selector.
- **The scan is coalesced per animation frame**, so it does nothing in a background tab. Bring the
  tab to the front before judging it from the DOM.
- **One workstation's plugin, not an upstream feature.** It adds what we wanted to our own harness.

## Tests

```bash
npm test        # node --test test/*.test.mjs — 43 assertions
npm run build   # tsdown: lib/index.js (ESM, node) + lib/client.js (browser factory)
```

`test/chat-video.test.mjs` runs the enhancer against a small fake DOM and asserts the rules that
were each paid for by a real bug: the consumed reference is hidden while **prose is never hidden**, a
reference-only block is hidden, a block that holds our own player is **not**, the caption shows the
authored path for a path and the URL for a URL, the scanner cannot re-scan its own caption into a
second player, and the image arm keeps its frame visible. `test/bundle-smoke.test.mjs` loads the
**built** bundle through a fake module loader and asserts that a message naming an `.mp4` produces a
playable `<video>`.

## A note on the names

`hawk-media` is the cordis plugin id; "Hawk" is the name our own agent runs as. Nothing in the code
depends on it. Comments are written for the next maintainer — including the two bugs the tests were
written for, because they are the reason those tests exist.
