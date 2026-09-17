/**
 * Hawk Radio — browser half: the compact sidebar card, and the modal it opens.
 *
 * Shape follows the owner's decisions (2026-09-16):
 *   - the rail gets the smallest thing that is still a radio — play/pause, the
 *     song's name, where it is in the song — and the gear opens everything else
 *     in a modal, so the sidebar gains no permanent furniture;
 *   - two model pickers: a **Planner** (a text LLM that writes the caption,
 *     lyrics and metadata) and a **Music model** (the renderer that turns that
 *     into audio). Different jobs, never one list: a music model cannot write
 *     words and an LLM cannot make sound;
 *   - the play flow the owner asked for: pressing play goes live (a "going live"
 *     note covers the first render), and the next track is written when the
 *     current one enters its last 30 seconds, so the next song is always ready.
 *
 * It owns its own data (one GET, refreshed on a slow timer and after every
 * action) rather than riding the GPU widget's SSE stream: the radio must keep
 * working when the watchdog feed is down, and vice versa.
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent, ReactNode, SyntheticEvent } from 'react'
import type { RadioPayload } from '../wire.ts'
import { API, fmtGiB } from './util.ts'

/**
 * On-air generation, the owner's rule (2026-09-17): the moment a song starts playing, the one
 * after it starts being written. Exactly one song is ever in flight, and no maths about song
 * length, render time or queue depth is needed -- which is why this replaced a countdown
 * trigger: "we either need to calculate it and act accordingly etc but it will make a mess".
 */

/** `m:ss` for a duration in seconds. */
function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Five characters, filled to `n`. */
function starGlyphs(n: number): string {
  const filled = Math.max(0, Math.min(5, n))
  return '★'.repeat(filled) + '☆'.repeat(5 - filled)
}

/** One selectable model from the host's catalogue. */
interface ModelChoice {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly music?: boolean
}

/** POST one action; throws with a readable message so the card can show it. */
async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API}/radio/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error((await res.text()).slice(0, 160))
}

/**
 * The `sidebar.footer.action` radio card, rendered in the same seat occupant as
 * the GPU widget (above both GPU cards), because two occupants in that seat lay
 * out side by side instead of stacking.
 */
export function RadioBlock({ wide }: { readonly wide: boolean }): ReactNode {
  const audio = useRef<HTMLAudioElement | null>(null)
  /** Ids this browser session generated — the rotation fallback for an older host half. */
  const sessionWrites = useRef<Set<string>>(new Set())
  /**
   * True while the radio is meant to be ON AIR. Set from the audio element's own play/pause
   * events, so it stays true across a track change (a natural end fires `ended`, not `pause`)
   * and the next song starts by itself. Without this the radio went silent after every song.
   */
  const wantPlay = useRef(false)
  const [radio, setRadio] = useState<RadioPayload | null>(null)
  const [models, setModels] = useState<{ planners: readonly ModelChoice[]; music: readonly ModelChoice[] } | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [station, setStation] = useState('rock-classic-metal')
  const [goingLive, setGoingLive] = useState(false)

  // The client bundle is re-served on every page load while the host bundle only changes on a
  // `dsh web` restart, so the two halves can disagree for a while. Every field is optional
  // here on purpose: a missing one degrades this card, it never throws. (A throw in this
  // component unmounts the whole `sidebar.footer.action` seat -- GPU cards included -- which
  // is exactly what happened on 2026-09-17 when this client was newer than its host.)
  const tracks = Array.isArray(radio?.tracks) ? radio.tracks : []
  const current = tracks.find(t => t.id === currentId) ?? null
  // Only songs the radio itself wrote are in rotation. Everything else in the library is
  // material for later (films, ads, product videos) -- playing it here would make this a
  // music player, and that is a deliberately separate product (owner, 2026-09-17).
  //
  // `sessionWrites` covers the window where this client is newer than its host: the old host
  // does not emit the `radio` marker yet, so the ids this browser generated are treated as
  // radio songs until the restart lands. Library material never qualifies either way.
  const playable = tracks.filter(t =>
    (t.radio === true || sessionWrites.current.has(t.id)) && t.never !== true)
  const settings = radio?.settings ?? { planner: '', musicModel: '', durationMin: 0, durationMax: 0 }
  const planner = typeof settings.planner === 'string' ? settings.planner : ''
  const musicModel = typeof settings.musicModel === 'string' ? settings.musicModel : ''
  const durationMin = typeof settings.durationMin === 'number' ? settings.durationMin : 0
  const durationMax = typeof settings.durationMax === 'number' ? settings.durationMax : 0
  const autoBand = durationMin === 0 || durationMax === 0
  const stations = Array.isArray(radio?.stations) ? radio.stations : []
  /** Only the songs the owner rated five stars — the single list the modal shows. */
  const fiveStar = tracks.filter(t => t.stars === 5)
  const stats = radio?.stats ?? null

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${API}/radio`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setRadio(await res.json() as RadioPayload)
      setError(null)
    } catch (err) {
      setError(String(err).slice(0, 120))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 15000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${API}/radio/models`)
      // An older host half has no such route at all: an empty dropdown is the honest answer,
      // and it must not look like a failure.
      if (!res.ok) return
      const body = await res.json() as { planners?: readonly ModelChoice[]; music?: readonly ModelChoice[] }
      setModels({ planners: body.planners ?? [], music: body.music ?? [] })
    } catch { /* an empty dropdown is an honest answer when the catalogue cannot be read */ }
  }, [])

  useEffect(() => { void loadModels() }, [loadModels])

  const choose = useCallback(async (patch: { planner?: string; musicModel?: string; durationMin?: number; durationMax?: number }): Promise<void> => {
    try {
      await post('settings', patch)
      await refresh()
    } catch (err) {
      setError(String(err).slice(0, 160))
    }
  }, [refresh])

  /** Write one track for `forStation` — the only place a render can start. */
  const write = useCallback(async (forStation: string, count = 1): Promise<boolean> => {
    try {
      const known = new Set(tracks.map(t => t.id))
      await post('generate', { station: forStation, count })
      // Fetch the result here rather than through refresh(): the ids that just appeared are
      // what marks them as radio songs when the host cannot do it yet.
      const res = await fetch(`${API}/radio`)
      const payload = await res.json() as RadioPayload
      for (const track of Array.isArray(payload.tracks) ? payload.tracks : []) {
        if (!known.has(track.id)) sessionWrites.current.add(track.id)
      }
      setRadio(payload)
      setError(null)
      return true
    } catch (err) {
      setError(String(err).slice(0, 160))
      return false
    }
  }, [tracks])

  /** Step to the next track: newest-first order, skipping anything marked never. */
  const step = useCallback((delta: number): void => {
    if (playable.length === 0) return
    const index = currentId === null ? -1 : playable.findIndex(t => t.id === currentId)
    const next = playable[(index + delta + playable.length + 1) % playable.length]
    if (next) {
      setCurrentId(next.id)
      setPos(0)
      void post('rate', { id: next.id, played: true }).catch(() => undefined)
    }
  }, [currentId, playable])

  // Point the audio element at the current track; play only when asked, because
  // autoplay without a gesture is blocked by the browser anyway.
  useEffect(() => {
    const el = audio.current
    if (el === null) return
    if (current === null) {
      el.removeAttribute('src')
      el.load()
      return
    }
    const want = `${API}/radio/audio/${current.id}`
    if (!el.src.endsWith(want)) {
      el.src = want
      el.load()
      setDur(current.seconds || 0)
      // On air: a track change is not a reason to fall silent.
      if (wantPlay.current) {
        void el.play().catch(() => setError('playback blocked'))
      }
    }
  }, [current])

  /** Going live: with an empty library the first press writes a song and plays it. */
  const goLive = useCallback(async (): Promise<void> => {
    setGoingLive(true)
    setBusy('going live — writing the first song…')
    await write(station)
    setBusy(null)
  }, [station, write])

  const toggle = useCallback((): void => {
    const el = audio.current
    if (el === null) return
    if (current === null) {
      if (playable.length === 0) { void goLive(); return }
      setCurrentId(playable[0]!.id)
      window.setTimeout(() => { void el.play().catch(() => setError('playback blocked')) }, 60)
      return
    }
    if (el.paused) void el.play().catch(() => setError('playback blocked'))
    else el.pause()
  }, [current, playable, goLive])

  // After a cold start, auto-play the first track that arrived.
  useEffect(() => {
    if (!goingLive) return
    const first = playable[0]
    if (first === undefined) return
    setCurrentId(first.id)
    setGoingLive(false)
    window.setTimeout(() => { void audio.current?.play().catch(() => undefined) }, 120)
  }, [goingLive, playable])

  /**
   * The owner's rule: when the current track enters its last LEAD_SECONDS, write
   * the next one — but only when nothing is already queued after it, so the
   * renderer is never asked for a song that is already waiting.
   */
  const ensureAhead = useCallback((): void => {
    if (busy !== null) return
    const index = playable.findIndex(t => t.id === currentId)
    const ahead = index < 0 ? playable.length : playable.length - index - 1
    if (ahead >= 1) return
    setBusy('writing the next song…')
    void write(current?.station ?? station).finally(() => setBusy(null))
  }, [busy, playable, currentId, current, station, write])

  const rate = useCallback(async (stars: number): Promise<void> => {
    if (current === null) return
    try { await post('rate', { id: current.id, stars }) } catch (err) { setError(String(err).slice(0, 120)) }
    await refresh()
  }, [current, refresh])

  const neverAgain = useCallback(async (): Promise<void> => {
    if (current === null) return
    try { await post('rate', { id: current.id, never: true }) } catch (err) { setError(String(err).slice(0, 120)) }
    audio.current?.pause()
    setCurrentId(null)
    await refresh()
  }, [current, refresh])

  const generate = useCallback(async (count: number): Promise<void> => {
    setBusy(count > 1 ? `writing ${count} ahead…` : 'rendering…')
    await write(station, count)
    setBusy(null)
  }, [station, write])

  // Collapsed 56px rail: one glyph, with the song in the tooltip.
  if (!wide) {
    return h('span', {
      className: `hhq-radio-dot${playing ? ' hhq-radio-dot-on' : ''}`,
      title: current === null ? 'Hawk Radio' : `Radio: ${current.title}${playing ? ' (playing)' : ''}`,
    }, '♪')
  }

  const health = radio?.health ?? null
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0
  const title = current?.title
    ?? (goingLive ? 'Going live…' : health?.up === true ? `${station}` : 'Radio offline')
  // The rail carries information only — the station in words, the song's name, where we are
  // in the song. No pickers: choosing a station belongs in the modal, and the sidebar stays
  // small enough to live above the GPU cards permanently.
  const subtitle = current === null
    ? (goingLive
        ? `${station} · writing the first song…`
        : `${station} · press play to go on air`)
    : `${current.station}${current.bpm === null ? '' : ` · ${current.bpm} BPM`}${current.key === null ? '' : ` · ${current.key}`}`
      + ((current.lyrics ?? '').trim() === '[Instrumental]' ? ' · words: none' : ' · words: planner')

  return h('div', { className: 'hhq-side hhq-radio' },
    h('audio', {
      ref: audio,
      preload: 'none',
      onPlay: () => {
        wantPlay.current = true
        setPlaying(true)
        // The radio is on air: make sure the next song exists while this one plays.
        ensureAhead()
      },
      onPause: () => { wantPlay.current = false; setPlaying(false) },
      onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => {
        const el = event.currentTarget
        setPos(el.currentTime)
        setPos(el.currentTime)
      },
      onLoadedMetadata: (event: SyntheticEvent<HTMLAudioElement>) => setDur(event.currentTarget.duration || 0),
      onEnded: () => { step(1) },
      onError: () => setError('audio failed'),
    }),

    // ── compact card ──────────────────────────────────────────────────────
    h('div', { className: 'hhq-radio-top' },
      h('button', {
        type: 'button',
        className: `hhq-radio-play${playing ? ' hhq-radio-play-on' : ''}`,
        onClick: toggle,
        title: playing ? 'Pause' : 'Play',
      }, playing ? '❚❚' : '▶'),
      h('div', { className: 'hhq-radio-title' },
        h('b', { title }, title),
        h('span', null, subtitle)),
      h('button', {
        type: 'button',
        className: 'hhq-radio-gear',
        onClick: () => setOpen(true),
        title: 'Hawk Radio settings',
      }, '⚙')),

    h('div', { className: 'hhq-radio-bar' }, h('i', { style: { width: `${pct}%` } })),
    h('div', { className: 'hhq-radio-meta' },
      h('span', null, `${fmtTime(pos)} / ${fmtTime(dur)}`),
      busy !== null
        ? h('span', { className: 'hhq-radio-busy' }, busy)
        : h('span', { className: health?.up === true ? 'hhq-radio-ok' : 'hhq-radio-down' },
            health?.up === true ? `● ${playable.length} ready` : '● renderer down'),
      h('span', { className: 'hhq-radio-stars-mini', title: 'Rate this song' },
        [1, 2, 3, 4, 5].map(n => h('button', {
          key: n,
          type: 'button',
          className: `hhq-radio-star${(current?.stars ?? 0) >= n ? ' on' : ''}`,
          onClick: () => { void rate(n) },
          title: `${n} star${n === 1 ? '' : 's'}`,
        }, '★')))),

    error !== null
      ? h('div', { className: 'hhq-radio-error', onClick: () => setError(null) }, error)
      : null,

    // ── modal ─────────────────────────────────────────────────────────────
    open
      ? h('div', { className: 'hhq-radio-overlay', onClick: () => setOpen(false) },
          h('div', { className: 'hhq-radio-modal', onClick: (event: MouseEvent<HTMLDivElement>) => event.stopPropagation() },
            h('div', { className: 'hhq-radio-modal-head' },
              h('span', { className: 'hhq-radio-brand' }, 'HAWK RADIO'),
              h('span', { className: health?.up === true ? 'hhq-badge hhq-badge-ok' : 'hhq-badge' },
                health?.up === true ? `● renderer online · ${health.model ?? 'model'}` : '● renderer offline'),
              h('button', { type: 'button', className: 'hhq-radio-x', onClick: () => setOpen(false) }, '✕')),

            // Model selection: the planner writes the song, the music model makes it.
            h('div', { className: 'hhq-radio-models' },
              h('div', { className: 'hhq-radio-sel' }, 'Planner',
                h('select', {
                  value: planner,
                  title: 'A text model — it writes the caption, lyrics and metadata',
                  onChange: (event: ChangeEvent<HTMLSelectElement>) => { void choose({ planner: event.target.value }) },
                },
                  h('option', { key: '', value: '' }, '— pick a text model —'),
                  (models?.planners ?? [])
                    .filter(m => m.music !== true)
                    .map(m => h('option', { key: `${m.provider}:${m.id}`, value: `${m.provider}:${m.id}` },
                      `${m.name} (${m.provider})`)))),
              h('div', { className: 'hhq-radio-sel' }, 'Music',
                h('select', {
                  value: musicModel,
                  title: "The renderer — it turns the planner's song into audio",
                  onChange: (event: ChangeEvent<HTMLSelectElement>) => { void choose({ musicModel: event.target.value }) },
                },
                  h('option', { key: '', value: '' }, 'renderer default'),
                  (models?.music ?? []).map(m => h('option', { key: m.id, value: m.id }, m.name))))),

            h('div', { className: 'hhq-radio-grid' },
              h('div', { className: 'hhq-radio-col' },
                h('div', { className: 'hhq-radio-now' }, current?.title ?? (goingLive ? 'Going live…' : 'Nothing playing')),
                h('div', { className: 'hhq-radio-sub' },
                  current === null
                    ? (goingLive ? 'writing the first song — it starts as soon as it lands' : 'press play to start the radio')
                    : `AI · new · never released${current.seed === null ? '' : ` · seed ${current.seed}`}`),
                current !== null
                  ? h('div', { className: 'hhq-radio-tags' },
                      h('span', { className: 'hhq-radio-tag-st' }, current.station),
                      current.bpm !== null ? h('span', { className: 'hhq-radio-tag' }, `${current.bpm} BPM`) : null,
                      current.key !== null ? h('span', { className: 'hhq-radio-tag' }, current.key) : null,
                      current.lang !== null ? h('span', { className: 'hhq-radio-tag' }, current.lang) : null)
                  : null,
                h('div', { className: 'hhq-radio-bar hhq-radio-bar-lg' }, h('i', { style: { width: `${pct}%` } })),
                h('div', { className: 'hhq-radio-times' }, h('span', null, fmtTime(pos)), h('span', null, fmtTime(dur))),

                h('div', { className: 'hhq-radio-transport' },
                  h('button', { type: 'button', className: 'hhq-radio-btn', onClick: () => step(-1), title: 'Previous' }, '◀◀'),
                  h('button', { type: 'button', className: 'hhq-radio-btn hhq-radio-btn-play', onClick: toggle },
                    playing ? '❚❚ Pause' : '▶ Play'),
                  h('button', { type: 'button', className: 'hhq-radio-btn', onClick: () => step(1), title: 'Next' }, '▶▶'),
                  h('button', {
                    type: 'button',
                    className: 'hhq-radio-btn hhq-radio-btn-stop',
                    title: 'Pause the radio. A render already under way finishes; nothing new starts.',
                    onClick: () => { audio.current?.pause(); setPlaying(false) },
                  }, '■ Stop')),

                h('div', { className: 'hhq-radio-rate' },
                  h('span', { className: 'hhq-radio-lab' }, 'Rate'),
                  h('span', { className: 'hhq-radio-stars' },
                    [1, 2, 3, 4, 5].map(n => h('button', {
                      key: n,
                      type: 'button',
                      className: `hhq-radio-star${(current?.stars ?? 0) >= n ? ' on' : ''}`,
                      onClick: () => { void rate(n) },
                      title: `${n} star${n === 1 ? '' : 's'}`,
                    }, '★'))),
                  h('button', { type: 'button', className: 'hhq-radio-chip', onClick: () => { void generate(1) } }, '♻ more like this'),
                  h('button', { type: 'button', className: 'hhq-radio-chip hhq-radio-chip-bad', onClick: () => { void neverAgain() } }, '✕ never again')),

                h('div', { className: 'hhq-radio-row' },
                  h('div', { className: 'hhq-radio-sel' }, 'Station',
                    h('select', {
                      value: station,
                      onChange: (event: ChangeEvent<HTMLSelectElement>) => setStation(event.target.value),
                    }, stations.map(s => h('option', { key: s, value: s }, s)))),
                  h('button', {
                    type: 'button',
                    className: 'hhq-radio-btn hhq-radio-btn-go',
                    title: 'Write ten songs now and park them in the queue — pressing Play already writes one',
                    disabled: busy !== null || health?.up !== true,
                    onClick: () => { void generate(10) },
                  }, busy ?? 'write 10 ahead')),
                h('div', { className: 'hhq-radio-hint' },
                  `Play takes the radio on air: it writes a new song, plays it, and writes the next one before this one ends. Songs written this way are kept in the library forever; “write 10 ahead” fills the queue up front.`),

                current?.lyrics != null
                  ? h('details', { className: 'hhq-radio-lyrics' },
                      h('summary', null, 'Lyrics + caption'),
                      h('div', null, current.caption ?? ''),
                      h('pre', null, current.lyrics))
                  : null),

              h('div', { className: 'hhq-radio-col hhq-radio-col-right' },
                h('div', { className: 'hhq-radio-lab' },
                  autoBand
                    ? `Song length · ${station} band, the planner picks inside it`
                    : `Song length · global override ${fmtTime(durationMin)}–${fmtTime(durationMax)}`),
                h('div', { className: 'hhq-radio-row' },
                  h('div', { className: 'hhq-radio-sel' }, 'min',
                    h('select', {
                      value: autoBand ? '0' : String(durationMin),
                      onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                        const v = Number(event.target.value)
                        void choose(v > durationMax ? { durationMin: v, durationMax: v } : { durationMin: v })
                      },
                    }, [0, 120, 150, 180, 210, 240, 300].map(v =>
                      h('option', { key: String(v), value: String(v) },
                        v === 0 ? 'auto (station band)' : fmtTime(v))))),
                  h('div', { className: 'hhq-radio-sel' }, 'max',
                    h('select', {
                      value: autoBand ? '0' : String(durationMax),
                      onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                        const v = Number(event.target.value)
                        if (v === 0) { void choose({ durationMin: 0, durationMax: 0 }); return }
                        void choose(v < durationMin ? { durationMin: v, durationMax: v } : { durationMax: v })
                      },
                    }, [0, 180, 240, 270, 300, 330, 360].map(v =>
                      h('option', { key: String(v), value: String(v) },
                        v === 0 ? 'auto (station band)' : fmtTime(v)))))),
                // Owner, 2026-09-17: the queue list, the learning block and every non-five-star
                // history entry were cut from this modal. What remains is the one list he asked
                // for -- the songs he gave five stars -- and nothing else.
                ...fiveStar.length > 0
                  ? [
                      h('div', { className: 'hhq-radio-lab' }, `Five stars · ${fiveStar.length}`),
                      ...fiveStar.slice(0, 10).map(t => h('div', { key: t.id, className: 'hhq-radio-hrow' },
                        h('span', { className: 'hhq-radio-qi-t' }, t.title),
                        h('span', { className: 'hhq-radio-hrow-s' }, starGlyphs(5)))),
                    ]
                  : [])),
            h('div', { className: 'hhq-radio-foot' },
              h('span', null, health?.up === true
                ? `ai-server · ${health.jobs ?? 0} jobs · ${health.avgSeconds === null ? '—' : `${health.avgSeconds.toFixed(1)}s`} avg`
                : `ai-server unreachable${health?.error === undefined ? '' : ` · ${health.error.slice(0, 60)}`}`),
              h('span', null, `${stats?.rated ?? 0} rated · avg ${stats?.starsAvg ?? '—'}★`))))
      : null)
}
