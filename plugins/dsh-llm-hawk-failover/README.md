# dsh-llm-hawk-failover

An out-of-tree [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) function
plugin: **provider failover for the agent loop**. When the primary model route fails with a
transport-class error, that route is quarantined for a cooldown and the session fails over to
the next healthy entry of a configured ordered chain.

The chain this was built for: **a local model (llama.cpp on the workstation GPU) → a cloud
provider**. If the local box is busy, swapping, or off, the turn continues in the cloud
instead of dying.

## Architecture: two waterfalls

`ctx.llm.stream()` is single-attempt; recovery lives on the agent loop's closed-step waterfall
events (`@deepseek-ai/dsh-agent` runtime-types):

1. **`agent/request-error`** (prepend) — one failed attempt surfaced. If `failure.code` is
   failover-class (default `TRANSPORT`, `SERVER`, `TIMEOUT`), the serving provider is marked
   quarantined until `now + cooldownMs` and the handler returns `{ kind: 'retry' }` **without
   calling `next()`**. The error handler cannot change the route directly — the retry makes
   the loop re-run the `agent/request` waterfall, which is where the surface change happens.
   Any other code delegates via `return next()`: `dsh-llm-retry` owns same-route transient
   retries (`RATE_LIMIT`, `EMPTY_RESPONSE`), compaction owns `CONTEXT_WINDOW_EXCEEDED`.
   Failover never triggers on `AUTH`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`,
   `QUOTA_EXCEEDED`, or `CONTEXT_WINDOW_EXCEEDED`.

2. **`agent/request`** (prepend) — `const config = await next()` yields the config the machine
   would use. If its provider is quarantined, the chain is walked to the first
   non-quarantined entry and the config is returned with `provider`/`model` swapped and
   **`reasoningEffort` stripped** — the target route resolves its own default; an unsupported
   explicit effort fails with `UNSUPPORTED_REASONING_EFFORT` before any I/O. If no standby is
   available the config passes through unchanged (and `agent/request-error` delegates, so
   `dsh-llm-retry`'s same-route backoff still applies).

Both listeners are registered on the root context with `prepend=true` so they run before
same-route recovery, and they receive every agent (agent-scoped dispatch). Subagent sessions
(`agent.session.header.origin === 'subagent'`) are skipped — their routes are chosen by the
delegating agent, not by this chain. Everything is **fail-open**: an internal error logs a
warning and delegates / passes the config through.

Quarantine state is an in-memory `Map` keyed by provider: a DSH restart re-tries the primary
first, which is exactly the desired behavior.

Failover events are logged through `ctx.logger`, e.g.:

```
hawk-failover: local-qwen/qwen3.8-27b quarantined 120s (TRANSPORT) → deepseek-official/deepseek-v4-pro
```

## Configuration

Settings namespace = cordis plugin id = `hawk-failover` (a section of `~/.dsh/settings.yaml`,
served by `dsh-settings-file`; a dsh-web reload always picks it up):

```yaml
hawk-failover:
  enabled: true
  chain:
    - { provider: local-qwen, model: qwen3.8-27b }
    - { provider: deepseek-official, model: deepseek-v4-pro }
  failoverCodes: [TRANSPORT, SERVER, TIMEOUT]
  cooldownMs: 120000
```

- `chain` — ordered standby routes, primary first. **Provider keys are route names, not
  settings namespaces**: the DeepSeek adapter (`@deepseek-ai/dsh-llm-deepseek`, settings
  namespace `llm-deepseek`) registers the route **`deepseek-official`**, while a local
  OpenAI-compatible endpoint is typically an `llm-pi-ai` provider profile. Check yours with
  `dsh --profile web --dump-config`.
- `failoverCodes` — default `[TRANSPORT, SERVER, TIMEOUT]`.
- `cooldownMs` — default `120000`.
- Invalid entries are dropped with a warning; garbage config falls back to defaults and never
  throws. With no `hawk-failover:` section the plugin is inert (logs a warning, registers
  nothing).

## Registration

The plugin is a profile **bundle**: its `package.json` declares
`dsh.bundle.patch: ./cordis.patch.yml`, whose insert row mounts the plugin:

```yaml
- insert:
    - id: hawk-failover
      name: "dsh-llm-hawk-failover"
```

Either run (from anywhere; forwards to pnpm in the profile dir and appends the bundle to
`dsh.profile.bundles`):

```bash
dsh plugin --profile web add link:$HOME/dsh-plugins/plugins/dsh-llm-hawk-failover
```

or edit the profile's `package.json` by hand — add the dependency and the bundle entry, then
install:

```json
{
  "dependencies": {
    "dsh-llm-hawk-failover": "link:/absolute/path/to/dsh-plugins/plugins/dsh-llm-hawk-failover"
  },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-client-ui-hawk-hq",
    "dsh-llm-hawk-failover"
  ] } }
}
```

```bash
dsh plugin --profile web install
```

Then add the `hawk-failover:` settings section above and reload dsh-web. Verify composition
without booting:

```bash
dsh --profile web --dump-config | grep -A2 hawk-failover
```

## Development

```bash
pnpm install
pnpm build       # tsdown → lib/index.js (the profile link serves it)
pnpm typecheck   # tsc -p tsconfig.json
pnpm test        # node test/run.mjs — drives both waterfall handlers against lib/, so build first
```

## Limitations

- **Mid-step, not mid-stream** — failover happens at the agent-loop retry boundary: the failed
  turn closes and a fresh turn re-requests on the backup route. Partial output of the failed
  attempt is discarded (never durable).
- **Cross-provider = re-billed prefix** — the reconstructed request on the backup provider
  repeats the full input; input tokens are billed again under that provider's rules (context
  caching still applies where the provider has it).
- **Provider-level quarantine** — the `agent/request-error` payload carries the provider but
  not the model, and failover-class failures are transport-scoped, so quarantine is keyed by
  provider (all its models).
- **In-memory state** — a DSH restart clears quarantines and re-tries the primary first
  (desired); there is no persisted health history.
- **Chain to capable targets only** — every chain entry must accept the session's content. If
  conversations carry images, only fail over to image-capable routes; a text-only standby is a
  bad target for an image session.
- **Subagents never fail over** — sessions with `origin: 'subagent'` keep their own route on
  failure (the same-route retry policy still applies).
- **No settings-schema export** — config is validated manually at apply time (fail-open); the
  settings UI has no form for this section.

## License

MIT
