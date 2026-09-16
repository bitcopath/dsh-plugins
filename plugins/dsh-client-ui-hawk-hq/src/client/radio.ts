/**
 * Hawk Radio — browser half: the compact sidebar card, and the modal it opens.
 *
 * Shape follows the owner's decision (2026-09-16): the rail gets the smallest
 * thing that is still a radio — play/pause, the song's name, where it is in the
 * song — and the gear opens everything else in a modal, so the sidebar does not
 * grow permanent furniture for a feature that is sometimes idle.
 *
 * It owns its own data (one GET, refreshed on a slow timer and after every
 * action) rather than riding the GPU widget's SSE stream: the radio must keep
 * working when the GPU watchdog feed is down, and vice versa.
 *
 * Nothing here generates on a timer. Rendering is always the result of a click
 * on this machine, because a render occupies the ai-server.
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, MouseEvent, ReactNode, SyntheticEvent } from 'react'
import type { RadioPayload, RadioTrack } from '../wire.ts'
import { API, fmtGiB } from './util.ts'

/** `m:ss` for a duration in seconds. */
function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Five characters, filled to `n`. */
function starGlyphs(n: number): string {
  return '★★★★★'.slice(0, Math.max(0, Math.min(5, n))) + '☆☆☆☆☆'.slice(0, 5 - Math.max(0, Math.min(5, n)))
}

/** POST one action and ignore the body; the caller refreshes state afterwards. */
async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API}/radio/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text.slice(0, 160))
  }
}

/**
 * The `sidebar.footer.action` radio card. Rendered inside the same seat occupant
 * as the GPU widget (above ComfyUI), because two occupants in that seat lay out
 * side by side instead of stacking.
 */
export function RadioBlock({ wide }: { readonly wide: boolean }): ReactNode {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [radio, setRadio] = useState<RadioPayload | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [station, setStation] = useState<string>('rock-classic-metal')

  const tracks = radio?.tracks ?? []
  const current = tracks.find(t => t.id === currentId) ?? null
  const playable = tracks.filter(t => !t.never)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${API}/radio`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = await res.json() as RadioPayload
      setRadio(payload)
      setError(null)
      if (currentId === null) {
        const stations = payload.stats.stations
        if (stations.length > 0 && !stations.includes(station)) setStation(stations[0]!)
      }
    } catch (err) {
      setError(String(err).slice(0, 120))
    }
  }, [currentId, station])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 15000)
    return () => window.clearInterval(timer)
  }, [refresh])

  /** Step to the next track: newest-first order, skipping anything marked never. */
  const step = useCallback((delta: number): void => {
    if (playable.length === 0) return
    const index = currentId === null ? (delta > 0 ? -1 : 0) : playable.findIndex(t => t.id === currentId)
    const next = playable[(index + delta + playable.length + (index < 0 ? 1 : 0)) % playable.length]
    if (next) {
      setCurrentId(next.id)
      setPos(0)
      void post('rate', { id: next.id, played: true }).catch(() => undefined)
    }
  }, [currentId, playable])

  // Keep the audio element pointed at the current track, and start it only when
  // the user asked to play: autoplay without a gesture is blocked anyway.
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
    }
  }, [current])

  const toggle = useCallback((): void => {
    const el = audio.current
    if (el === null) return
    if (current === null) {
      const first = playable[0] ?? null
      if (first === null) return
      setCurrentId(first.id)
      window.setTimeout(() => { void el.play().catch(() => setError('playback blocked')) }, 60)
      return
    }
    if (el.paused) void el.play().catch(() => setError('playback blocked'))
    else el.pause()
  }, [current, playable])

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

  const generate = useCallback(async (): Promise<void> => {
    setBusy('rendering…')
    try {
      await post('generate', { station })
      await refresh()
    } catch (err) {
      setError(String(err).slice(0, 160))
    } finally {
      setBusy(null)
    }
  }, [station, refresh])

  // Collapsed 56px rail: one glyph, with the title in the tooltip.
  if (!wide) {
    return h('span', {
      className: `hhq-radio-dot${playing ? ' hhq-radio-dot-on' : ''}`,
      title: current === null ? 'Hawk Radio' : `Radio: ${current.title}${playing ? ' (playing)' : ''}`,
    }, playing ? '♪' : '♪')
  }

  const health = radio?.health ?? null
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0

  return h('div', { className: 'hhq-side hhq-radio' },
    h('audio', {
      ref: audio,
      preload: 'none',
      onPlay: () => setPlaying(true),
      onPause: () => setPlaying(false),
      onTimeUpdate: (event: SyntheticEvent<HTMLAudioElement>) => setPos(event.currentTarget.currentTime),
      onLoadedMetadata: (event: SyntheticEvent<HTMLAudioElement>) => setDur(event.currentTarget.duration || 0),
      onEnded: () => { setPlaying(false); step(1) },
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
        h('b', { title: current?.title ?? '' }, current?.title ?? (health?.up === true ? 'Radio ready' : 'Radio offline')),
        h('span', null, current === null
          ? `${radio?.stats.count ?? 0} songs in library`
          : `${current.station}${current.bpm === null ? '' : ` · ${current.bpm} BPM`}`)),
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
      h('span', { className: 'hhq-radio-stars-mini' }, starGlyphs(current?.stars ?? 0))),

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

            h('div', { className: 'hhq-radio-grid' },
              // left: now playing + controls
              h('div', { className: 'hhq-radio-col' },
                h('div', { className: 'hhq-radio-now' }, current?.title ?? 'Nothing playing'),
                h('div', { className: 'hhq-radio-sub' },
                  current === null
                    ? 'press play to start the radio'
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
                    title: 'Stop the radio (playback only — no rendering is running unless you ask)',
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
                  h('button', { type: 'button', className: 'hhq-radio-chip', onClick: () => { void generate() } }, '♻ more like this'),
                  h('button', { type: 'button', className: 'hhq-radio-chip hhq-radio-chip-bad', onClick: () => { void neverAgain() } }, '✕ never again')),

                h('div', { className: 'hhq-radio-row' },
                  h('div', { className: 'hhq-radio-sel' }, 'Station',
                    h('select', {
                      value: station,
                      onChange: (event: ChangeEvent<HTMLSelectElement>) => setStation(event.target.value),
                    }, (radio?.stations ?? []).map(s => h('option', { key: s, value: s }, s)))),
                  h('button', {
                    type: 'button',
                    className: 'hhq-radio-btn hhq-radio-btn-go',
                    disabled: busy !== null || health?.up !== true,
                    onClick: () => { void generate() },
                  }, busy ?? 'Generate one')),
                h('div', { className: 'hhq-radio-hint' },
                  'Rendering runs on the ai-server and takes a few seconds. Nothing renders unless you press this.'),

                current?.lyrics != null
                  ? h('details', { className: 'hhq-radio-lyrics' },
                      h('summary', null, 'Lyrics + caption'),
                      h('div', null, current.caption ?? ''),
                      h('pre', null, current.lyrics))
                  : null),

              // right: queue, history, learning
              h('div', { className: 'hhq-radio-col hhq-radio-col-right' },
                h('div', { className: 'hhq-radio-lab' }, `Up next · ${playable.length} ready`),
                ...playable.slice(0, 4).map((t, i) => h('div', { key: t.id, className: 'hhq-radio-qi' },
                  h('span', { className: 'hhq-radio-n' }, String(i + 1)),
                  h('span', { className: 'hhq-radio-qi-t' }, t.title),
                  h('span', { className: 'hhq-radio-qi-d' }, fmtTime(t.seconds)))),

                h('div', { className: 'hhq-radio-lab' }, 'History'),
                ...tracks.filter(t => t.plays > 0 || t.stars > 0).slice(0, 5).map(t => h('div', {
                  key: t.id, className: 'hhq-radio-hrow',
                },
                  h('span', { className: 'hhq-radio-qi-t' }, t.title),
                  h('span', { className: 'hhq-radio-hrow-s' }, starGlyphs(t.stars)))),

                h('div', { className: 'hhq-radio-lab' }, 'Learning'),
                h('div', { className: 'hhq-radio-act' },
                  h('span', null, 'Train on my 4★+ tracks'),
                  h('span', { className: 'hhq-radio-chip' }, `${tracks.filter(t => t.stars >= 4).length} songs · needs GPU`)),
                h('div', { className: 'hhq-radio-act' },
                  h('span', null, 'Songs I turned off for good'),
                  h('span', { className: 'hhq-radio-chip' }, String(radio?.stats.never ?? 0))),
                h('div', { className: 'hhq-radio-act' },
                  h('span', null, 'Library'),
                  h('span', { className: 'hhq-radio-chip' },
                    `${radio?.stats.count ?? 0} songs · ${fmtGiB(radio?.stats.bytes ?? 0)}`)))),

            h('div', { className: 'hhq-radio-foot' },
              h('span', null, health?.up === true
                ? `ai-server · ${health.jobs ?? 0} jobs · ${health.avgSeconds === null ? '—' : `${health.avgSeconds.toFixed(1)}s`} avg`
                : `ai-server unreachable${health?.error === undefined ? '' : ` · ${health.error.slice(0, 60)}`}`),
              h('span', null, `${radio?.stats.rated ?? 0} rated · avg ${radio?.stats.starsAvg ?? '—'}★`))))
      : null)
}
