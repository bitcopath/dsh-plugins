/**
 * hawk-hq host half: serves the three Hawk HQ data feeds over the plugin's
 * own HTTP/SSE routes (`ctx.webServer`):
 *   - GET  /plugin/hawk-hq/gpu                  — one rocm-smi sample (~2s
 *     cache) plus the gpu-guardian log tail;
 *   - GET  /plugin/hawk-hq/gpu/events           — SSE, same payload every 5s;
 *   - GET  /plugin/hawk-hq/notifications        — ~/.dsh/notifications.jsonl
 *     tail, newest first;
 *   - GET  /plugin/hawk-hq/notifications/events — SSE, live appends;
 *   - GET  /plugin/hawk-hq/stats                — api_endpoint_stats latest
 *     per provider + 14-day daily volume, read via `python3` + sqlite3
 *     (read-only URI; no node sqlite dependency).
 *   - GET  /plugin/hawk-hq/version              — running harness version
 *     (resolved from `process.argv[1]` → the @deepseek-ai/dsh package root)
 *     plus the npm registry dist-tags, for the sidebar version badge.
 * No paid API is ever called: every byte comes from rocm-smi, local log
 * files, or the local stats database.
 *
 * Deliberately imports no @deepseek-ai package: the cordis Context and the
 * webServer service face are declared locally, so this package stays fully
 * self-contained inside the profile's node_modules.
 *
 * @module hawk-hq
 */

import { execFile } from 'node:child_process'
import { createReadStream, readFileSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  DailyVolume, ErrorResponse, GpuSample, GpuStatePayload, GuardianState,
  DailySpend, NotificationItem, NotificationsPayload, ProviderStat, QuotaStat, StatsPayload,
  VersionPayload,
} from './wire.ts'
import { compareVersions } from './semver.ts'

export const name = 'hawk-hq'

/** Services required by the routes. */
export const inject = ['webServer']

/** Route prefix under which the plugin serves its API. */
export const API_PREFIX = '/plugin/hawk-hq'

/** The minimal cordis Context face this plugin uses. */
interface HostContext {
  readonly logger: { info(message: string): void; warn(message: string): void }
  effect(callback: () => unknown, label?: string): void
  readonly webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
    }): unknown
  }
}

/** Plugin configuration: every path has a default; override it in the profile patch. */
export interface HawkHqConfig {
  /** gpu-guardian ladder log path. */
  readonly guardianLog?: string
  /** Hawk notification inbox (JSONL) path. */
  readonly notificationsFile?: string
  /** dsh-hq stats sqlite database path. */
  readonly statsDb?: string
}

const DEFAULT_GUARDIAN_LOG = `${homedir()}/dsh-hq/logs/gpu-guardian.log`
const DEFAULT_NOTIFICATIONS = `${homedir()}/.dsh/notifications.jsonl`
const DEFAULT_STATS_DB = `${homedir()}/dsh-hq/stats.db`

/** How long one rocm-smi sample stays valid (the card polls are not free). */
const GPU_CACHE_MS = 2000
/** How long the /proc model label stays valid (process table scans are cheap
 *  but /proc reads per PID are not free; model changes are rare). */
const GPU_MODEL_CACHE_MS = 3000
/** SSE cadence for the GPU page. */
const GPU_SSE_INTERVAL_MS = 5000
/** How much of a log file tail is read back (bytes). */
const TAIL_READ_BYTES = 64 * 1024
/** Guardian log lines kept for the page. */
const GUARDIAN_TAIL_LINES = 50
/** Notification rows returned by the inbox endpoint. */
const NOTIFICATION_LIMIT = 200

/** Run one command, returning stdout; rejects on non-zero exit or timeout. */
function execFileText(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolvePromise(stdout)
    })
  })
}

/** Read one JSON field as a finite number, null when absent or unparsable. */
function numberField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Read one argument by name from a cmdline (`--model value` and `--model=value`). */
function argValue(args: readonly string[], ...keys: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    for (const key of keys) {
      if (args[index] === key) return args[index + 1] ?? null
      if (args[index].startsWith(`${key}=`)) return args[index].slice(key.length + 1)
    }
  }
  return null
}

/** Collapse a model path to a short display name (strip dir + quant suffix). */
function prettyModelName(path: string): string {
  let name = path.split('/').pop()?.replace(/\.(gguf|safetensors|bin)$/i, '') ?? ''
  name = name.replace(/-(Q\d+_[A-Za-z0-9_]+|IQ\d+_[A-Za-z0-9_]+|F16|BF16)$/i, '')
  return name
}

/** Map one rocm-smi --json card row onto the wire sample. */
function toGpuSample(card: Record<string, unknown>, modelName: string | null): GpuSample {
  return {
    edgeC: numberField(card, 'Temperature (Sensor edge) (C)'),
    junctionC: numberField(card, 'Temperature (Sensor junction) (C)'),
    memoryC: numberField(card, 'Temperature (Sensor memory) (C)'),
    powerW: numberField(card, 'Average Graphics Package Power (W)'),
    powerCapW: numberField(card, 'Max Graphics Package Power (W)'),
    utilPct: numberField(card, 'GPU use (%)'),
    vramUsedB: numberField(card, 'VRAM Total Used Memory (B)'),
    vramTotalB: numberField(card, 'VRAM Total Memory (B)'),
    modelName,
  }
}

let gpuCache: { readonly at: number; readonly sample: GpuSample } | null = null
let gpuModelCache: { readonly at: number; readonly label: string | null } | null = null

/**
 * Best-effort label of the workload resident on the GPU, priority-ordered:
 * llama-server/cli/mtmd (model file name) > ComfyUI > vLLM > Ollama. Scans the
 * process table; never shells out to a paid API. Returns null when no known
 * GPU workload is running (the caller can fall back to the VRAM heuristic).
 */
async function detectGpuModelLabel(): Promise<string | null> {
  let pids: string[]
  try {
    pids = (await readdir('/proc')).filter(pid => /^\d+$/.test(pid))
  } catch {
    return null
  }
  for (const pid of pids) {
    let cmdline: string[]
    try {
      const buffer = await readFile(`/proc/${pid}/cmdline`)
      cmdline = buffer.toString('utf8').split('\0').filter(Boolean)
    } catch {
      continue
    }
    if (cmdline.length === 0) continue
    const low = cmdline.join(' ').toLowerCase()
    if (/llama-(server|cli|mtmd|perplexity)/.test(low) || /llama\.server/.test(low)) {
      const model = argValue(cmdline, '--model', '-m')
      return model !== null ? prettyModelName(model) : 'llama'
    }
    if (low.includes('comfy')) return 'ComfyUI'
    if (low.includes('vllm')) return 'vLLM'
    if (low.includes('ollama')) return 'Ollama'
  }
  return null
}

/** Read the GPU model label from a short TTL cache (process reads are not free). */
async function readGpuModel(): Promise<string | null> {
  if (gpuModelCache !== null && Date.now() - gpuModelCache.at < GPU_MODEL_CACHE_MS) return gpuModelCache.label
  const label = await detectGpuModelLabel()
  gpuModelCache = { at: Date.now(), label }
  return label
}

/** Read one rocm-smi sample, served from a ~2s cache under SSE fan-out. */
async function readGpu(): Promise<GpuSample> {
  if (gpuCache !== null && Date.now() - gpuCache.at < GPU_CACHE_MS) return gpuCache.sample
  const stdout = await execFileText('rocm-smi', [
    '--showtemp', '--showmeminfo', 'vram', '--showuse', '--showpower', '--showmaxpower', '--json',
  ], 5000)
  const parsed = JSON.parse(stdout) as Record<string, Record<string, unknown>>
  const card = parsed.card0 ?? Object.values(parsed)[0]
  if (card === undefined) throw new Error('rocm-smi returned no card rows')
  const modelName = await readGpuModel()
  const sample = toGpuSample(card, modelName)
  gpuCache = { at: Date.now(), sample }
  return sample
}

/** Read the last chunk of a text file; empty string when the file is missing. */
async function readTail(path: string, maxBytes: number): Promise<string> {
  try {
    const info = await stat(path)
    const start = Math.max(0, info.size - maxBytes)
    if (start === 0) return await readFile(path, 'utf8')
    // Bounded tail read without keeping the whole file in memory.
    return await new Promise<string>((resolvePromise, reject) => {
      const chunks: Buffer[] = []
      const stream = createReadStream(path, { start })
      stream.on('data', (chunk: string | Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      stream.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })
  } catch {
    return ''
  }
}

/** Tail view of the guardian ladder log plus the last seen rung. */
async function readGuardian(logPath: string): Promise<GuardianState> {
  const text = await readTail(logPath, TAIL_READ_BYTES)
  if (text === '') return { rung: null, lines: [], unavailable: true }
  const lines = text.split('\n').filter(line => line.trim() !== '').slice(-GUARDIAN_TAIL_LINES)
  let rung: number | null = null
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /rung=(\d+)/.exec(lines[index])
    if (match !== null) {
      rung = Number(match[1])
      break
    }
  }
  return { rung, lines, unavailable: false }
}

/** Compose the GPU page payload (rocm-smi + guardian tail). */
async function readGpuState(guardianLog: string): Promise<GpuStatePayload> {
  const [gpuResult, guardian] = await Promise.all([
    readGpu().then(sample => ({ sample }), (error: unknown) => ({ error: String(error) })),
    readGuardian(guardianLog),
  ])
  return {
    gpu: 'sample' in gpuResult ? gpuResult.sample : null,
    ...('error' in gpuResult ? { gpuError: gpuResult.error } : {}),
    guardian,
    at: new Date().toISOString(),
  }
}

/** Parse one JSONL line into a notification row, null when not an object. */
function toNotification(line: string): NotificationItem | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof raw !== 'object' || raw === null) return null
    const ts = typeof raw.at === 'string' ? raw.at : typeof raw.ts === 'string' ? raw.ts : null
    return {
      ts,
      message: typeof raw.message === 'string' ? raw.message : trimmed,
      urgency: typeof raw.urgency === 'string' ? raw.urgency : 'info',
      raw,
    }
  } catch {
    return null
  }
}

/** Read the notification inbox tail, newest first. */
async function readNotifications(file: string): Promise<NotificationItem[]> {
  const text = await readTail(file, TAIL_READ_BYTES)
  const rows: NotificationItem[] = []
  for (const line of text.split('\n')) {
    const row = toNotification(line)
    if (row !== null) rows.push(row)
  }
  return rows.reverse().slice(0, NOTIFICATION_LIMIT)
}

/** SQL the stats route runs; fixed text, so there is nothing to inject. */
const STATS_PY = `
import json, sqlite3, sys
db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
latest = db.execute("""
SELECT t.provider, t.balance_usd, t.balance_currency, t.tokens_in, t.tokens_out, t.period, t.note, t.recorded_at, t.cost_usd
FROM api_endpoint_stats t
JOIN (SELECT provider, MAX(id) AS m FROM api_endpoint_stats GROUP BY provider) x ON t.id = x.m
ORDER BY t.provider
""").fetchall()
try:
    quotas = db.execute("""
    SELECT t.provider, t.quota_name, t.display_name, t.utilization, t.balance_usd, t.resets_at, t.status, t.recorded_at
    FROM provider_quota t
    JOIN (SELECT provider, quota_name, MAX(id) AS m FROM provider_quota GROUP BY provider, quota_name) x ON t.id = x.m
    ORDER BY t.provider, t.quota_name
    """).fetchall()
except sqlite3.Error:
    quotas = []  # table predates the onWatch wiring
daily = db.execute("""
SELECT d.day, SUM(t.tokens_in), SUM(t.tokens_out)
FROM (
  SELECT date(recorded_at) AS day, provider, MAX(id) AS m
  FROM api_endpoint_stats
  WHERE recorded_at >= datetime('now', '-14 days')
  GROUP BY day, provider
) d
JOIN api_endpoint_stats t ON t.id = d.m
GROUP BY d.day
ORDER BY d.day
""").fetchall()
# Balance series -> spend and top-ups. A drop between two consecutive samples is
# money spent; a rise is a top-up. This is the ONLY cost signal for the
# balance-only providers (deepseek, fal, moonshotai, xai, zai), which is why the
# token chart alone can never answer "what did today cost" (deepseek stores no
# token counts at all). A drop that spans midnight is attributed to the day of
# the later sample, and the resolution is the collector's cadence (10 min).
series = db.execute("""
SELECT provider, date(recorded_at) AS day, recorded_at, balance_usd
FROM api_endpoint_stats
WHERE balance_usd IS NOT NULL AND recorded_at >= datetime('now', '-30 days')
ORDER BY provider, recorded_at
""").fetchall()
# A step larger than this in one 10-minute sample is bad data, not money: the
# 2026-09-08 xAI cents/dollars bug wrote -1000.0 samples, which would otherwise
# show up as a fake $1000 spent plus a $1010 top-up. Real top-ups observed here
# are under $20, so the guard is generous; the ignored count is reported rather
# than hidden, so a genuinely huge future top-up would be visible as "ignored".
MAX_STEP_USD = 200.0
spend = {}
topup = {}
samples = {}
ignored = {}
prev = {}
for provider, day, _ts, bal in series:
    samples[(provider, day)] = samples.get((provider, day), 0) + 1
    if provider in prev:
        delta = prev[provider] - bal
        if abs(delta) > MAX_STEP_USD:
            ignored[(provider, day)] = ignored.get((provider, day), 0) + 1
        elif delta > 0:
            spend[(provider, day)] = spend.get((provider, day), 0.0) + delta
        elif delta < 0:
            topup[(provider, day)] = topup.get((provider, day), 0.0) + (-delta)
    prev[provider] = bal
days = sorted({key for key in list(spend) + list(topup) + list(ignored)})
daily_spend = [[day, provider, round(spend.get((provider, day), 0.0), 4),
                round(topup.get((provider, day), 0.0), 4), samples.get((provider, day), 0),
                ignored.get((provider, day), 0)]
               for provider, day in days]
print(json.dumps({'latest': latest, 'quotas': quotas, 'daily': daily, 'daily_spend': daily_spend}))
`

/** Query the stats database through python3 + sqlite3 (no node sqlite dep). */
async function readStats(dbPath: string): Promise<StatsPayload> {
  const stdout = await execFileText('python3', ['-c', STATS_PY, dbPath], 10000)
  const parsed = JSON.parse(stdout) as {
    latest: [string, number | null, string | null, number | null, number | null, string | null, string | null, string, number | null][]
    quotas: [string, string, string | null, number | null, number | null, string | null, string | null, string][]
    daily: [string, number | null, number | null][]
    daily_spend: [string, string, number, number, number, number][]
  }
  const providers: ProviderStat[] = parsed.latest.map(row => ({
    provider: row[0],
    balanceUsd: row[1],
    balanceCurrency: row[2],
    tokensIn: row[3],
    tokensOut: row[4],
    period: row[5],
    note: row[6],
    recordedAt: row[7],
    costUsd: row[8] ?? null,
  }))
  const quotas: QuotaStat[] = (parsed.quotas ?? []).map(row => ({
    provider: row[0],
    quotaName: row[1],
    displayName: row[2],
    utilization: row[3],
    balanceUsd: row[4],
    resetsAt: row[5],
    status: row[6],
    recordedAt: row[7],
  }))
  const daily: DailyVolume[] = parsed.daily.map(row => ({
    day: row[0],
    tokensIn: row[1] ?? 0,
    tokensOut: row[2] ?? 0,
  }))
  const dailySpend: DailySpend[] = (parsed.daily_spend ?? []).map(row => ({
    day: row[0],
    provider: row[1],
    spendUsd: row[2],
    topUpUsd: row[3],
    samples: row[4],
    ignoredSamples: row[5] ?? 0,
  }))
  return { providers, quotas, daily, dailySpend }
}

/** Write one JSON response with no-store caching. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Uniform error body. */
function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } }
}

/** Open one SSE stream. */
function sseOpen(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': hawk-hq\n\n')
}

/** Send one named SSE event. */
function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Require GET, answering 405 otherwise; returns true when the request may proceed. */
function requireGet(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method === 'GET') return true
  sendJson(res, 405, errorBody('method-not-allowed', `method ${req.method} is not allowed on ${pathname}`))
  return false
}

/**
 * Serve the GPU page feed: one JSON snapshot on /gpu, and an SSE stream on
 * /gpu/events pushing the same payload every 5s (plus a 25s comment
 * heartbeat so proxies keep the stream open).
 */
function handleGpuEvents(
  req: IncomingMessage, res: ServerResponse, guardianLog: string,
): void {
  sseOpen(res)
  let closed = false
  const push = async (): Promise<void> => {
    if (closed) return
    try {
      sseSend(res, 'state', await readGpuState(guardianLog))
    } catch {
      // A failed tick is retried on the next interval; the stream stays open.
    }
  }
  void push()
  const interval = setInterval(() => void push(), GPU_SSE_INTERVAL_MS)
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': hb\n\n')
  }, 25000)
  req.on('close', () => {
    closed = true
    clearInterval(interval)
    clearInterval(heartbeat)
  })
}

/**
 * Serve the notification feed: the JSONL tail on /notifications, and an SSE
 * stream on /notifications/events emitting one `notification` event per
 * appended line (fs.watch on the inbox; a truncation emits `reset` so the
 * client refetches the tail).
 */
function handleNotificationEvents(
  ctx: HostContext, req: IncomingMessage, res: ServerResponse, file: string,
): void {
  sseOpen(res)
  let closed = false
  let offset = -1
  let pumping = false
  let pending = false
  const pump = async (): Promise<void> => {
    if (closed || pumping) {
      pending = true
      return
    }
    pumping = true
    try {
      const info = await stat(file).catch(() => null)
      if (info === null) return
      if (offset < 0) {
        offset = info.size
        return
      }
      if (info.size < offset) {
        offset = info.size
        sseSend(res, 'reset', {})
        return
      }
      if (info.size === offset) return
      // Byte-offset bookkeeping throughout: the inbox carries multibyte
      // UTF-8, so string indices and stat sizes must never mix.
      const buffer = await readFile(file)
      const fresh = buffer.subarray(offset)
      const lastNewline = fresh.lastIndexOf(0x0a)
      if (lastNewline < 0) return
      offset += lastNewline + 1
      for (const line of fresh.subarray(0, lastNewline).toString('utf8').split('\n')) {
        const row = toNotification(line)
        if (row !== null) sseSend(res, 'notification', row)
      }
    } catch (error) {
      ctx.logger.warn(`hawk-hq: notification stream: ${String(error)}`)
    } finally {
      pumping = false
      if (pending && !closed) {
        pending = false
        void pump()
      }
    }
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(file, { persistent: false }, () => void pump())
  } catch (error) {
    ctx.logger.warn(`hawk-hq: cannot watch ${file}: ${String(error)}`)
  }
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': hb\n\n')
  }, 25000)
  void pump()
  req.on('close', () => {
    closed = true
    clearInterval(heartbeat)
    watcher?.close()
  })
}

/** npm package name of the harness whose version the badge shows. */
const HARNESS_PACKAGE = '@deepseek-ai/dsh'
/** Abbreviated registry document (dist-tags only, not the full multi-MB doc). */
const REGISTRY_DOC_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'
/** How long one registry answer stays fresh (a new harness release is not urgent). */
const VERSION_CACHE_MS = 30 * 60 * 1000
/** A failed check retries sooner than a good one, but never on every page load. */
const VERSION_ERROR_CACHE_MS = 60 * 1000
/** Registry request timeout. */
const REGISTRY_TIMEOUT_MS = 8000

/** The serving install, memoized: it cannot change while this process lives. */
let installCache: { readonly version: string; readonly path: string } | null | undefined
/** Last registry answer, with the time it was stored. */
let versionCache: { readonly at: number; readonly payload: VersionPayload } | null = null
/** Shared in-flight refresh, so parallel page loads cause one registry read. */
let versionInFlight: Promise<VersionPayload> | null = null

/**
 * Resolve the running harness package from this process's entry point
 * (`…/bin/dsh` → `…/@deepseek-ai/dsh/lib/bin.js` → package.json), walking up
 * until the package name matches. Returns null when the layout is unfamiliar;
 * the badge then falls back to the version baked into its browser bundle.
 */
function dshInstall(): { readonly version: string; readonly path: string } | null {
  if (installCache !== undefined) return installCache
  installCache = null
  const entry = process.argv[1]
  if (entry !== undefined) {
    let directory: string
    try {
      directory = dirname(realpathSync(entry))
    } catch {
      return installCache
    }
    for (let depth = 0; depth < 8; depth++) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(directory, 'package.json'), 'utf8'),
        ) as { name?: string; version?: string }
        if (manifest.name === HARNESS_PACKAGE && typeof manifest.version === 'string') {
          installCache = { version: manifest.version, path: directory }
          break
        }
      } catch {
        // Not a package root (or unreadable) — keep walking up.
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return installCache
}

/** Payload for the very first request: the running version, registry still pending. */
function pendingVersionPayload(): VersionPayload {
  const install = dshInstall()
  return {
    current: install?.version ?? null,
    installPath: install?.path ?? null,
    latest: null,
    distTags: {},
    updateAvailable: false,
    pending: true,
    checkedAt: new Date().toISOString(),
  }
}

/** One registry read. Never rejects: a failure is reported in `error`. */
async function fetchVersionState(): Promise<VersionPayload> {
  const install = dshInstall()
  const current = install?.version ?? null
  try {
    const response = await fetch(REGISTRY_DOC_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
    const doc = (await response.json()) as { 'dist-tags'?: Record<string, string> }
    const distTags: Record<string, string> = doc['dist-tags'] ?? {}
    const latest = typeof distTags.latest === 'string' ? distTags.latest : null
    return {
      current,
      installPath: install?.path ?? null,
      latest,
      distTags,
      updateAvailable: current !== null && latest !== null && compareVersions(latest, current) > 0,
      checkedAt: new Date().toISOString(),
    }
  } catch (error) {
    const stale = versionCache
    return {
      current,
      installPath: install?.path ?? null,
      latest: stale?.payload.latest ?? null,
      distTags: stale?.payload.distTags ?? {},
      updateAvailable: stale?.payload.updateAvailable ?? false,
      checkedAt: stale?.payload.checkedAt ?? new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stale: stale !== null,
    }
  }
}

/** Refresh once, sharing a single in-flight registry read across callers. */
function refreshVersionState(): Promise<VersionPayload> {
  if (versionInFlight !== null) return versionInFlight
  versionInFlight = fetchVersionState()
    .then((payload) => {
      versionCache = { at: Date.now(), payload }
      return payload
    })
    .catch(() => pendingVersionPayload())
    .finally(() => {
      versionInFlight = null
    })
  return versionInFlight
}

/**
 * Serve the badge's data: a fresh answer at once, an expired one immediately
 * while a refresh runs in the background (stale-while-revalidate), and a
 * `pending` answer instead of holding the page on the very first request.
 */
async function readVersionState(): Promise<VersionPayload> {
  if (versionCache === null) {
    void refreshVersionState()
    return pendingVersionPayload()
  }
  const ttl = versionCache.payload.error === undefined ? VERSION_CACHE_MS : VERSION_ERROR_CACHE_MS
  if (Date.now() - versionCache.at < ttl) return versionCache.payload
  void refreshVersionState()
  return { ...versionCache.payload, stale: true }
}

/** Dispatch the plugin's routes under API_PREFIX. */
function makeHandler(
  ctx: HostContext, config: Required<HawkHqConfig>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://hawk-hq').pathname
    try {
      if (pathname === `${API_PREFIX}/gpu`) {
        if (!requireGet(req, res, pathname)) return
        sendJson(res, 200, await readGpuState(config.guardianLog))
        return
      }
      if (pathname === `${API_PREFIX}/gpu/events`) {
        if (!requireGet(req, res, pathname)) return
        handleGpuEvents(req, res, config.guardianLog)
        return
      }
      if (pathname === `${API_PREFIX}/notifications`) {
        if (!requireGet(req, res, pathname)) return
        sendJson(res, 200, {
          notifications: await readNotifications(config.notificationsFile),
        } satisfies NotificationsPayload)
        return
      }
      if (pathname === `${API_PREFIX}/notifications/events`) {
        if (!requireGet(req, res, pathname)) return
        handleNotificationEvents(ctx, req, res, config.notificationsFile)
        return
      }
      if (pathname === `${API_PREFIX}/stats`) {
        if (!requireGet(req, res, pathname)) return
        sendJson(res, 200, await readStats(config.statsDb))
        return
      }
      if (pathname === `${API_PREFIX}/version`) {
        if (!requireGet(req, res, pathname)) return
        sendJson(res, 200, await readVersionState())
        return
      }
      sendJson(res, 404, errorBody('not-found', `unknown route ${pathname}`))
    } catch (error) {
      ctx.logger.warn(`hawk-hq: ${pathname}: ${String(error)}`)
      if (!res.headersSent) sendJson(res, 500, errorBody('internal', String(error)))
      else res.end()
    }
  }
}

/** Register the plugin's HTTP/SSE routes on the harness web server. */
export function apply(ctx: HostContext, config: HawkHqConfig = {}): void {
  const resolved: Required<HawkHqConfig> = {
    guardianLog: config.guardianLog ?? DEFAULT_GUARDIAN_LOG,
    notificationsFile: config.notificationsFile ?? DEFAULT_NOTIFICATIONS,
    statsDb: config.statsDb ?? DEFAULT_STATS_DB,
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: makeHandler(ctx, resolved),
    }),
    'hawk-hq: API routes',
  )
  ctx.logger.info(`hawk-hq: serving ${API_PREFIX} (gpu, notifications, stats, version)`)
}
