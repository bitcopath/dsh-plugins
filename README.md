# dsh-plugins — the HQ layer we run on top of DeepSeek Harness

Out-of-tree plugins for [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)
(DeepSeek Harness) that we use every day on a single-GPU Linux workstation: a live
GPU tracker in the sidebar that also names what ComfyUI is holding in VRAM, a
harness version badge with an update check, three extra
settings pages, a prompt-template dropdown in the composer, and provider failover for
the agent loop.

Everything here is a **plugin occupant or a documented patch of an installed bundle** —
not a fork. That is the point: `npm i -g @deepseek-ai/dsh@…` replaces the whole package
directory, so anything hand-patched inside it dies on the next upgrade. We paid that
price once and rebuilt the features as plugins; only one of them still needs a patch,
and that patch now re-applies itself.

| Plugin | What it adds |
|---|---|
| `dsh-client-ui-hawk-hq` | Sidebar **GPU tracker** + a **ComfyUI panel** that names the models resident in VRAM, **DSH version badge**, three settings pages (**GPU Watchdog**, **Notifications**, **HQ Dashboard**), the composer **⚡ Skills…** dropdown |
| `dsh-llm-hawk-failover` | **Provider failover** for the agent loop: quarantine a dead route, walk an ordered chain to a backup |

![The GPU mini panel in the sidebar foot: junction temperature, the workload holding the card (ComfyUI), the guardian rung, VRAM, utilisation and board power](docs/images/gpu-tracker.png)

*GPU tracker, sidebar foot — one `rocm-smi` sample every 2 s plus a `/proc` scan that names the resident workload. The rung badge comes from an optional guardian log; with no log the panel still renders.*

![The sidebar foot while ComfyUI holds three models: the ComfyUI block above (version, queue state, one chip per resident model, VRAM) and the GPU readout below it](docs/images/comfyui-panel.png)

*ComfyUI block, stacked above the same GPU readout — engine version, queue state (`running 0/8`), one chip per model in VRAM with a colour per kind, the card's own VRAM view, and the node that is actually doing the work. It appears only while ComfyUI is up and something is resident; an idle engine shows nothing at all.*

![The composer row with the Skills dropdown button](docs/images/composer-skills-button.png)

*Composer **⚡ Skills…** — prompt templates inserted into the draft (`Name = prompt template`); stored in the browser, no server round-trip.*

## What each feature actually does

### Sidebar GPU tracker (`hawk-gpu-sidebar`)

Registered into the sidebar foot's `sidebar.footer.action` list seat, full-width, directly
above Settings. One `rocm-smi` sample is cached for 2 s; the panel is fed by the same SSE
stream as the settings page (one state event every 5 s).

- Wide mode: junction temperature, VRAM %, utilisation, board power, plus **who owns the
  card** — a `/proc` scan labelled in priority order `llama-server|llama-cli|llama-mtmd`
  (showing the `--model` file name) → `ComfyUI` → `vLLM` → `Ollama`; unknown = no label.
- Collapsed 56 px rail: a single heat dot with the numbers in its tooltip.
- Heat tone follows the guardian ladder: amber from 85 °C, red from 95 °C.
- **AMD only** — it shells out to `rocm-smi`. On a machine without it the panel shows the
  error string instead of numbers; nothing else in the plugin depends on it.

### ComfyUI panel (same seat, above the GPU readout)

A second block inside the same `sidebar.footer.action` occupant, so the two stack instead
of laying out side by side. It answers the question the GPU number cannot: **which models
are loaded, and what is running.**

- **It is invisible unless it has something to say** — ComfyUI must be up *and* a prompt
  must be executing *or* something must be genuinely resident. An idle engine leaves the
  sidebar exactly as it was; there is no empty card.
- **What it shows**: engine version, queue state (`running +N` when prompts wait behind it,
  with sampling progress such as `4/8`), one **chip per resident model** coloured by kind
  (video / image / audio / text encoder / VAE), the card's VRAM as ComfyUI sees it, and the
  node class that defines the job (`SamplerCustomAdvanced`, not `UnetLoaderGGUF` — the
  loader stays in the tooltip).
- **How it knows what is loaded**: ComfyUI has no "what is resident" endpoint, so the host
  half tails its newest stdout log for `Requested to load <class>` lines and maps the loader
  classes to friendly names. The list is **emptied whenever the card holds almost no
  memory**, so a stale log line can never claim a model is resident.
- **The discrete card, not the iGPU**: ComfyUI lists every device it can see, and an
  integrated GPU's shared pool can report a *larger* total than the discrete card (we
  measured 33.5 GB iGPU vs 25.8 GB dGPU on one machine), so "pick the biggest pool" showed
  the wrong card's numbers. Integrated parts are filtered out by name first.
- ComfyUI is optional: with nothing listening on the port the block reports `up: false` and
  renders nothing; the GPU panel next to it is unaffected.

### Settings pages (`settings.section` occupants)

| Page | Reads | Behaviour when the source is missing |
|---|---|---|
| **GPU Watchdog** | `rocm-smi` + the tail of a guardian log (ladder rungs) | log missing → `unavailable`, GPU numbers still render |
| **Notifications** | `~/.dsh/notifications.jsonl` (the harness notification queue), last 200, SSE for live appends | file missing → empty inbox |
| **HQ Dashboard** | a local SQLite stats DB: per-provider balance, quota, 14-day token chart, 30-day spend/top-up chart | DB missing → an error card on the page, never fabricated numbers |

The dashboard chart is hand-rolled SVG (no chart library). Balances are read through
`python3 -c` + `sqlite3` in read-only mode, so the plugin needs no SQLite npm dependency.

### DSH version badge (`sidebar.version`)

Between the brand row and **New Session**, always visible: the running harness version in
green when it is the newest published release, or `0.1.5-rc.1 → v0.1.5-rc.2` with the newer
number in bold red. Grey with a reason in the tooltip when the check is pending or failed —
**never green on a failed check**. It reads the plugin's host route
(`GET /plugin/hawk-hq/version`, 30-minute cache, stale-while-revalidate) and falls back to
reading the npm registry straight from the browser, which is why it works without a restart.

### Composer ⚡ Skills… (`conversation.input.left`)

A prompt-template dropdown in the composer: pick a template, and its text is inserted into
the draft. A `Name = prompt template` editor manages them; they live in `localStorage`
under `dsh.composer.skills`. The four seeds are examples — replace them with your own.

### Provider failover (`dsh-llm-hawk-failover`)

When the primary model route fails with a transport-class error, the route is quarantined
for a cooldown and the session fails over to the next healthy entry of an ordered chain.
Fail-open, in-memory, and it deliberately never fires on auth/quota/context errors. See
[`plugins/dsh-llm-hawk-failover/README.md`](plugins/dsh-llm-hawk-failover/README.md).

## A note on the names

`hawk-hq` / `hawk-failover` are the plugin ids and package names we ship under; "Hawk" is
the name our own agent runs as. Nothing in the code depends on that — the ids are just
strings, and the paths that were rig-specific (log file, stats DB, notification file) are
configuration with `$HOME`-relative defaults.

## Requirements

- Linux, **Node 20+** (we run Node 24.14.1)
- **`python3`** with the stdlib `sqlite3` module (used by the HQ Dashboard route)
- **`rocm-smi`** for the GPU surfaces (AMD); everything else works without it
- **ComfyUI** is optional, for the ComfyUI panel only: its HTTP API (default
  `http://127.0.0.1:8188`) and a stdout log directory. With neither, the panel stays
  hidden and nothing else changes.
- Client-side plugins also need a `dsh` whose browser half declares the seats listed above
  — we test against **`@deepseek-ai/dsh` 0.1.5-rc.1** (and 0.1.1-rc.2 before it)

No API keys, no paid service: every route reads `rocm-smi`, `/proc`, ComfyUI on localhost, a
local file, the local SQLite DB, or the public npm registry.

## Install

```bash
git clone https://github.com/bitcopath/dsh-plugins ~/dsh-plugins
cd ~/dsh-plugins/plugins/dsh-client-ui-hawk-hq && pnpm install && pnpm build
cd ../dsh-llm-hawk-failover                 && pnpm install && pnpm build

# register both as profile bundles (one `link:` row each)
dsh plugin --profile web add link:$HOME/dsh-plugins/plugins/dsh-client-ui-hawk-hq
dsh plugin --profile web add link:$HOME/dsh-plugins/plugins/dsh-llm-hawk-failover
dsh plugin --profile web install
```

Both packages declare `dsh.bundle.patch`, so adding them appends their bundle to the
profile's layer stack and the rows mount on the next harness boot. A newly added plugin row
is only visible to a **new** session/process — restart the web service (we run ours as a
systemd user unit) and reload the browser.

Finally, add the sidebar seat that carries the version badge:

```bash
~/dsh-plugins/plugins/dsh-client-ui-hawk-hq/scripts/apply-dsh-ui-fixes.sh
```

It resolves the install `dsh` on `PATH` points at, bakes its version into the browser half,
re-applies the seat patch, rebuilds, and (when the server is reachable) checks the bytes it
actually serves.

## The one thing we still patch inside upstream

The sidebar shell declares `sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.workspaces`,
`sidebar.settings` and `sidebar.footer.action` — and owns the **New Session** button itself.
There is no seat between the brand row and that button, and no way for an out-of-tree plugin
to add one, so `plugins/dsh-client-ui-hawk-hq/scripts/patch_sidebar_seat.py` adds two things
to the installed `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js`: the `sidebar.version`
declaration, and one row that fills it.

The patch is idempotent, refuses to leave a half-patched file (it proves the result parses
with `node --check` before swapping it in, and restores the backup if it does not), keeps a
pristine copy at `client.js.bak-pre-version-seat`, and reverts with `--revert`. It also fails
loudly when an upstream anchor moves, so an upgrade can never silently half-patch the shell.

> **Read the script before you run it.** It edits a third-party bundle inside your harness
> install. Your alternative is to skip it — everything except the version badge works
> without it (the badge's occupant simply has no seat to render into, and disappears rather
> than lying).

## Surviving harness upgrades

An install wipes the seat patch. That is why the repo ships the procedure, not just the code:

| File | What it does |
|---|---|
| `procedures/upgrade.sh <version>` | installs a harness version, re-applies the patches, rebuilds the plugin, verifies — **restart off by default**, because that service serves the page you are talking through |
| `procedures/verify.sh` | proves what the **server actually serves**: the seat and the badge in the served client bundle, every registered slot id, the service state, and whether the fragile CSS targets still exist upstream |
| `docs/UPGRADE.md` | what an upgrade breaks, in order, and how the procedure puts it back |

```bash
~/dsh-plugins/procedures/upgrade.sh 0.1.5-rc.1            # install + patch + verify
~/dsh-plugins/procedures/upgrade.sh 0.1.5-rc.1 --restart  # the same, then restart the web unit
```

## Configuration

The host half takes five optional settings (`HawkHqConfig` in `src/index.ts`); our own
profile patch sets none of them and relies on the defaults:

| Key | Default |
|---|---|
| `guardianLog` | `$HOME/dsh-hq/logs/gpu-guardian.log` |
| `notificationsFile` | `$HOME/.dsh/notifications.jsonl` |
| `statsDb` | `$HOME/dsh-hq/stats.db` |
| `comfyUrl` | `http://127.0.0.1:8188` |
| `comfyLogDir` | `$HOME/comfyui/logs` (the newest `comfyui*.log` in it is tailed) |

Pass them in the registration/config row if you keep those files elsewhere, or just leave
them: a missing file is reported as missing, never as data. The ComfyUI panel needs both
ComfyUI keys to be right — point `comfyLogDir` at wherever your ComfyUI stdout log lands, or
the panel will show the queue and VRAM but no model chips.

### Stats DB schema (HQ Dashboard)

The dashboard reads two tables in read-only mode:

```sql
api_endpoint_stats(provider, balance_usd, balance_currency, tokens_in, tokens_out,
                   period, note, recorded_at, cost_usd)
provider_quota(provider, quota_name, display_name, utilization, balance_usd,
               resets_at, status, recorded_at)     -- optional; absent = no quota rows
```

The spend series sums balance *drops* between consecutive samples as spend and *rises* as
top-ups (a plain first→last delta would read a top-up day as negative spend). A single
10-minute step above **$200** is treated as bad data and counted separately rather than
hidden — that guard exists because a unit bug once wrote −$1000 samples, which would have
drawn a fake $1000 bar. **The collector that fills this DB is not published here**; without
it the page shows an error card.

## What is deliberately not in this repo

- the stats collector and the GPU guardian/watchdog scripts behind the log format
- our MCP servers (BookStack, Gmail, AI council, cron, notifications, session index)
- our agent skills, prompts, and machine configuration
- any credential, hostname or LAN address — the sanitized copy in this repo has none

## Compatibility, honestly

Upstream renames things between releases: 0.1.5 moved all client code into one combo bundle,
moved the user turn into a new package, and renamed its CSS-module prefix (`gdEzaW_` →
`Sixlwa_`), which silently killed one of our overrides until we re-pointed it. So:

- the **slot ids** we register are stable upstream API; a rename silences a surface with no
  error anywhere — `procedures/verify.sh` checks all six ids by name, for exactly that reason;
- the **CSS overrides** (`userStack`/`userRow` width, sidebar-head spacing) are hash-fragile
  by nature — upstream hard-codes the values with no stable hook, so there is no other way;
  `verify.sh` fails loudly if their targets vanish;
- the GPU panel assumes **AMD** (`rocm-smi`) and Linux (`/proc`).
- the ComfyUI panel assumes **ComfyUI's own log wording** (`Requested to load <class>`) and
  its `/system_stats` + `/queue` shapes. Both have been stable for a long time, but an
  upstream change would show up as missing model chips rather than an error — the queue,
  version and VRAM parts would keep working.

## License

MIT — see [LICENSE](LICENSE).
