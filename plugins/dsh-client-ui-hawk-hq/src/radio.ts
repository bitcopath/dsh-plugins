/**
 * Hawk Radio — host half.
 *
 * Owns everything the sidebar card cannot do from the browser: the on-disk
 * library, the ratings that later feed adapter retraining, and the calls to the
 * ACE-Step renderer on the ai-server.
 *
 * Deliberate choices:
 *   - No credential or machine detail lives in this repository (it is public).
 *     The renderer URL and API key are read from `~/.config/hawk-radio/config.json`
 *     (mode 600, outside the repo) or from HAWK_RADIO_* environment variables.
 *   - Generation is on demand, not on a timer. A background queue daemon is a
 *     separate, deliberate step: this half must be safe to run while the owner is
 *     working, so nothing ever starts a render without a request.
 *   - Ratings are files, not a database: `<id>.json` sits next to `<id>.mp3`, so
 *     the library stays portable and auditable by hand.
 */

import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RadioHealth, RadioPayload, RadioTrack } from './wire.ts'

/** Where the owner's settings for this plugin live (never inside the repo). */
export const RADIO_CONFIG = join(homedir(), '.config', 'hawk-radio', 'config.json')

/** Default library location; overridden by the config file. */
const DEFAULT_LIBRARY = join(homedir(), '.local', 'share', 'hawk-radio', 'library')

/** Renderer default: the ai-server's ACE-Step service. */
const DEFAULT_ACE_BASE = 'http://192.168.0.102:8001'

/** Starter caption pool, one entry per station family. */
const CAPTION_POOL: Readonly<Record<string, readonly string[]>> = {
  'rock-classic-metal': [
    'Hard rock, raspy male lead, riffing electric guitars, tight live drums, dry punchy analog mix, backing harmonies on the chorus, wide stereo guitars',
    'Arena rock ballad, emotional male lead, clean picked guitar into a soaring chorus, piano and strings, glossy 1990s production, big reverb',
    'Melodic punk rock, snotty male lead with harmonies, fast palm-muted riffing, driving drums, loud Californian production',
    'Epic heavy metal, operatic male lead, galloping twin guitar harmonies, driving bass, long instrumental section, 1980s metal production',
  ],
  'turkish-anatolian': [
    'Anatolian rock, deep male lead with unison chorus, overdriven electric guitar, organ, driving live drums, 1970s Turkish analog production',
    'Anatolian folk-rock, storytelling male vocal, clean electric guitar with modal melody, bass and live drums, warm 1970s Turkish mix',
    'Turkish rock ballad, powerful male lead, electric guitar lines, strings and organ, slow-building emotional arrangement',
    'Psychedelic Anatolian rock, gritty male vocal, fuzz electric guitar with eastern scales, organ, heavy drums, hypnotic groove',
  ],
  'dance-pop': [
    'Modern dance-pop, female lead with layered backing vocals, four-on-the-floor kick, sidechained synth pads, bright radio mix, euphoric drop',
    'Disco-house, female lead with airy backing, filtered string stabs, funk guitar, live-feel bass, warm analog sheen',
    'Future-house pop, female topline plus male rap verse, chopped vocal sample, warm bassline, emotional electronic production',
    'Italo disco pop, bright male group vocals, punchy 80s drum machine, synth brass, handclaps, sunny retro-European production',
  ],
  'hiphop-90s': [
    'Hard West Coast hip-hop, aggressive male rap with group response, sparse menacing synth, deep 808 bass, dry 1990s gangsta mix',
    'G-funk hip-hop, male rap over a talkbox synth lead, funk guitar, deep bassline, party ad-libs, classic West Coast production',
    'Boom-bap hip-hop, male rap over a warm piano and string sample loop, laid-back drums, melancholic 1990s mix',
    'Conscious hip-hop, clear male rap, jazzy Rhodes chords, upright bass, crisp snare, vinyl crackle, vintage boom-bap',
  ],
  'rocknroll-50s-rnb': [
    '1950s rock and roll, clear male lead, double-stop electric guitar, piano and upright bass, driving shuffle, mono-era bright production',
    'Rocking rhythm and blues, energetic male lead, boogie electric guitar, piano and drums, fast shuffle, vintage mono production',
    'Deep soul, powerful male lead, warm organ, gospel-tinged backing vocals, slow horn-lined groove, 1960s soul production',
    'Party rhythm and blues, male leads trading lines, punchy horn section, driving drums, handclaps, live-band production',
  ],
}

/**
 * Per-station tempo/key ranges.
 *
 * Why this exists: these are music *metadata*, and ACE-Step takes them as
 * parameters, not as prose. The research (docs/en/Tutorial.md) is explicit that
 * the caption and the metadata fields must not disagree, and the community
 * guidance for this model is to state the tempo in both places consistently. So
 * one pick feeds both: the caption text and the `bpm`/`key_scale` parameters.
 */
const STATION_TEMPO: Readonly<Record<string, { readonly bpm: readonly [number, number]; readonly keys: readonly string[] }>> = {
  'rock-classic-metal': { bpm: [72, 170], keys: ['E minor', 'D minor', 'A minor', 'G major', 'A major'] },
  'turkish-anatolian': { bpm: [80, 130], keys: ['D minor', 'A minor', 'E minor', 'G major'] },
  'dance-pop': { bpm: [118, 132], keys: ['C minor', 'F minor', 'A minor', 'G major'] },
  'hiphop-90s': { bpm: [86, 100], keys: ['C minor', 'F minor', 'G minor', 'A minor'] },
  'rocknroll-50s-rnb': { bpm: [140, 180], keys: ['C major', 'G major', 'A major', 'E major'] },
}

/** Title word pools, one per station, so generated songs get names rather than UUIDs. */
const TITLE_POOL: Readonly<Record<string, readonly string[]>> = {
  'rock-classic-metal': ['Iron Sky', 'Broken Radio', 'Last Highway', 'Cold Thunder', 'Burning Mile', 'Black River', 'Neon Dust', 'Hard Rain'],
  'turkish-anatolian': ['Kırık Saat', 'Gurbet Yolu', 'Sarı Toz', 'Uzun Yol', 'Eski Radyo', 'Sessiz Avlu', 'Dağ Rüzgârı', 'Bahar Geldi'],
  'dance-pop': ['Neon Nights', 'Hold The Light', 'After Midnight', 'Golden Hour', 'Runaway Signal', 'Electric Bloom', 'Higher Ground', 'Slow Motion'],
  'hiphop-90s': ['Concrete Sunset', 'West Side Story', 'Cold Blocks', 'Payday', 'Long Way Home', 'Pressure', 'Streetlight', 'No Sleep'],
  'rocknroll-50s-rnb': ['Big Beat', 'Saturday Night', 'Cadillac Blues', 'Honey Hush', 'Roll Baby Roll', 'Mojo Workin', 'Blue Monday', 'Shake It Loose'],
}

/** Everything the radio host half needs, resolved from config + environment. */
export interface RadioConfig {
  readonly library: string
  readonly aceBase: string
  readonly aceKey: string
  /** Seconds per generated track. */
  readonly duration: number
  /** Selected planner model ("provider:model"), persisted so the choice sticks. */
  readonly planner: string
  /** Selected renderer model id (ACE-Step); empty means the server default. */
  readonly musicModel: string
}

/** Read the owner's config file if it exists; environment wins where present. */
export async function loadRadioConfig(): Promise<RadioConfig> {
  let file: Record<string, unknown> = {}
  try {
    file = JSON.parse(await readFile(RADIO_CONFIG, 'utf8')) as Record<string, unknown>
  } catch { /* absent config is normal: defaults below are all local and free */ }
  const pick = (env: string, key: string, fallback: string): string =>
    process.env[env] ?? (typeof file[key] === 'string' ? file[key] as string : fallback)
  const dur = Number(process.env.HAWK_RADIO_DURATION ?? file.duration ?? 60)
  return {
    library: pick('HAWK_RADIO_LIBRARY', 'library', DEFAULT_LIBRARY),
    aceBase: pick('HAWK_RADIO_ACE_BASE', 'aceBase', DEFAULT_ACE_BASE).replace(/\/+$/, ''),
    aceKey: pick('HAWK_RADIO_ACE_KEY', 'aceKey', ''),
    duration: Number.isFinite(dur) && dur >= 10 && dur <= 600 ? dur : 60,
    planner: pick('HAWK_RADIO_PLANNER', 'planner', ''),
    musicModel: pick('HAWK_RADIO_MUSIC_MODEL', 'musicModel', ''),
  }
}

/** The raw config file as an object (used when persisting a selection). */
async function readConfigFile(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(RADIO_CONFIG, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Persist the two model selections.
 *
 * They live in the same 0600 file as the renderer key, outside this repository:
 * the choice is per-machine, and nothing about it belongs in public source.
 */
export async function saveRadioSettings(
  patch: { planner?: string; musicModel?: string },
): Promise<void> {
  const file = await readConfigFile()
  if (typeof patch.planner === 'string') file.planner = patch.planner
  if (typeof patch.musicModel === 'string') file.musicModel = patch.musicModel
  await writeFile(RADIO_CONFIG, JSON.stringify(file, null, 1), { encoding: 'utf8', mode: 0o600 })
}

/** One selectable planner model. */
export interface ModelChoice {
  readonly provider: string
  readonly id: string
  readonly name: string
  /** True for the renderer entry, so the UI can keep it out of the planner list. */
  readonly music?: boolean
}

/**
 * The model catalogue.
 *
 * Planners come from the harness's own configuration (settings.yaml plus the
 * active profile patch), because that IS the list the harness shows; reading the
 * same files keeps the two in step without a second source of truth. Music
 * models come from the renderer itself (`/v1/models`), which is the only list
 * that knows what is actually installed on that box — XL shows up the day it
 * lands, with no change here.
 */
export async function readModelCatalogue(cfg: RadioConfig): Promise<{
  planners: readonly ModelChoice[]; music: readonly ModelChoice[]
}> {
  const planners: ModelChoice[] = []
  const script = `import json, os
out = []
def add(provider, mid, name):
    if mid:
        out.append({'provider': str(provider), 'id': str(mid), 'name': str(name or mid)})

def from_settings(path):
    try:
        import yaml
        docs = yaml.safe_load(open(path, encoding='utf-8')) or {}
    except Exception:
        return
    if not isinstance(docs, dict):
        return
    for key, val in docs.items():
        if not str(key).startswith('llm-') or not isinstance(val, dict):
            continue
        plugin = str(key)[4:]
        # Shape A (llm-pi-ai): named providers, each with its own model list.
        provs = val.get('providers')
        if isinstance(provs, dict):
            for pname, pconf in provs.items():
                if not isinstance(pconf, dict):
                    continue
                for m in pconf.get('models') or []:
                    if isinstance(m, dict):
                        add(pname, m.get('id'), m.get('displayName') or m.get('name') or pconf.get('displayName'))
        # Shape B (llm-deepseek): the plugin itself is the provider.
        for m in val.get('models') or []:
            if isinstance(m, dict):
                add(plugin, m.get('id'), m.get('name'))

def from_patch(path):
    try:
        import yaml
        docs = yaml.safe_load(open(path, encoding='utf-8')) or []
    except Exception:
        return
    if isinstance(docs, dict):
        docs = docs.get('insert', []) or []
    for row in docs if isinstance(docs, list) else []:
        if not isinstance(row, dict):
            continue
        rid = str(row.get('id', ''))
        if not rid.startswith('llm-'):
            continue
        for m in ((row.get('config') or {}).get('models') or []):
            if isinstance(m, dict):
                add(rid[4:], m.get('id'), m.get('name'))

from_settings(os.path.expanduser('~/.dsh/settings.yaml'))
from_patch(os.path.expanduser('~/.dsh/profiles/web/cordis.patch.yml'))
seen, uniq = set(), []
for m in out:
    k = m['provider'] + ':' + m['id']
    if k not in seen:
        seen.add(k)
        uniq.append(m)
print(json.dumps(uniq))
`
  try {
    const { execFile } = await import('node:child_process')
    const raw = await new Promise<string>((resolve, reject) => {
      execFile('python3', ['-c', script], { timeout: 8000 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
    const parsed = JSON.parse(raw) as ModelChoice[]
    planners.push(...parsed)
  } catch { /* no catalogue readable: the dropdown simply stays empty */ }

  // Music models come from the renderer, which is the only source that knows what
  // is installed there. Its /v1/models list is empty while the DiT is not
  // "initialized" through that endpoint, so /health's loaded_model is the reliable
  // entry point -- together they list exactly what can be asked for today, and XL
  // appears the day it is installed, with no change here.
  const music: ModelChoice[] = []
  const seenMusic = new Set<string>()
  const addMusic = (id: string): void => {
    if (id !== '' && !seenMusic.has(id)) { seenMusic.add(id); music.push({ provider: 'acestep', id, name: id, music: true }) }
  }
  try {
    const res = await fetch(`${cfg.aceBase}/v1/models`, {
      headers: cfg.aceKey === '' ? {} : { authorization: `Bearer ${cfg.aceKey}` },
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const body = await res.json() as { data?: unknown }
      for (const row of Array.isArray(body.data) ? body.data : []) {
        const item = row as { name?: string; id?: string }
        addMusic(String(item.name ?? item.id ?? ''))
      }
    }
  } catch { /* fall through to the health read below */ }
  try {
    const res = await fetch(`${cfg.aceBase}/health`, {
      headers: cfg.aceKey === '' ? {} : { authorization: `Bearer ${cfg.aceKey}` },
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const body = await res.json() as { data?: { loaded_model?: string } }
      addMusic(String(body.data?.loaded_model ?? ''))
    }
  } catch { /* renderer down: an empty music list is the honest answer */ }
  return { planners, music }
}

/** One sidecar JSON read, tolerant of a half-written file. */
async function readSidecar(path: string): Promise<Partial<RadioTrack>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Partial<RadioTrack>
  } catch {
    return {}
  }
}

/**
 * Scan the library. A track exists when its `.mp3` exists; its sidecar JSON is
 * optional (a file dropped in by hand still plays and can still be rated).
 */
export async function scanLibrary(dir: string): Promise<RadioTrack[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const tracks: RadioTrack[] = []
  for (const name of names) {
    if (!name.endsWith('.mp3')) continue
    const id = name.slice(0, -4)
    const full = join(dir, name)
    const meta = await readSidecar(join(dir, `${id}.json`))
    let bytes = 0
    let mtime = 0
    try {
      const info = await stat(full)
      bytes = info.size
      mtime = info.mtimeMs
    } catch { continue }
    tracks.push({
      id,
      title: meta.title ?? id,
      station: meta.station ?? 'unknown',
      seconds: meta.seconds ?? 0,
      bpm: meta.bpm ?? null,
      key: meta.key ?? null,
      lang: meta.lang ?? null,
      seed: meta.seed ?? null,
      caption: meta.caption ?? null,
      lyrics: meta.lyrics ?? null,
      stars: meta.stars ?? 0,
      never: meta.never ?? false,
      plays: meta.plays ?? 0,
      bytes,
      created: meta.created ?? new Date(mtime).toISOString(),
    })
  }
  tracks.sort((a, b) => (a.created < b.created ? 1 : -1))
  return tracks
}

/** Renderer health, read only — never starts or stops anything on that box. */
async function readHealth(cfg: RadioConfig): Promise<RadioHealth> {
  const down: RadioHealth = { up: false, model: null, jobs: null, avgSeconds: null }
  try {
    const res = await fetch(`${cfg.aceBase}/health`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { ...down, error: `HTTP ${res.status}` }
    const body = await res.json() as { data?: { loaded_model?: string } }
    type StatsBody = { data?: { jobs?: { succeeded?: number; total?: number }; avg_job_seconds?: number } }
    const stats = await fetch(`${cfg.aceBase}/v1/stats`, { signal: AbortSignal.timeout(2500) })
      .then(r => r.json() as Promise<StatsBody>)
      .catch((): StatsBody => ({}))
    return {
      up: true,
      model: body.data?.loaded_model ?? null,
      jobs: stats.data?.jobs?.total ?? null,
      avgSeconds: stats.data?.avg_job_seconds ?? null,
    }
  } catch (error) {
    return { ...down, error: String(error) }
  }
}

/** The payload the sidebar card and modal both render from. */
export async function readRadioState(cfg: RadioConfig): Promise<RadioPayload> {
  const [tracks, health] = await Promise.all([scanLibrary(cfg.library), readHealth(cfg)])
  const rated = tracks.filter(t => t.stars > 0)
  return {
    health,
    tracks: tracks.slice(0, 200),
    stats: {
      count: tracks.length,
      rated: rated.length,
      never: tracks.filter(t => t.never).length,
      starsAvg: rated.length === 0
        ? null
        : Math.round((rated.reduce((sum, t) => sum + t.stars, 0) / rated.length) * 10) / 10,
      bytes: tracks.reduce((sum, t) => sum + t.bytes, 0),
      stations: [...new Set(tracks.map(t => t.station))].filter(s => s !== 'unknown'),
    },
    stations: Object.keys(CAPTION_POOL),
    settings: { planner: cfg.planner, musicModel: cfg.musicModel },
  }
}

/** Deterministic-ish pick so a name pool is reused without repeating a title. */
function pick<T>(list: readonly T[], used: ReadonlySet<string>, keyOf: (item: T) => string): T {
  const free = list.filter(item => !used.has(keyOf(item)))
  const pool = free.length > 0 ? free : list
  return pool[Math.floor(Math.random() * pool.length)]!
}

/** Update a track's rating; `never` is a separate, stickier signal than low stars. */
export async function rateTrack(
  cfg: RadioConfig, id: string, patch: { stars?: number; never?: boolean; played?: boolean },
): Promise<RadioTrack[]> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad track id')
  const path = join(cfg.library, `${id}.json`)
  const meta = await readSidecar(path)
  const next: Record<string, unknown> = { ...meta }
  if (typeof patch.stars === 'number') next.stars = Math.max(0, Math.min(5, Math.round(patch.stars)))
  if (typeof patch.never === 'boolean') next.never = patch.never
  if (patch.played === true) next.plays = (meta.plays ?? 0) + 1
  await writeFile(path, JSON.stringify(next, null, 1), 'utf8')
  return scanLibrary(cfg.library)
}

/** POST one JSON request to the renderer and parse its envelope. */
async function acePost<T>(
  cfg: RadioConfig, path: string, body: unknown, timeoutMs: number,
): Promise<T> {
  const res = await fetch(`${cfg.aceBase}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.aceKey === '' ? {} : { authorization: `Bearer ${cfg.aceKey}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`renderer ${path} -> HTTP ${res.status}`)
  const parsed = await res.json() as { data?: T; error?: string | null }
  if (parsed.error) throw new Error(String(parsed.error))
  return parsed.data as T
}

/**
 * Ask the renderer for one track and file it in the library.
 *
 * The caption comes from the starter pool for the station (the owner's own
 * caption/lyric pools replace this later); the measured tempo/key returned by the
 * renderer is written into the sidecar so the card can show it and so a later
 * retraining pass knows what the track actually was.
 */
export async function generateTrack(
  cfg: RadioConfig, station: string, existing: readonly RadioTrack[],
): Promise<RadioTrack> {
  const captions = CAPTION_POOL[station]
  if (!captions) throw new Error(`unknown station ${station}`)
  const usedTitles = new Set(existing.map(t => t.title))
  const title = pick(TITLE_POOL[station] ?? ['Untitled'], usedTitles, t => t)
  const caption = captions[Math.floor(Math.random() * captions.length)]!
  const created = new Date().toISOString()
  const id = `${station}_${created.slice(0, 10)}_${Math.random().toString(36).slice(2, 8)}`

  // One tempo/key pick, used in BOTH homes: the caption text and the parameters.
  const tempo = STATION_TEMPO[station] ?? { bpm: [90, 120] as const, keys: ['A minor'] }
  const bpm = tempo.bpm[0] + Math.floor(Math.random() * (tempo.bpm[1] - tempo.bpm[0] + 1))
  const key = tempo.keys[Math.floor(Math.random() * tempo.keys.length)] ?? 'A minor'
  const captionWithTempo = `${caption}, ${bpm} bpm, ${key}`

  const submitted = await acePost<{ task_id: string }>(cfg, '/release_task', {
    prompt: captionWithTempo,
    lyrics: '[Instrumental]',
    thinking: false,
    inference_steps: 8,
    batch_size: 1,
    audio_duration: cfg.duration,
    bpm,
    key_scale: key,
    time_signature: '4',
    use_random_seed: true,
    // Selected renderer model, when the owner picked one from the renderer's own list.
    ...(cfg.musicModel === '' ? {} : { model: cfg.musicModel }),
  }, 60_000)

  const deadline = Date.now() + 180_000
  let file: string | null = null
  let metas: Record<string, unknown> = {}
  let seed: string | null = null
  while (Date.now() < deadline) {
    const rows = await acePost<ReadonlyArray<{ status: number; result?: string }>>(
      cfg, '/query_result', { task_id_list: [submitted.task_id] }, 60_000)
    const row = rows[0]
    if (row && row.status !== 0) {
      if (row.status !== 1) throw new Error('render failed')
      const parsed = JSON.parse(row.result ?? '[{}]') as ReadonlyArray<{
        file?: string; metas?: Record<string, unknown>; seed_value?: string
      }>
      file = parsed[0]?.file ?? null
      metas = parsed[0]?.metas ?? {}
      seed = parsed[0]?.seed_value ?? null
      break
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  if (file === null) throw new Error('render timed out')

  const audio = await fetch(`${cfg.aceBase}${file}`, {
    headers: cfg.aceKey === '' ? {} : { authorization: `Bearer ${cfg.aceKey}` },
    signal: AbortSignal.timeout(120_000),
  })
  if (!audio.ok) throw new Error(`renderer audio -> HTTP ${audio.status}`)
  const bytes = Buffer.from(await audio.arrayBuffer())
  await writeFile(join(cfg.library, `${id}.mp3`), bytes)

  const track: RadioTrack = {
    id, title, station, seconds: cfg.duration,
    bpm: typeof metas.bpm === 'number' ? metas.bpm : bpm,
    key: typeof metas.keyscale === 'string' ? metas.keyscale : key,
    lang: null, seed, caption: captionWithTempo, lyrics: '[Instrumental]',
    stars: 0, never: false, plays: 0, bytes: bytes.length, created,
  }
  await writeFile(join(cfg.library, `${id}.json`), JSON.stringify(track, null, 1), 'utf8')
  return track
}

/**
 * Stream one library file with byte-range support, because a radio you cannot
 * scrub is not a radio. Ranges are answered inline; anything else gets the whole
 * file. The path is validated to a `<id>.mp3` shape so a crafted request cannot
 * walk out of the library directory.
 */
export function serveAudio(
  req: IncomingMessage, res: ServerResponse, dir: string, id: string,
): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('bad id')
    return
  }
  const path = join(dir, `${id}.mp3`)
  void stat(path).then(info => {
    const range = req.headers.range
    const head = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
    if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) {
      const [startRaw, endRaw] = range.replace('bytes=', '').split('-')
      const start = startRaw === '' ? Math.max(0, info.size - Number(endRaw)) : Number(startRaw)
      const end = endRaw === '' || startRaw === '' ? info.size - 1 : Math.min(Number(endRaw), info.size - 1)
      if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` })
        res.end()
        return
      }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 })
      createReadStream(path, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { ...head, 'content-length': info.size })
    createReadStream(path).pipe(res)
  }).catch(() => {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
}

/** Read a JSON request body with a hard size ceiling. */
export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 64_000) throw new Error('body too large')
    chunks.push(buf)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

