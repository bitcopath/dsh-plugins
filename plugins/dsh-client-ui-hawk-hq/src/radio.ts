/**
 * Hawk Radio — host half.
 *
 * Owns everything the sidebar card cannot do from the browser: the on-disk
 * library, the ratings that later feed adapter retraining, and the calls to the
 * ACE-Step renderer, wherever it runs.
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
 *   - Two folders, one pipeline (owner's rule, 2026-09-17): the LIVE folder
 *     (`library`) is what the radio rotates and sweeps, and the RESERVED folder
 *     (`starred`) holds what the owner starred. Starring copies the song out of
 *     the live pipeline rather than rating it, so the live copy dies on the next
 *     sweep and the reserved copy is the one that survives.
 */

import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RadioHealth, RadioPayload, RadioTrack } from './wire.ts'

/** Where the owner's settings for this plugin live (never inside the repo). */
export const RADIO_CONFIG = join(homedir(), '.config', 'hawk-radio', 'config.json')

/** Default library location; overridden by the config file. */
const DEFAULT_LIBRARY = join(homedir(), '.local', 'share', 'hawk-radio', 'library')

/** The reserved folder, derived the same way from an overridden library. */
function defaultStarredDir(library: string): string {
  return join(dirname(library), 'starred')
}

/** Renderer default: ACE-Step on the same machine. Point this at whichever host runs it
 *  (the config file's `aceBase`, or HAWK_RADIO_ACE_BASE) — the two-machine layout is ours,
 *  not a requirement. */
const DEFAULT_ACE_BASE = 'http://127.0.0.1:8001'

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

/**
 * Song-length bands per station, in seconds.
 *
 * Researched 2026-09-17 (`docs/06-song-length-research.md`): the mainstream band is two to
 * five minutes (nearly 90% of streaming activity), and each genre clusters around its own
 * centre — punk near 3:22, hard rock near 4:35, thrash near 4:57, progressive rock near 5:21.
 * A single global band would therefore be wrong for exactly the genres this radio plays.
 *
 * Rows marked "estimate" have no published survey row behind them; they are extrapolated from
 * neighbouring genres and are labelled rather than dressed up as data.
 */
const STATION_LENGTH: Readonly<Record<string, readonly [number, number]>> = {
  // classic rock 4:17 / hard rock 4:35 / metal 4:28 / thrash 4:57
  'rock-classic-metal': [210, 330],
  // pop 3:40 / dance pop 3:49 / disco 4:21 / house 4:07
  'dance-pop': [165, 255],
  // hip hop 3:52 / rap 3:33 / gangster rap 3:57
  'hiphop-90s': [180, 255],
  // 45 RPM singles of the era ran about 2:00-2:30; the survey has no rockabilly row (estimate)
  'rocknroll-50s-rnb': [120, 195],
  // Anatolian rock has no survey row; rock 4:12 and folk 3:46 bracket it (estimate)
  'turkish-anatolian': [180, 300],
  // turku/saz material is folk 3:46 leaning long (estimate)
  'turkish-folk-acoustic': [180, 300],
  // vocal jazz 3:24 / jazz 3:47
  'jazz-vocal-standards': [150, 240],
  // flamenco 3:32 / latin and son lean long (estimate)
  'latin-rumba-son': [180, 270],
  // pop 3:40 with ballad outliers (estimate)
  'melodic-pop-multilingual': [180, 255],
  // classical 3:40 / orchestral 3:11, but concert pieces vary enormously (estimate)
  'classical-operatic': [180, 360],
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
  /**
   * The reserved folder: songs the owner starred are copied here and leave the live
   * pipeline (owner's rule, 2026-09-17). Defaults to the sibling `starred/` of `library`,
   * so an existing install needs no config edit. Created on demand — it may not exist yet.
   */
  readonly starred: string
  readonly aceBase: string
  readonly aceKey: string
  /** Seconds per generated track. */
  readonly duration: number
  /** Selected planner model ("provider:model"), persisted so the choice sticks. */
  readonly planner: string
  /** Selected renderer model id (ACE-Step); empty means the server default. */
  readonly musicModel: string
  /** Base URL of the LAN share service; empty disables the Share action. */
  readonly shareBase: string
  /** The share service's secret; never in this repository, always in the config file. */
  readonly shareSecret: string
  /**
   * Optional GLOBAL length override. 0/0 means "use the station's own band" (STATION_LENGTH),
   * which is the default: the owner's rule is that the planner picks inside a band, and the
   * research says the band differs by genre (punk 3:22 vs progressive rock 5:21).
   */
  readonly durationMin: number
  readonly durationMax: number
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
  const library = pick('HAWK_RADIO_LIBRARY', 'library', DEFAULT_LIBRARY)
  return {
    library,
    starred: pick('HAWK_RADIO_STARRED', 'starred', defaultStarredDir(library)),
    aceBase: pick('HAWK_RADIO_ACE_BASE', 'aceBase', DEFAULT_ACE_BASE).replace(/\/+$/, ''),
    aceKey: pick('HAWK_RADIO_ACE_KEY', 'aceKey', ''),
    duration: Number.isFinite(dur) && dur >= 10 && dur <= 600 ? dur : 60,
    planner: pick('HAWK_RADIO_PLANNER', 'planner', ''),
    musicModel: pick('HAWK_RADIO_MUSIC_MODEL', 'musicModel', ''),
    shareBase: pick('HAWK_RADIO_SHARE_BASE', 'shareBase', '').replace(/\/+$/, ''),
    shareSecret: pick('HAWK_RADIO_SHARE_SECRET', 'shareSecret', ''),
    ...(() => {
      const clamp = (v: unknown, fallback: number, allowZero = false): number => {
        const n = Number(v)
        if (allowZero && n === 0) return 0
        return Number.isFinite(n) && n >= 10 && n <= 600 ? Math.round(n) : fallback
      }
      // 0 means "no override" -- the station band applies instead.
      const min = clamp(process.env.HAWK_RADIO_DURATION_MIN ?? file.durationMin, 0, true)
      const max = clamp(process.env.HAWK_RADIO_DURATION_MAX ?? file.durationMax, 0, true)
      if (min === 0 || max === 0) return { durationMin: 0, durationMax: 0 }
      // A band is only a band if it is the right way round; swap rather than refuse.
      return min <= max ? { durationMin: min, durationMax: max } : { durationMin: max, durationMax: min }
    })(),
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
 * They live in the same 0600 file as the renderer key, outside the repository:
 * the choice is per-machine, and nothing about it belongs in public source.
 */
export async function saveRadioSettings(
  patch: { planner?: string; musicModel?: string; durationMin?: number; durationMax?: number },
): Promise<void> {
  const file = await readConfigFile()
  if (typeof patch.planner === 'string') file.planner = patch.planner
  if (typeof patch.musicModel === 'string') file.musicModel = patch.musicModel
  for (const key of ['durationMin', 'durationMax'] as const) {
    const value = patch[key]
    if (typeof value === 'number') {
      const rounded = Math.round(value)
      if (rounded >= 10 && rounded <= 600) file[key] = rounded
    }
  }
  // Keep the band ordered whatever the two calls arrived in.
  const lo = Number(file.durationMin ?? 90)
  const hi = Number(file.durationMax ?? 210)
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) {
    file.durationMin = hi
    file.durationMax = lo
  }
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
export async function readModelCatalogue(cfg: RadioConfig, llm: LlmFace | null = null): Promise<{
  planners: readonly ModelChoice[]; music: readonly ModelChoice[]
}> {
  const planners: ModelChoice[] = []

  // Preferred source: the harness itself. Its provider ids are NOT derivable from the config
  // keys (the `llm-deepseek` key registers the route "deepseek-official"), and guessing produced
  // a planner that silently fell back to the pools.
  if (llm !== null && typeof llm.listModels === 'function') {
    try {
      const rawProviders = (typeof llm.listConfigurableProviders === 'function'
        ? await Promise.resolve(llm.listConfigurableProviders())
        : (typeof llm.listProviders === 'function' ? await Promise.resolve(llm.listProviders()) : []))
      const list = Array.isArray(rawProviders) ? rawProviders : []
      for (const entry of list) {
        const provider = typeof entry === 'string'
          ? entry
          : String((entry as { id?: string; name?: string; provider?: string }).id
            ?? (entry as { name?: string }).name
            ?? (entry as { provider?: string }).provider ?? '')
        if (provider === '') continue
        try {
          const models = await llm.listModels(provider)
          for (const model of Array.isArray(models) ? models : []) {
            const id = typeof model === 'string' ? model : String((model as { id?: string }).id ?? '')
            const name = typeof model === 'string'
              ? model
              : String((model as { name?: string }).name ?? id)
            if (id !== '') planners.push({ provider, id, name })
          }
        } catch { /* one unreadable provider must not empty the whole list */ }
      }
    } catch { /* fall through to the config parse below */ }
  }
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
    if (planners.length === 0) {
      const parsed = JSON.parse(raw) as ModelChoice[]
      // The config key is not always the route name: the `llm-deepseek` key registers the
      // provider "deepseek-official" (evidence: agent-default-model and the failover chain).
      const alias: Readonly<Record<string, string>> = { deepseek: 'deepseek-official' }
      planners.push(...parsed.map(m => ({ ...m, provider: alias[m.provider] ?? m.provider })))
    }
  } catch { /* no catalogue readable: the dropdown simply stays empty */ }

  // Music models come from the renderer, which is the only source that knows what
  // is installed there. Its /v1/models list is empty while the DiT is not
  // "initialized" through that endpoint, so /health's loaded_model is the reliable
  // entry point -- together they list exactly what can be asked for today, and XL
  // appears the day it is installed, with no change here.
  const music: ModelChoice[] = []
  const seenMusic = new Set<string>()
  // Key on the model id and use the id as the value: the renderer reports a display name
  // ("ACE-Step acestep-v15-turbo") while /health reports the id ("acestep-v15-turbo"), and
  // deduping on the display string listed the same model twice (seen 2026-09-17).
  // The two endpoints disagree about the id itself, not just the label: /v1/models answers an
  // OpenRouter-style "acestep/acestep-v15-turbo" while /health answers the bare
  // "acestep-v15-turbo" the renderer actually wants in `model`. Canonicalise to the bare id so
  // one model cannot appear twice, and so the value we send back is the one it accepts.
  const bareId = (value: string): string => {
    const trimmed = value.trim()
    const cut = trimmed.lastIndexOf('/')
    return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  }
  const addMusic = (id: string, name?: string): void => {
    const key = bareId(id)
    if (key !== '' && !seenMusic.has(key)) {
      seenMusic.add(key)
      music.push({ provider: 'acestep', id: key, name: (name ?? key).trim(), music: true })
    }
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
        addMusic(String(item.id ?? item.name ?? ''), String(item.name ?? ''))
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

/**
 * The planner: the text model that writes a song before the renderer makes it.
 *
 * The call goes through the harness's own LLM service rather than dialling a
 * provider here, because provider keys live in the harness's sealed credential
 * store and provider base URLs belong to the provider plugins. Asking the
 * harness means the radio can use ANY model the user has configured — which is
 * the point: this plugin ships open source, and the user's own model list is the
 * source of truth.
 *
 * Everything about this is best-effort by design: if the service is absent, the
 * model refuses, or the JSON does not parse, the caller falls back to the
 * built-in station pools, so the radio never stops playing because a planner
 * misbehaved.
 */

/** The slice of the harness LLM service this plugin uses. */
export interface LlmFace {
  /** Provider routes the harness has registered (the only source of the real ids). */
  listProviders?(): unknown
  /** Configurable providers, when the harness distinguishes them. */
  listConfigurableProviders?(): unknown
  /** Models for one provider route. */
  listModels?(provider: string): Promise<unknown>
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly system?: string
    readonly messages: readonly unknown[]
    readonly temperature?: number
    readonly maxTokens?: number
  }): AsyncIterable<{ readonly type?: string; readonly text?: string }>
}

/** One song as the planner wrote it. */
export interface PlannedSong {
  readonly title: string
  /** Length in seconds as the planner judged it; the caller clamps it. */
  readonly seconds: number
  readonly caption: string
  readonly lyrics: string
  readonly bpm: number
  readonly key: string
  readonly lang: string
}

/** The instruction the planner is held to. */
function plannerPrompt(
  station: string, avoid: readonly string[], min: number, max: number,
): { system: string; user: string } {
  const system = [
    'You are a music producer writing ONE new song for a personal radio station.',
    'Answer with a single JSON object and nothing else. No prose, no code fences.',
    'Fields: title (short, evocative, the station\'s language), caption (a comma-separated',
    'production description: genre, instruments, mood, vocal type, production era — never an',
    'artist name and never a conflicting pair like "lo-fi, hi-fi"), seconds (the length this',
    `song wants, between ${min} and ${max} seconds inclusive -- a punk track is shorter than a`,
    'ballad, so choose per song and stay inside that band), lyrics (with [Verse], [Chorus] and',
    '[Bridge] tags, written out in the order they are sung, and long enough to carry the whole',
    'song you just chose: about one section per 40 seconds of it, so a 4-minute song wants',
    'roughly 6 sections and 25-35 short lines, and every [Chorus] is written out again in full',
    'rather than referred to. Too few lines is the fault to avoid here, because every second the',
    'lyrics do not cover plays with no words at all. If the station is instrumental use exactly',
    '[Instrumental]), bpm (integer 30-300), key (e.g. "D minor"), lang (ISO code, "none" if',
    'instrumental). Write original words; never quote an existing song.',
  ].join(' ')
  const user = [
    `Station: ${station}.`,
    avoid.length > 0 ? `Do not reuse these titles: ${avoid.slice(0, 30).join(', ')}.` : '',
    'Return the JSON object now.',
  ].filter(line => line !== '').join(' ')
  return { system, user }
}

/**
 * Pull one song out of a model answer, tolerating the ways a real answer differs from JSON.
 *
 * Measured 2026-09-17: the same call returned usable JSON for English stations and failed for
 * turkish-anatolian four times out of four -- Turkish lyrics are longer, so the answer is longer
 * and the failure is either truncation or a raw control character inside a string. Both make
 * `JSON.parse` throw, and the old single-attempt parse treated that as "the planner said nothing".
 *
 * Stage 1 strict JSON, stage 2 repair (escape raw control chars, close a truncated document),
 * stage 3 field-wise extraction. `lastPlannerError` records which stage won, so the next failure
 * of this kind is readable instead of silent.
 */
export function parsePlannedSong(text: string): PlannedSong | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text

  const finish = (raw: unknown): PlannedSong | null => {
    const bag = raw as Record<string, unknown>
    const title = typeof bag.title === 'string' ? bag.title.trim() : ''
    const caption = typeof bag.caption === 'string' ? bag.caption.trim() : ''
    const lyrics = typeof bag.lyrics === 'string' ? bag.lyrics.trim() : ''
    if (title === '' || caption === '' || lyrics === '') return null
    const secondsRaw = Number(bag.seconds)
    const bpmRaw = Number(bag.bpm)
    return {
      title: title.slice(0, 80),
      caption: caption.slice(0, 600),
      lyrics: lyrics.slice(0, 4000),
      seconds: Number.isFinite(secondsRaw) ? Math.round(secondsRaw) : 0,
      bpm: Number.isFinite(bpmRaw) ? Math.min(300, Math.max(30, Math.round(bpmRaw))) : 100,
      key: typeof bag.key === 'string' && bag.key.trim() !== '' ? bag.key.trim().slice(0, 24) : 'A minor',
      lang: typeof bag.lang === 'string' && bag.lang.trim() !== '' ? bag.lang.trim().slice(0, 8) : 'en',
    }
  }

  // Stage 1 — the answer was clean JSON.
  try {
    return finish(JSON.parse(candidate))
  } catch { /* fall through */ }

  // Stage 2 — repair: escape raw newlines/tabs that sit inside string literals, and close an
  // answer that was truncated mid-string (append the missing quote and brace).
  try {
    let inString = false
    let escaped = false
    let out = ''
    for (const ch of candidate) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') { inString = !inString; out += ch; continue }
      if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) { out += ch === '\t' ? '\\t' : '\\n'; continue }
      out += ch
    }
    if (inString) out += '"'
    const opens = (out.match(/\{/g) ?? []).length
    const closes = (out.match(/\}/g) ?? []).length
    out += '}'.repeat(Math.max(0, opens - closes))
    const repaired = finish(JSON.parse(out))
    if (repaired !== null) {
      lastPlannerError = 'recovered by repairing the JSON (raw newlines or a truncated answer)'
      return repaired
    }
  } catch { /* fall through */ }

  // Stage 3 — field-wise: take each string field up to the next field or the closing brace.
  const grab = (key: string): string | null => {
    const m = new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,|\\})`).exec(candidate)
    return m === null ? null : m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
  }
  const loose = finish({
    title: grab('title') ?? '', caption: grab('caption') ?? '', lyrics: grab('lyrics') ?? '',
    seconds: Number(grab('seconds') ?? 0), bpm: Number(grab('bpm') ?? 0),
    key: grab('key') ?? '', lang: grab('lang') ?? '',
  })
  if (loose !== null) {
    lastPlannerError = 'recovered by field-wise extraction (the answer was not valid JSON)'
    return loose
  }
  lastPlannerError = `could not read a song from the answer (${String(text).slice(0, 120)})`
  return null
}

/**
 * Ask the planner for one song. Returns null on every failure path, which is the
 * caller's signal to use the station's own pool instead.
 */
export async function planSong(
  cfg: RadioConfig, station: string, avoid: readonly string[], llm: LlmFace | null,
): Promise<PlannedSong | null> {
  if (llm === null || cfg.planner === '') return null
  const [provider, ...rest] = cfg.planner.split(':')
  const model = rest.join(':')
  if (!provider || model === '') return null
  const [pMin, pMax] = cfg.durationMin > 0 && cfg.durationMax > 0
    ? [cfg.durationMin, cfg.durationMax]
    : (STATION_LENGTH[station] ?? [180, 270])
  const { system, user } = plannerPrompt(station, avoid, pMin, pMax)
  // Two attempts: the measured turkish failures were transient drops, and falling straight to the
  // station pool made a flaky call look like a missing feature.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const planned = await planOnce(provider, model, system, user, llm)
    if (planned !== null) return planned
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return null
}

/** One planner attempt; records the reason on failure so the fallback is never silent. */
async function planOnce(
  provider: string, model: string, system: string, user: string, llm: LlmFace,
): Promise<PlannedSong | null> {
  try {
    let text = ''
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.9,
      // 2600, not 2000: the prompt now asks for a full song's worth of lyrics (~25-35 lines),
      // and the one measured truncation failure (turkish-anatolian, 2026-09-17) was the answer
      // outgrowing its budget. Output tokens are only paid when they are generated.
      maxTokens: 2600,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (text.length > 20_000) break
    }
    const planned = parsePlannedSong(text)
    lastPlannerError = planned === null
      ? `model answered but the JSON did not parse (${String(text).slice(0, 80)})`
      : null
    return planned
  } catch (error) {
    lastPlannerError = `${provider}:${model} — ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
    return null
  }
}

/**
 * Why the last planner attempt failed, or null. The radio falls back to its station pools on
 * failure so playback never stops, and that fallback must not be silent: this is carried in the
 * payload so the card can say "planner failed: unknown provider" instead of quietly producing
 * instrumental songs (the bug of 2026-09-17).
 */
let lastPlannerError: string | null = null

/** Cached catalogue, so a 15s poll does not shell out to read the config every time. */
let catalogueCache: { at: number; value: Awaited<ReturnType<typeof readModelCatalogue>> } | null = null

/** The model catalogue, cached for a minute. */
export async function catalogueFor(
  cfg: RadioConfig, llm: LlmFace | null = null,
): Promise<Awaited<ReturnType<typeof readModelCatalogue>>> {
  if (catalogueCache !== null && Date.now() - catalogueCache.at < 60_000) return catalogueCache.value
  const value = await readModelCatalogue(cfg, llm)
  catalogueCache = { at: Date.now(), value }
  return value
}

/**
 * The planner actually used when the owner has not chosen one yet: a cloud model
 * they already configured, preferring DeepSeek (the house default), then any
 * non-local provider, then anything at all. Never invents a model that the user
 * does not have.
 */
export async function effectivePlanner(cfg: RadioConfig, llm: LlmFace | null = null): Promise<string> {
  if (cfg.planner !== '') return cfg.planner
  const { planners } = await catalogueFor(cfg, llm)
  const pickFirst = (test: (p: string) => boolean): string | null => {
    const hit = planners.find(m => test(m.provider))
    return hit === undefined ? null : `${hit.provider}:${hit.id}`
  }
  // The harness's own route name is "deepseek-official"; accept any deepseek-ish id so a
  // renamed route does not silently disable the planner again.
  return pickFirst(p => p.includes('deepseek'))
    ?? pickFirst(p => p !== 'local-qwen' && p !== 'acestep')
    ?? (planners[0] === undefined ? '' : `${planners[0].provider}:${planners[0].id}`)
}

/** The share service, and the secret the radio authenticates with. */
export interface ShareConfig {
  /** Base URL of the LAN share service; empty disables sharing. */
  readonly shareBase: string
  /** Shared secret; empty means the service refuses every write. */
  readonly shareSecret: string
}

/**
 * Publish one song and return its link.
 *
 * Two steps on purpose: metadata first (which mints the token), then the audio. The service keeps
 * one token per song, so sharing twice returns the existing link instead of littering tokens.
 */
export async function shareTrack(cfg: RadioConfig, share: ShareConfig, id: string): Promise<string> {
  if (share.shareBase === '') throw new Error('sharing is not configured (shareBase)')
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad track id')
  // A reserved song is deliberately absent from the live folder, so both folders are searched:
  // sharing from the Starred list must upload the RESERVED copy (verified 2026-09-17).
  const sidecar = await filePathFor(cfg, id, '.json')
  const meta = await readSidecar(sidecar.path) as Partial<RadioTrack> & { shareUrl?: string }
  const audio = await filePathFor(cfg, id, '.mp3')
  if (!audio.present) throw new Error('no audio for that song')

  // Already shared: reuse the link so the owner never accumulates dead tokens.
  if (typeof meta.shareUrl === 'string' && meta.shareUrl !== '') {
    const token = meta.shareUrl.split('/s/')[1] ?? ''
    const alive = await fetch(`${share.shareBase}/s/${token}`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.ok).catch(() => false)
    if (alive) return meta.shareUrl
  }

  const headers = { 'content-type': 'application/json', 'x-share-secret': share.shareSecret }
  const created = await fetch(`${share.shareBase}/api/share`, {
    method: 'POST', headers,
    body: JSON.stringify({
      title: meta.title ?? id, station: meta.station ?? '', bpm: meta.bpm ?? null, key: meta.key ?? null,
      lang: meta.lang ?? null, seconds: meta.seconds ?? 0, caption: meta.caption ?? null,
      lyrics: meta.lyrics ?? null, id,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!created.ok) throw new Error(`share service refused the metadata (HTTP ${created.status})`)
  const { token, url } = await created.json() as { token: string; url: string }

  const bytes = await readFile(audio.path)
  const uploaded = await fetch(`${share.shareBase}/api/share/${token}/audio`, {
    method: 'PUT', headers: { 'content-type': 'audio/mpeg', 'x-share-secret': share.shareSecret },
    body: bytes, signal: AbortSignal.timeout(60_000),
  })
  if (!uploaded.ok) throw new Error(`share service refused the audio (HTTP ${uploaded.status})`)

  // The link is recorded in the sidecar that actually exists — the reserved one for a reserved song.
  await writeFile(sidecar.path, JSON.stringify({ ...meta, shareUrl: url }, null, 1), 'utf8')
  return url
}

/** Kill a link: the service deletes the files, and we forget the URL. */
export async function revokeTrack(cfg: RadioConfig, share: ShareConfig, id: string): Promise<void> {
  if (share.shareBase === '') throw new Error('sharing is not configured')
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad track id')
  const path = (await filePathFor(cfg, id, '.json')).path
  const meta = await readSidecar(path) as Partial<RadioTrack> & { shareUrl?: string }
  const token = typeof meta.shareUrl === 'string' ? (meta.shareUrl.split('/s/')[1] ?? '') : ''
  if (token !== '') {
    await fetch(`${share.shareBase}/api/revoke/${token}`, {
      method: 'POST', headers: { 'x-share-secret': share.shareSecret }, signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
  }
  const next = { ...meta }
  delete next.shareUrl
  await writeFile(path, JSON.stringify(next, null, 1), 'utf8')
}

/**
 * Renders in flight, per station.
 *
 * The owner asked for a 5-second lockout on the On-Air button so a misclick cannot flip it twice.
 * That protects the UI; this protects the renderer as well, because a bypassed or double-fired
 * request must not queue two songs.
 */
const rendering = new Set<string>()

/** True when a render for this station is already running. */
export function isRendering(station: string): boolean {
  return rendering.has(station)
}

/** Run one render for a station, refusing to start a second one concurrently. */
export async function renderOnce<T>(station: string, work: () => Promise<T>): Promise<T> {
  if (rendering.has(station)) throw new Error(`already writing a song for ${station}`)
  rendering.add(station)
  try {
    return await work()
  } finally {
    rendering.delete(station)
  }
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
 * Where one track's audio actually lives, and whether it is there at all.
 *
 * The reserved folder is searched first: a starred song has (or is about to have) its live
 * copy swept, so the reserved copy is the authoritative one. Callers that must not throw on
 * a missing file (the audio route) branch on `present` instead.
 */
async function filePathFor(
  cfg: RadioConfig, id: string, ext: string,
): Promise<{ readonly path: string; readonly present: boolean }> {
  const reserved = join(cfg.starred, `${id}${ext}`)
  if ((await stat(reserved).catch(() => null)) !== null) return { path: reserved, present: true }
  const live = join(cfg.library, `${id}${ext}`)
  if ((await stat(live).catch(() => null)) !== null) return { path: live, present: true }
  return { path: live, present: false }
}

/** Create a folder on first use — the reserved one does not exist on an older install. */
async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    // Two concurrent reservations can race here; an existing folder is success, not failure.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Star means RESERVE, not rate (owner's rule, 2026-09-17 — his words: *"when I star a song that is
 * being played it is copied to /radio/starred, and when that song finishes it will be deleted from
 * /radio/live … Radio looks at live, our list looks at starred"*).
 *
 * The reserved copy is a full copy — same audio bytes, same metadata (title, station, seconds, bpm,
 * key, lang, seed, caption, lyrics, created, and the share link if one exists), with `stars: 1` as
 * the marker that this is a keeper rather than a rated song.
 *
 * The live copy is NOT deleted here: it is only marked `stars: 1` so the rotation drops it on the
 * next poll, and the existing sweep removes it when the song ends or the owner goes off air. Deleting
 * it here would cut off the song that is playing right now.
 */
export async function reserveTrack(cfg: RadioConfig, id: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad track id')
  const source = await filePathFor(cfg, id, '.mp3')
  if (!source.present) throw new Error('no audio for that song')
  await ensureDir(cfg.starred)

  // The sidecar is optional by design (a file dropped in by hand still plays), and a reserved copy
  // without one would lose its title — so the live sidecar wins, the reserved one is the fallback
  // when the live copy was already swept, and the id stands in when there is neither.
  const liveMeta = await readSidecar(join(cfg.library, `${id}.json`))
  const meta = Object.keys(liveMeta).length > 0
    ? liveMeta
    : await readSidecar(join(cfg.starred, `${id}.json`))
  const reserved: Record<string, unknown> = { ...meta, id, stars: 1 }

  await copyFile(source.path, join(cfg.starred, `${id}.mp3`))
  await writeFile(join(cfg.starred, `${id}.json`), JSON.stringify(reserved, null, 1), 'utf8')

  // Mark the LIVE copy too, when it is there: that is what takes the song out of the rotation.
  try {
    const liveMeta = await readSidecar(join(cfg.library, `${id}.json`))
    await writeFile(join(cfg.library, `${id}.json`),
      JSON.stringify({ ...liveMeta, stars: 1 }, null, 1), 'utf8')
  } catch { /* no live copy left (already swept): the reservation stands on its own */ }
  return id
}

/**
 * Unstar: delete the reserved copy.
 *
 * There is no reserved-copy-to-live-copy move, and that is deliberate: the live pipeline's whole
 * rule is "listened and gone", so a song that comes back would be a song the radio never played.
 * Unstarring is therefore how a reservation is undone — the way to get rid of a song, which is what
 * the star toggle has always meant. It is a real delete, so the route refuses an empty id and only
 * ever touches `<starred>/<id>.(mp3|json)`.
 */
export async function unstarTrack(cfg: RadioConfig, id: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('bad track id')
  for (const ext of ['.json', '.mp3']) {
    try {
      await unlink(join(cfg.starred, `${id}${ext}`))
    } catch { /* already gone is the desired end state */ }
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
      radio: meta.radio ?? false,
      shareUrl: meta.shareUrl,
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
  const [tracks, starred, health] = await Promise.all([
    scanLibrary(cfg.library), scanLibrary(cfg.starred), readHealth(cfg),
  ])
  const rated = tracks.filter(t => t.stars > 0)
  return {
    health,
    tracks: tracks.slice(0, 200),
    // The reserved folder is its own list: what the radio plays and what the owner keeps are two
    // different questions, and the modal's "Starred · N" is answered by this one (owner's rule).
    starred: starred.slice(0, 200),
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
    plannerError: lastPlannerError,
    settings: {
      planner: await effectivePlanner(cfg),
      musicModel: cfg.musicModel,
      durationMin: cfg.durationMin,
      durationMax: cfg.durationMax,
    },
  }
}

/** Deterministic-ish pick so a name pool is reused without repeating a title. */
function pick<T>(list: readonly T[], used: ReadonlySet<string>, keyOf: (item: T) => string): T {
  const free = list.filter(item => !used.has(keyOf(item)))
  const pool = free.length > 0 ? free : list
  return pool[Math.floor(Math.random() * pool.length)]!
}

/**
 * Radio means radio: you listen to it and it is gone (owner's rule, 2026-09-17).
 *
 * Delete every song the radio itself wrote, except the ids in `keep` — normally the one that is
 * playing right now. There is no longer a rating exemption: since a star copies the song into the
 * reserved folder FIRST (`reserveTrack`), the reserved folder is the survivor and the live copy is
 * free to go. Measured consequence of the old `stars >= 1` exemption: a starred song sat in the live
 * folder for ever, which is exactly what the owner asked to stop ("get it out of the radio live
 * pipeline").
 *
 * Failure is silent by design: a song that will not delete is a song that stays, and that must never
 * break playback. A render in flight is skipped by construction — the renderer writes the mp3 first
 * and the sidecar last, and this function only ever looks at sidecars.
 */
export async function pruneUnstarred(cfg: RadioConfig, keep: readonly string[] = []): Promise<string[]> {
  const keepSet = new Set(keep)
  const removed: string[] = []
  let entries: string[]
  try {
    entries = await readdir(cfg.library)
  } catch {
    return removed
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (keepSet.has(id)) continue
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(await readFile(join(cfg.library, name), 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    if (meta.radio !== true) continue
    for (const ext of ['.json', '.mp3']) {
      try {
        await unlink(join(cfg.library, id + ext))
      } catch { /* already gone */ }
    }
    removed.push(id)
  }
  return removed
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
  cfg: RadioConfig, station: string, existing: readonly RadioTrack[], llm: LlmFace | null = null,
): Promise<RadioTrack> {
  const captions = CAPTION_POOL[station]
  if (!captions) throw new Error(`unknown station ${station}`)
  const usedTitles = new Set(existing.map(t => t.title))
  // The planner writes a fresh song when one is configured; the station pool is the
  // fallback, so a missing/failing planner degrades instead of breaking playback.
  const planned = await planSong(cfg, station, [...usedTitles], llm)
  const title = planned?.title ?? pick(TITLE_POOL[station] ?? ['Untitled'], usedTitles, t => t)
  const caption = planned?.caption ?? captions[Math.floor(Math.random() * captions.length)]!
  const created = new Date().toISOString()
  const id = `${station}_${created.slice(0, 10)}_${Math.random().toString(36).slice(2, 8)}`

  // One tempo/key pick, used in BOTH homes: the caption text and the parameters.
  const tempo = STATION_TEMPO[station] ?? { bpm: [90, 120] as const, keys: ['A minor'] }
  const bpm = planned?.bpm
    ?? (tempo.bpm[0] + Math.floor(Math.random() * (tempo.bpm[1] - tempo.bpm[0] + 1)))
  const key = planned?.key ?? tempo.keys[Math.floor(Math.random() * tempo.keys.length)] ?? 'A minor'
  const lyrics = planned?.lyrics ?? '[Instrumental]'
  const captionWithTempo = `${caption}, ${bpm} bpm, ${key}`

  // Length: the planner chooses inside the owner's band; without a planner the band is still
  // honoured (a random point in it), so songs vary even while the planner is dormant.
  const [bandMin, bandMax] = cfg.durationMin > 0 && cfg.durationMax > 0
    ? [cfg.durationMin, cfg.durationMax]
    : (STATION_LENGTH[station] ?? [180, 270])
  const seconds = planned !== null && planned.seconds > 0
    ? Math.min(bandMax, Math.max(bandMin, planned.seconds))
    : bandMin + Math.floor(Math.random() * (bandMax - bandMin + 1))

  const submitted = await acePost<{ task_id: string }>(cfg, '/release_task', {
    prompt: captionWithTempo,
    lyrics,
    // The planner returns the song's language; without this the renderer defaults to "en"
    // and a Turkish lyric is sung with English phonetics (proven in our own 2026-09-15 test).
    vocal_language: planned?.lang ?? 'en',
    thinking: false,
    inference_steps: 8,
    batch_size: 1,
    audio_duration: seconds,
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
    id, title, station, seconds,
    bpm: typeof metas.bpm === 'number' ? metas.bpm : bpm,
    key: typeof metas.keyscale === 'string' ? metas.keyscale : key,
    lang: planned?.lang ?? null, seed, caption: captionWithTempo, lyrics,
    stars: 0, never: false, plays: 0, bytes: bytes.length, created,
    radio: true,
  }
  await writeFile(join(cfg.library, `${id}.json`), JSON.stringify(track, null, 1), 'utf8')
  return track
}

/**
 * Stream one library file with byte-range support, because a radio you cannot
 * scrub is not a radio. Ranges are answered inline; anything else gets the whole
 * file. The path is validated to a `<id>.mp3` shape so a crafted request cannot
 * walk out of the library directory.
 *
 * `dirs` are searched in order and the FIRST existing file wins, so the caller passes the reserved
 * folder before the live one: a starred song is served from `/starred`, which is the only place its
 * audio still exists once the live copy is swept.
 */
export function serveAudio(
  req: IncomingMessage, res: ServerResponse, dirs: string | readonly string[], id: string,
): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('bad id')
    return
  }
  const roots = typeof dirs === 'string' ? [dirs] : [...dirs]
  const find = async (): Promise<string | null> => {
    for (const dir of roots) {
      const candidate = join(dir, `${id}.mp3`)
      if ((await stat(candidate).catch(() => null)) !== null) return candidate
    }
    return null
  }
  void find().then(async found => {
    if (found === null) throw new Error('not found')
    const path = found
    const info = await stat(path)
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

