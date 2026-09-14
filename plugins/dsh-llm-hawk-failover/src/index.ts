/**
 * hawk-failover host plugin: fails a model route over to a backup provider
 * when the primary route is down. The chain here: local Qwen (llama.cpp) →
 * DeepSeek cloud (deepseek-v4-pro).
 *
 * DSH's LLM seam (`ctx.llm.stream()`) is single-attempt; recovery belongs to
 * the agent loop's two waterfall events (see
 * `@deepseek-ai/dsh-agent` runtime-types.d.ts `agent/request` and
 * `agent/request-error`):
 *
 *   1. `agent/request-error` (waterfall): one failed attempt surfaced. When
 *      the failure code is failover-class (default TRANSPORT/SERVER/TIMEOUT)
 *      this handler marks the serving provider quarantined until
 *      now+cooldownMs and returns `{ kind: 'retry' }` WITHOUT calling next().
 *      It cannot change the route directly — the retry makes the loop re-run
 *      the `agent/request` waterfall, which is where the surface change
 *      happens. Non-failover codes delegate via `return next()`:
 *      dsh-llm-retry owns same-route transient retries (RATE_LIMIT,
 *      EMPTY_RESPONSE) and compaction owns CONTEXT_WINDOW_EXCEEDED. Never
 *      fail over on AUTH / INVALID_CREDENTIAL / MISSING_CREDENTIAL /
 *      QUOTA_EXCEEDED / CONTEXT_WINDOW_EXCEEDED.
 *
 *   2. `agent/request` (waterfall): `const config = await next()` yields the
 *      config the machine would use. If that provider is quarantined, walk
 *      the configured ordered chain to the first non-quarantined entry and
 *      return the config with provider/model swapped and `reasoningEffort`
 *      STRIPPED (the target route resolves its own default; an unsupported
 *      explicit effort fails with UNSUPPORTED_REASONING_EFFORT before I/O).
 *      If nothing is available, the config passes through unchanged.
 *
 * Always fail-open: any internal error delegates (`return next()` /
 * pass-through config). Quarantine state is an in-memory Map on purpose:
 * a DSH restart re-tries the primary first, which is the desired behavior.
 * Subagent sessions (`agent.session.header.origin === 'subagent'`) are left
 * alone — their routes are chosen by the delegating agent, not this chain.
 *
 * Deliberately imports no @deepseek-ai package: the cordis Context face and
 * the two payload shapes are declared locally, so this package stays fully
 * self-contained inside the profile's node_modules (same regime as the
 * sibling dsh-client-ui-hawk-hq plugin).
 *
 * @module hawk-failover
 */

export const name = 'hawk-failover'

/**
 * The `agents` service must exist before agent-scoped waterfall events can
 * reach a root-context listener (same inject as @deepseek-ai/dsh-llm-retry).
 */
export const inject = ['agents']

/** One ordered standby route. */
export interface ChainEntry {
  readonly provider: string
  readonly model: string
}

/** Plugin configuration: the `hawk-failover:` section of settings.yaml. */
export interface HawkFailoverConfig {
  /** Master switch; default true. */
  readonly enabled?: boolean
  /** Ordered routes, primary first; failover walks to the first healthy one. */
  readonly chain?: readonly ChainEntry[]
  /** Failure codes that trigger a failover; default TRANSPORT/SERVER/TIMEOUT. */
  readonly failoverCodes?: readonly string[]
  /** How long a failed provider stays quarantined; default 120000. */
  readonly cooldownMs?: number
}

/** Fully-defaulted runtime configuration. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly chain: readonly ChainEntry[]
  readonly failoverCodes: readonly string[]
  readonly cooldownMs: number
}

const DEFAULT_FAILOVER_CODES: readonly string[] = ['TRANSPORT', 'SERVER', 'TIMEOUT']
const DEFAULT_COOLDOWN_MS = 120_000

/** Minimal logger face (cordis ctx.logger). */
export interface FailoverLogger {
  info(message: string): void
  warn(message: string): void
}

/** The cordis Context slice this plugin uses. */
interface HostContext {
  readonly logger: FailoverLogger
  effect(callback: () => unknown, label?: string): void
  on(event: string, listener: (payload: never, next: never) => unknown, prepend?: boolean): () => void
}

/** Frozen call configuration as proposed by the `agent/request` waterfall. */
interface LlmCallConfigLike {
  provider: string
  model: string
  reasoningEffort?: unknown
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/** Agent shape the two payloads carry (only what this plugin reads). */
interface AgentLike {
  readonly session?: {
    readonly header?: {
      readonly origin?: string
    }
  }
}

/** `agent/request` waterfall payload. */
interface RequestPayload {
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

/** `agent/request-error` waterfall payload. */
interface RequestErrorPayload {
  readonly agent?: AgentLike
  readonly provider?: string
  readonly failure?: {
    readonly code?: string
    readonly message?: string
  }
  readonly signal?: AbortSignal
}

type Next<T> = () => Promise<T>

type RequestErrorAction = { readonly kind: 'retry' } | undefined

/** Test/inspection handle over the two waterfall handlers. */
export interface FailoverCore {
  /** `agent/request` waterfall listener. */
  handleRequest(
    payload: RequestPayload,
    next: Next<LlmCallConfigLike>,
  ): Promise<LlmCallConfigLike>
  /** `agent/request-error` waterfall listener. */
  handleRequestError(
    payload: RequestErrorPayload,
    next: Next<RequestErrorAction>,
  ): Promise<RequestErrorAction>
  /** Providers whose quarantine is still active (diagnostics/tests). */
  quarantinedProviders(): string[]
}

function isSubagent(agent: AgentLike | undefined): boolean {
  return agent?.session?.header?.origin === 'subagent'
}

function formatRoute(chain: readonly ChainEntry[], provider: string): string {
  const entry = chain.find(candidate => candidate.provider === provider)
  return entry === undefined ? provider : `${entry.provider}/${entry.model}`
}

/**
 * Validate raw settings into a fully-defaulted config. Never throws: invalid
 * pieces are dropped with a warning and replaced by defaults (fail-open).
 */
export function resolveConfig(raw: unknown, logger: FailoverLogger): ResolvedConfig {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    logger.warn('hawk-failover: config is not an object; using defaults')
  }
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : true
  let chain: ChainEntry[] = []
  if (Array.isArray(source.chain)) {
    for (const entry of source.chain as unknown[]) {
      const record = entry as Record<string, unknown> | null
      if (
        typeof record === 'object' && record !== null
        && typeof record.provider === 'string' && record.provider !== ''
        && typeof record.model === 'string' && record.model !== ''
      ) {
        chain.push({ provider: record.provider, model: record.model })
      } else {
        logger.warn(`hawk-failover: dropping invalid chain entry ${JSON.stringify(entry)}`)
      }
    }
  } else if (source.chain !== undefined) {
    logger.warn('hawk-failover: chain is not an array; ignoring it')
  }
  const failoverCodes = Array.isArray(source.failoverCodes)
    ? (source.failoverCodes as unknown[]).filter((code): code is string => typeof code === 'string' && code !== '')
    : [...DEFAULT_FAILOVER_CODES]
  const cooldownMs = typeof source.cooldownMs === 'number'
    && Number.isFinite(source.cooldownMs) && source.cooldownMs > 0
    ? source.cooldownMs
    : DEFAULT_COOLDOWN_MS
  return { enabled, chain, failoverCodes, cooldownMs }
}

/**
 * Build the failover state machine. Pure and ctx-free so tests can drive the
 * two waterfall handlers directly; `apply()` wires it to the cordis context.
 */
export function createFailover(
  config: ResolvedConfig,
  deps: { logger: FailoverLogger; now?: () => number },
): FailoverCore {
  const { logger } = deps
  const now = deps.now ?? Date.now
  /** provider → quarantine expiry (ms epoch). Lazy expiry, provider-keyed. */
  const quarantine = new Map<string, number>()

  function quarantinedUntil(provider: string): number {
    const until = quarantine.get(provider)
    if (until === undefined) return 0
    if (until <= now()) {
      quarantine.delete(provider)
      return 0
    }
    return until
  }

  /** First chain entry whose provider is not quarantined, undefined if none. */
  function firstAvailable(): ChainEntry | undefined {
    return config.chain.find(entry => quarantinedUntil(entry.provider) === 0)
  }

  async function handleRequest(
    payload: RequestPayload,
    next: Next<LlmCallConfigLike>,
  ): Promise<LlmCallConfigLike> {
    // Downstream failure propagates — it is not this plugin's to fail-open.
    const proposed = await next()
    try {
      if (payload?.signal?.aborted) return proposed
      if (isSubagent(payload?.agent)) return proposed
      if (typeof proposed?.provider !== 'string') return proposed
      if (quarantinedUntil(proposed.provider) === 0) return proposed
      const target = firstAvailable()
      if (target === undefined) {
        logger.warn(
          `hawk-failover: ${formatRoute(config.chain, proposed.provider)} quarantined but no standby route available; keeping it`,
        )
        return proposed
      }
      // Swap the route; strip reasoningEffort so the target resolves its own
      // default instead of failing UNSUPPORTED_REASONING_EFFORT before I/O.
      const swapped: LlmCallConfigLike = { ...proposed, provider: target.provider, model: target.model }
      delete swapped.reasoningEffort
      logger.info(
        `hawk-failover: route ${proposed.provider}/${proposed.model} quarantined → ${target.provider}/${target.model}`,
      )
      return swapped
    } catch (error) {
      logger.warn(`hawk-failover: internal error in agent/request; passing through: ${String(error)}`)
      return proposed
    }
  }

  async function handleRequestError(
    payload: RequestErrorPayload,
    next: Next<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    try {
      if (payload?.signal?.aborted) return await next()
      if (isSubagent(payload?.agent)) return await next()
      const code = payload?.failure?.code
      const provider = payload?.provider
      if (typeof code !== 'string' || typeof provider !== 'string') return await next()
      if (!config.failoverCodes.includes(code)) return await next()
      quarantine.set(provider, now() + config.cooldownMs)
      const target = firstAvailable()
      if (target === undefined) {
        // Nowhere to fail over: delegate so dsh-llm-retry's same-route
        // backoff still applies.
        logger.warn(
          `hawk-failover: ${formatRoute(config.chain, provider)} failed (${code}) but no standby route available; delegating`,
        )
        return await next()
      }
      const seconds = Math.round(config.cooldownMs / 1000)
      logger.info(
        `hawk-failover: ${formatRoute(config.chain, provider)} quarantined ${seconds}s (${code}) → ${target.provider}/${target.model}`,
      )
      // Owning recovery: the loop closes this turn and re-runs the
      // agent/request waterfall, where handleRequest swaps the route.
      return { kind: 'retry' }
    } catch (error) {
      logger.warn(`hawk-failover: internal error in agent/request-error; delegating: ${String(error)}`)
      return next()
    }
  }

  function quarantinedProviders(): string[] {
    return [...quarantine.keys()].filter(provider => quarantinedUntil(provider) > 0)
  }

  return { handleRequest, handleRequestError, quarantinedProviders }
}

/**
 * Register the two waterfall listeners, prepended so this plugin sees the
 * failure and the route proposal before same-route recovery (dsh-llm-retry).
 */
export function apply(ctx: HostContext, rawConfig: HawkFailoverConfig = {}): void {
  const config = resolveConfig(rawConfig, ctx.logger)
  if (!config.enabled) {
    ctx.logger.info('hawk-failover: disabled by config')
    return
  }
  if (config.chain.length === 0) {
    ctx.logger.warn('hawk-failover: no chain configured; plugin is inert (set hawk-failover.chain in settings.yaml)')
    return
  }
  const core = createFailover(config, { logger: ctx.logger })
  const disposeRequest = ctx.on(
    'agent/request',
    core.handleRequest as (payload: never, next: never) => unknown,
    true,
  )
  const disposeRequestError = ctx.on(
    'agent/request-error',
    core.handleRequestError as (payload: never, next: never) => unknown,
    true,
  )
  ctx.effect(
    () => () => {
      disposeRequest()
      disposeRequestError()
    },
    'hawk-failover: detach waterfall listeners',
  )
  const routes = config.chain.map(entry => `${entry.provider}/${entry.model}`).join(' → ')
  ctx.logger.info(
    `hawk-failover: watching [${config.failoverCodes.join(', ')}], cooldown ${Math.round(config.cooldownMs / 1000)}s, chain ${routes}`,
  )
}
