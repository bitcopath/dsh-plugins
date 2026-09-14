# dsh-client-ui-hawk-hq

An out-of-tree [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) plugin that
puts the machine into the UI: a live **GPU tracker** in the sidebar, the running **harness
version** next to it, three extra **settings pages**, and a **prompt-template dropdown** in
the composer.

Six surfaces, one host half:

| # | Surface | Registered as | Survives `npm i -g` |
|---|---|---|---|
| 1 | Sidebar foot **GPU mini panel** | `sidebar.footer.action` (id `hawk-gpu-sidebar`) | yes |
| 2 | **DSH version badge** | `sidebar.version` (id `hawk-dsh-version`) | **needs the seat patch** — see below |
| 3 | Settings → **GPU Watchdog** | `settings.section` (id `hawk-gpu-watchdog`) | yes |
| 4 | Settings → **Notifications** | `settings.section` (id `hawk-notifications`) | yes |
| 5 | Settings → **HQ Dashboard** | `settings.section` (id `hawk-dashboard`) | yes |
| 6 | Composer **⚡ Skills…** | `conversation.input.left` (id `hawk-composer-skills`) | yes |

Plus two shell CSS overrides (user speech bubbles span the full chat width, and the
sidebar-head spacing is tightened) — see "Fragile by nature" below.

![The GPU mini panel](../../docs/images/gpu-tracker.png)

*Sidebar foot: junction temperature, the workload holding the card, the guardian rung, VRAM / utilisation / board power.*

![The composer Skills button](../../docs/images/composer-skills-button.png)

*Composer ⚡ Skills… — pick a template, its text lands in the draft.*

## Host routes

Everything is served under `/plugin/hawk-hq`. No route calls a paid API; every byte comes
from `rocm-smi`, `/proc`, a local log/JSONL/SQLite file, or the public npm registry.

| Route | Source | Notes |
|---|---|---|
| `GET /plugin/hawk-hq/gpu` | one `rocm-smi --json` sample + guardian log tail | sample cached 2 s |
| `GET /plugin/hawk-hq/gpu/events` | the same payload as SSE | one state event / 5 s |
| `GET /plugin/hawk-hq/notifications` | tail of the notifications JSONL | last 200 rows |
| `GET /plugin/hawk-hq/notifications/events` | SSE, live appends | |
| `GET /plugin/hawk-hq/stats` | the stats SQLite DB, read-only through `python3` | balances, quotas, 14-day tokens, 30-day spend/top-ups |
| `GET /plugin/hawk-hq/version` | the running harness version + the newest published | 30 min cache, stale-while-revalidate |

## The GPU panel, in detail

- **Sample**: `rocm-smi --showtemp --showmeminfo vram --showuse --showpower --showmaxpower --json`,
  cached for 2 s (the card polls are not free, and the panel is fed by an SSE stream).
- **Who owns the card**: a `/proc` scan, priority-ordered `llama-server|llama-cli|llama-mtmd`
  (reporting the `--model` file name) → `ComfyUI` → `vLLM` → `Ollama`. Cached 3 s; no match
  means no label rather than a guess.
- **Heat tone** follows the guardian ladder: amber at ≥85 °C, red at ≥95 °C.
- **Collapsed rail** (56 px): a single heat dot; the numbers live in its tooltip.
- **AMD only.** It shells out to `rocm-smi`; on a machine without it the panel shows the
  error string, and the rest of the plugin is unaffected.

The **GPU Watchdog** page shows the same live sample plus the tail of a guardian log: the
last 50 non-empty lines, with the highest `rung=<n>` found. A missing log is reported as
`unavailable` — never as an empty-but-healthy card.

## Configuration

```ts
interface HawkHqConfig {
  guardianLog?: string        // default: $HOME/dsh-hq/logs/gpu-guardian.log
  notificationsFile?: string  // default: $HOME/.dsh/notifications.jsonl
  statsDb?: string            // default: $HOME/dsh-hq/stats.db
}
```

Every path is optional and every reader degrades: a missing log or JSONL renders as empty /
`unavailable`, and a missing stats DB surfaces as an error message on the Dashboard page.
Nothing is ever invented to fill a card.

## Install

```bash
pnpm install
pnpm build                       # tsdown → lib/index.js + lib/client.js
dsh plugin --profile web add link:$PWD
# then, once per harness install/upgrade:
scripts/apply-dsh-ui-fixes.sh
```

The package declares `dsh.bundle.patch: ./cordis.patch.yml`, so adding it appends the bundle
to the profile's layer stack and the row mounts on the next harness boot. Use a **hard
reload** in the browser: client bundles are served from disk with `no-cache`, and a plain
reload can still render the previous build.

## The sidebar seat — and why there is a patch

Upstream's sidebar shell declares `sidebar.brand.mark`, `sidebar.brand.name`,
`sidebar.workspaces`, `sidebar.settings` and `sidebar.footer.action`, and owns the **New
Session** button itself. There is **no seat** between the brand row and that button, and no
way for an out-of-tree plugin to add one. So `scripts/patch_sidebar_seat.py` adds exactly
two things to the installed `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`:

1. the `sidebar.version` declaration, and
2. one row rendered between the brand row and New Session that fills it.

The occupant (this plugin) stays out of tree. The patch:

- is **idempotent** — exits 0 when the seat is already there;
- **fails loudly** when an upstream anchor moved, so an upgrade can never be silently
  half-patched;
- **verifies** — `node --check` must parse the patched file before it is swapped in, and the
  previous file is restored if it does not;
- keeps a pristine copy at `client.js.bak-pre-version-seat` and reverts with `--revert`;
- takes an explicit bundle path, or resolves the bundle of the `dsh` on `PATH`:

```bash
scripts/patch_sidebar_seat.py                      # the install dsh points at
scripts/patch_sidebar_seat.py /path/to/client.js   # or an explicit bundle
scripts/patch_sidebar_seat.py --revert
```

> **It edits a third-party bundle inside your harness install. Read it before you run it.**
> If you would rather not patch anything upstream, skip it: the badge's row simply does not
> exist, so the badge cannot render — it disappears instead of lying. The other five surfaces
> are unaffected.

`scripts/apply-dsh-ui-fixes.sh` wraps the whole recovery in one command: resolve the install
`dsh` points at, bake its version into `src/client/dsh-build.ts`, re-apply the seat patch,
rebuild, and report what the server actually serves.

## The version badge

| Situation | Rendered |
|---|---|
| Running version is the newest published | the version, **green** |
| A newer version is published | `0.1.5-rc.1 → v0.1.5-rc.2`, the newer number **bold red** |
| Check pending, failed, or no registry answer | neutral grey + the reason in the tooltip — **never green** |

It prefers the host route (`/plugin/hawk-hq/version`), and when that is not live yet (the
route appears on the next harness boot after an upgrade) the browser reads the npm registry
directly — the registry serves CORS `*`, so the badge works without a restart. The tooltip
carries the install path, every published dist-tag, when the check ran, which source
answered, and the reapply command. In the collapsed 56 px rail the badge hides itself (the
rail carries icons only).

## HQ Dashboard

One card per provider (balance, token volume, last update), plus two hand-rolled SVG charts:
14-day token volume and a 30-day spend/top-up series. The spend series sums balance **drops**
between consecutive samples as spend and **rises** as top-ups — a plain first→last delta
would read a top-up day as negative spend. A single 10-minute step above **$200** is treated
as bad data and *counted* (`ignoredSamples`) rather than hidden, after a unit bug once wrote
−$1000 samples that would otherwise have drawn a fake $1000 bar.

**The collector that fills that database is not part of this repo.** Without it the page
shows an error card. See the schema in the [root README](../../README.md#stats-db-schema-hq-dashboard).

## Fragile by nature (and how we keep it honest)

| Override | Why it exists | Why it is fragile |
|---|---|---|
| user speech bubbles span the full chat width | upstream caps the user turn at `min(chat-width * .702, 82%)` | it targets a **CSS-module class hash** (`Sixlwa_` today, `gdEzaW_` before 0.1.5) because upstream hard-codes the value with no stable hook. It also sets the variable hook `--dsh-chat-user-width: 100%` where upstream offers one |
| sidebar-head spacing | the expanded brand row is 60 px with dead space under it | same class-hash problem (`hHd-Xa_logoRow`) |
| `!important` everywhere | the stylesheet is injected **before** the shell injects its own module CSS, so at equal specificity the shell always wins | deliberate, not laziness |

Every one of these is checked by `procedures/verify.sh` against the **served** bundle, so a
rename upstream fails loudly in a check instead of quietly in the UI.

## Layout

```
src/index.ts            host half: routes, rocm-smi//proc/stat reads, version check
src/wire.ts             host↔browser contract (type-only)
src/semver.ts           dependency-free version comparison, shared by both halves
src/client/index.ts     slot registrations
src/client/sidebar.ts   sidebar GPU mini panel      (sidebar.footer.action)
src/client/version.ts   version badge               (sidebar.version)
src/client/dashboard.ts HQ Dashboard                (settings.section)
src/client/gpu.ts       GPU Watchdog page           (settings.section)
src/client/notifications.ts notification inbox      (settings.section)
src/client/skills.ts    composer ⚡ Skills…          (conversation.input.left)
src/client/css.ts       shell CSS overrides
src/client/dsh-build.ts GENERATED — harness version at build time
scripts/                seat patch + the after-upgrade wrapper
```

## Development

```bash
pnpm build       # tsdown
pnpm typecheck   # tsc -p tsconfig.json
pnpm test        # node test/semver.test.mjs — imports the TypeScript source directly,
                 # which needs Node's built-in type stripping (22.6+ flagged, on by default from 23.6)
```

## License

MIT
