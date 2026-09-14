/**
 * Plain-node unit tests for the hawk-failover core, run against the BUILT
 * lib (pnpm build first). Simulates the two agent-loop waterfall handlers:
 * quarantine mark → chain walk → config mutation, code filtering, cooldown
 * expiry, subagent skip, abort skip, and fail-open behavior.
 */
import assert from 'node:assert/strict'
import { createFailover, resolveConfig } from '../lib/index.js'

const CHAIN = [
  { provider: 'local-qwen', model: 'qwen3.8-27b' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
]

function makeLogger() {
  const lines = []
  return {
    lines,
    info(message) { lines.push(`info: ${message}`) },
    warn(message) { lines.push(`warn: ${message}`) },
  }
}

function makeCore(overrides = {}) {
  const logger = makeLogger()
  const clock = { t: 1_000_000 }
  const config = resolveConfig({
    enabled: true,
    chain: CHAIN,
    failoverCodes: ['TRANSPORT', 'SERVER', 'TIMEOUT'],
    cooldownMs: 120_000,
    ...overrides,
  }, logger)
  const core = createFailover(config, { logger, now: () => clock.t })
  return { core, logger, clock }
}

const primaryConfig = Object.freeze({
  provider: 'local-qwen',
  model: 'qwen3.8-27b',
  reasoningEffort: 'high',
  temperature: 0.6,
})
const agent = { session: { header: {} } }
const payload = (extra = {}) => ({ agent, turn: 1, step: 1, ...extra })

let passed = 0
async function test(label, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

// 1. TRANSPORT error quarantines the primary and owns the retry.
{
  const { core, logger } = makeCore()
  let nextCalled = false
  const action = await core.handleRequestError(
    payload({ provider: 'local-qwen', failure: { code: 'TRANSPORT', message: 'fetch failed' } }),
    async () => { nextCalled = true; return undefined },
  )
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(nextCalled, false, 'must not call next when owning recovery')
  assert.deepEqual(core.quarantinedProviders(), ['local-qwen'])
  assert.ok(
    logger.lines.some(line => line.includes(
      'hawk-failover: local-qwen/qwen3.8-27b quarantined 120s (TRANSPORT) → deepseek-official/deepseek-v4-pro',
    )),
    `expected spec log line, got: ${logger.lines.join(' | ')}`,
  )
  await test('TRANSPORT quarantines primary, returns {kind:retry}, logs spec line', () => {})
}

// 2. After quarantine, agent/request swaps provider+model and strips reasoningEffort.
{
  const { core } = makeCore()
  await core.handleRequestError(
    payload({ provider: 'local-qwen', failure: { code: 'SERVER' } }),
    async () => undefined,
  )
  const config = await core.handleRequest(payload(), async () => primaryConfig)
  assert.equal(config.provider, 'deepseek-official')
  assert.equal(config.model, 'deepseek-v4-pro')
  assert.equal('reasoningEffort' in config, false, 'reasoningEffort must be stripped')
  assert.equal(config.temperature, 0.6, 'sampling scalars survive the swap')
  await test('agent/request swaps to deepseek-official/deepseek-v4-pro, strips effort', () => {})
}

// 3. Non-failover codes delegate untouched (dsh-llm-retry / compaction own them).
{
  const { core } = makeCore()
  for (const code of ['RATE_LIMIT', 'EMPTY_RESPONSE', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA_EXCEEDED', 'CONTEXT_WINDOW_EXCEEDED']) {
    const action = await core.handleRequestError(
      payload({ provider: 'local-qwen', failure: { code } }),
      async () => undefined,
    )
    assert.equal(action, undefined, `${code} must delegate`)
    assert.deepEqual(core.quarantinedProviders(), [], `${code} must not quarantine`)
  }
  await test('RATE_LIMIT/AUTH/QUOTA/CONTEXT_WINDOW etc. delegate, never quarantine', () => {})
}

// 4. Cooldown expiry: primary usable again, config passes through unchanged.
{
  const { core, clock } = makeCore()
  await core.handleRequestError(
    payload({ provider: 'local-qwen', failure: { code: 'TIMEOUT' } }),
    async () => undefined,
  )
  clock.t += 119_999
  let config = await core.handleRequest(payload(), async () => primaryConfig)
  assert.equal(config.provider, 'deepseek-official', 'still quarantined just before expiry')
  clock.t += 2
  assert.deepEqual(core.quarantinedProviders(), [])
  config = await core.handleRequest(payload(), async () => primaryConfig)
  assert.equal(config, primaryConfig, 'expired quarantine returns the config untouched')
  await test('cooldown expiry restores the primary route', () => {})
}

// 5. All routes quarantined: error delegates (same-route backoff owns it), request passes through.
{
  const { core, logger } = makeCore()
  await core.handleRequestError(payload({ provider: 'local-qwen', failure: { code: 'TRANSPORT' } }), async () => undefined)
  const action = await core.handleRequestError(
    payload({ provider: 'deepseek-official', failure: { code: 'SERVER' } }),
    async () => undefined,
  )
  assert.equal(action, undefined, 'no standby left → delegate to dsh-llm-retry backoff')
  const down = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  const config = await core.handleRequest(payload(), async () => down)
  assert.equal(config, down, 'no standby left → config unchanged')
  assert.ok(logger.lines.some(line => line.includes('no standby route available')))
  await test('full chain down delegates instead of retry-looping', () => {})
}

// 6. Subagent sessions are never touched.
{
  const { core } = makeCore()
  const sub = { agent: { session: { header: { origin: 'subagent' } } } }
  const action = await core.handleRequestError(
    { ...sub, provider: 'local-qwen', failure: { code: 'TRANSPORT' } },
    async () => undefined,
  )
  assert.equal(action, undefined)
  assert.deepEqual(core.quarantinedProviders(), [])
  // Even with a quarantine active (from a top-level failure), subagent requests pass through.
  await core.handleRequestError(payload({ provider: 'local-qwen', failure: { code: 'TRANSPORT' } }), async () => undefined)
  const config = await core.handleRequest(sub, async () => primaryConfig)
  assert.equal(config, primaryConfig)
  await test('subagent origin skips both handlers', () => {})
}

// 7. Aborted signal delegates before acting.
{
  const { core } = makeCore()
  const aborted = new AbortController()
  aborted.abort()
  const action = await core.handleRequestError(
    payload({ provider: 'local-qwen', failure: { code: 'TRANSPORT' }, signal: aborted.signal }),
    async () => undefined,
  )
  assert.equal(action, undefined)
  assert.deepEqual(core.quarantinedProviders(), [], 'no quarantine on aborted turn')
  await test('aborted signal delegates without quarantining', () => {})
}

// 8. Provider not in the chain still fails over onto the chain.
{
  const { core } = makeCore()
  await core.handleRequestError(
    payload({ provider: 'kimi-proxy', failure: { code: 'TRANSPORT' } }),
    async () => undefined,
  )
  const kimi = Object.freeze({ provider: 'kimi-proxy', model: 'kimi-code' })
  const config = await core.handleRequest(payload(), async () => kimi)
  assert.equal(config.provider, 'local-qwen', 'walks chain from the top for off-chain routes')
  assert.equal(config.model, 'qwen3.8-27b')
  await test('off-chain provider failure fails over to first healthy chain entry', () => {})
}

// 9. Fail-open on garbage config: never throws, sane defaults.
{
  const logger = makeLogger()
  const config = resolveConfig({
    enabled: 'yes',
    chain: [{ provider: 42 }, 'nope', { provider: 'a', model: 'b' }],
    failoverCodes: 'TRANSPORT',
    cooldownMs: -5,
  }, logger)
  assert.equal(config.enabled, true)
  assert.deepEqual(config.chain, [{ provider: 'a', model: 'b' }])
  assert.deepEqual(config.failoverCodes, ['TRANSPORT', 'SERVER', 'TIMEOUT'])
  assert.equal(config.cooldownMs, 120_000)
  assert.ok(logger.lines.some(line => line.startsWith('warn:')))
  const totallyBogus = resolveConfig('garbage', logger)
  assert.equal(totallyBogus.chain.length, 0)
  await test('garbage config resolves to defaults without throwing', () => {})
}

// 10. Fail-open on internal error: a throwing chain getter must never break the loop.
{
  const logger = makeLogger()
  const evil = [{ get provider() { throw new Error('boom') }, model: 'x' }]
  const core = createFailover(
    { enabled: true, chain: evil, failoverCodes: ['TRANSPORT'], cooldownMs: 1000 },
    { logger },
  )
  // Quarantine local-qwen first; the evil getter then throws inside the
  // chain walk of BOTH handlers — each must fail open.
  const action = await core.handleRequestError(
    payload({ provider: 'local-qwen', failure: { code: 'TRANSPORT' } }),
    async () => undefined,
  )
  assert.equal(action, undefined, 'error handler delegates on internal error')
  const config = await core.handleRequest(payload(), async () => primaryConfig)
  assert.equal(config.provider, 'local-qwen', 'request handler passes config through on internal error')
  assert.ok(logger.lines.some(line => line.includes('internal error')))
  await test('internal errors fail open in both handlers', () => {})
}

// 11. Healthy route is never rewritten.
{
  const { core } = makeCore()
  const config = await core.handleRequest(payload(), async () => primaryConfig)
  assert.equal(config, primaryConfig)
  await test('healthy route passes through unchanged', () => {})
}

console.log(`\n${passed} tests passed`)
