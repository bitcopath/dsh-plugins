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
   * Ids this session has already started playing. A reserved song stays in the session's chain (see
   * `playable`) only until it has been heard once, so it can finish its airing but can never come
   * back — the radio's rule is "listened and gone", and a reserved song must not be replayed just
   * because it is no longer in the live folder.
   */
  const played = useRef<Set<string>>(new Set())
  /**
   * True while the radio is meant to be ON AIR — a USER decision, changed only by the play,
   * pause and stop buttons.
   *
   * The first version of this derived intent from the audio element's own play/pause events,
   * and that cancelled itself: changing the track reloads the element, which fires `pause`, which
   * cleared the intent just before the resume ran — so the owner still had to press play after
   * every song (reported 2026-09-17, screenshot of a stopped card at 0:00). Intent must never be
   * inferred from the element; the element's events only drive the button's appearance.
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
  /** On-Air lockout: a misclick must not flip the switch twice (owner, 2026-09-17). */
  const [lockLeft, setLockLeft] = useState(0)
  /** Which song's link the modal shows — a reserved row shares, not only the live song. */
  const [shareId, setShareId] = useState<string | null>(null)
  /**
   * The song just starred, kept after it leaves the live payload so the card can still name it and
   * still share it. Cleared when another track is picked up or the radio goes off air.
   */
  const [reservedNow, setReservedNow] = useState<{ readonly id: string; readonly title: string } | null>(null)
  const [shareBusy, setShareBusy] = useState<string | null>(null)
  const lockUntil = useRef(0)

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
  //
  // A star means RESERVE (owner's rule, 2026-09-17): the live copy is marked and the rotation drops
  // it. It must still be PLAYABLE for the rest of this airing, though — measured live on 2026-09-17
  // 15:55, starring the song that was playing removed it from this list, `step()` then had nothing to
  // advance to when the song ended, and the radio went off air mid-session. Reserved songs therefore
  // stay in the session's own chain of songs, while the "ready" count excludes them (the radio has
  // nothing ready any more — the song is reserved).
  const playable = tracks.filter(t =>
    (t.radio === true || sessionWrites.current.has(t.id)) && t.never !== true
    && (t.stars === 0 || (sessionWrites.current.has(t.id) && !played.current.has(t.id))))
  /** How many songs are actually available to the ROTATION — reserved ones do not count. */
  const ready = playable.filter(t => t.stars === 0).length

  /**
   * The queue: songs this session wrote that have not been heard yet and are not playing now.
   *
   * A reserved song leaves the live payload the moment it is starred, so "how many tracks sit after
   * the current one"
   * is the wrong question — a keeper would look like a queued song and the radio would stop writing
   * ahead. The queue is only ever what was written for this session (owner's rule, 2026-09-17:
   * exactly one song ahead, never more). A song deleted by the sweep is gone from `tracks`, so it
   * drops out of this list by itself.
   */
  const queued = playable.filter(t => sessionWrites.current.has(t.id) && t.id !== currentId)
  const settings = radio?.settings ?? { planner: '', musicModel: '', durationMin: 0, durationMax: 0 }
  const planner = typeof settings.planner === 'string' ? settings.planner : ''
  const musicModel = typeof settings.musicModel === 'string' ? settings.musicModel : ''
  const durationMin = typeof settings.durationMin === 'number' ? settings.durationMin : 0
  const durationMax = typeof settings.durationMax === 'number' ? settings.durationMax : 0
  const autoBand = durationMin === 0 || durationMax === 0
  const stations = Array.isArray(radio?.stations) ? radio.stations : []
  /**
   * The RESERVED list — and only that (owner's rule, 2026-09-17: *"Radio looks at live, our list
   * looks at starred"*). It comes from the host's own `starred` folder, never from filtering the live
   * tracks: a reserved song has left the live folder, so a filter over `tracks` would show an empty
   * list the moment it was swept.
   *
   * `radio.starred ?? []` is the guard that matters when this client is newer than its host (the host
   * half only changes on a `dsh web` restart): an older payload has no such key, and a throw here
   * unmounts the whole sidebar seat — GPU cards included. That is a measured failure, not a theory.
   */
  const starred = Array.isArray(radio?.starred) ? radio.starred : []
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

  /**
   * Radio means radio: you listen to it and it is gone (owner's rule, 2026-09-17).
   *
   * Sweeps every song the radio wrote except the ids in `keep` — the rating exemption is gone, because
   * a starred song is now a COPY in the reserved folder rather than a rated live file. Called when the
   * next song starts (`keep` = the song now playing, so the one that just ended dies) and when the
   * owner goes off air (`keep` = nothing, so the current one dies too). A reserved copy is never in
   * this folder, so it cannot be reached from here. An older host has no prune route: the catch keeps
   * that harmless — nothing is swept, and nothing breaks.
   */
  const prune = useCallback(async (keep: readonly string[]): Promise<void> => {
    try {
      await post('prune', { keep })
      await refresh()
    } catch { /* old host half, or a sweep that failed: playback is never blocked by tidying */ }
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

  /**
   * Step to the next track: the queued song if one was written ahead, otherwise the next one in
   * newest-first order — but NEVER by wrapping around, because a song this radio has already played
   * must not come back (its whole rule is "listened and gone"). Advancing is also the moment the
   * finished song is swept.
   */
  const step = useCallback((delta: number): void => {
    if (playable.length === 0) return
    const index = currentId === null ? -1 : playable.findIndex(t => t.id === currentId)
    const next = delta > 0
      ? (queued[0] ?? (index >= 0 ? playable[index + 1] : playable[0]))
      : (index > 0 ? playable[index - 1] : current === null ? playable[0] : undefined)
    if (next) {
      played.current.add(next.id)
      setCurrentId(next.id)
      setPos(0)
      void post('rate', { id: next.id, played: true }).catch(() => undefined)
      // The song that just ended is deleted now unless its reserved copy exists in `starred`; the
      // one that is starting is the only thing this sweep must not touch.
      void prune([next.id])
    } else {
      // Nothing left ahead: stop honestly instead of looping back through songs already heard.
      wantPlay.current = false
      audio.current?.pause()
      setPlaying(false)
      void prune([])
    }
  }, [currentId, playable, queued, prune, current])

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
      // Reset the bar BEFORE the new file reports its own length. Without this the bar keeps the
      // PREVIOUS song's position while `dur` already belongs to the new one, so it renders a
      // position the song has not reached (reported by the owner, 2026-09-17: "0:08 / 4:12" with the
      // handle three-quarters across). Position and length must always describe the same song.
      setPos(0)
      setDur(current.seconds || 0)
      // On air: a track change is not a reason to fall silent.
      if (wantPlay.current) {
        // Browsers can refuse a play() issued during a src change; retry once shortly after,
        // because on air means on air.
        void el.play().catch(() => {
          window.setTimeout(() => {
            if (wantPlay.current) void el.play().catch(() => setError('playback blocked'))
          }, 250)
        })
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
      played.current.add(playable[0]!.id)
      setCurrentId(playable[0]!.id)
      window.setTimeout(() => { void el.play().catch(() => setError('playback blocked')) }, 60)
      return
    }
    if (el.paused) {
      wantPlay.current = true
      void el.play().catch(() => setError('playback blocked'))
    } else {
      wantPlay.current = false
      el.pause()
    }
  }, [current, playable, goLive])

  // After a cold start, auto-play the first track that arrived — the one just written. Reserved songs
  // are not in this payload at all, so an old favourite can never be picked up here.
  useEffect(() => {
    if (!goingLive) return
    const first = queued[0] ?? playable[0]
    if (first === undefined) return
    setCurrentId(first.id)
    wantPlay.current = true
    setGoingLive(false)
    window.setTimeout(() => { void audio.current?.play().catch(() => undefined) }, 120)
  }, [goingLive, playable, queued])

  /**
   * The owner's rule (2026-09-17): when a song starts playing, the NEXT one starts being written —
   * exactly one ahead, never two, and never a song that is already waiting. This used to fire in the
   * last seconds of the current song; it now fires on start, which is the moment the owner described.
   */
  const ensureAhead = useCallback((): void => {
    if (busy !== null) return
    if (queued.length >= 1) return
    setBusy('writing the next song…')
    void write(current?.station ?? station).finally(() => setBusy(null))
  }, [busy, queued, current, station, write])

  /**
   * Keep the next song written while the radio is on air.
   *
   * `ensureAhead()` otherwise only fires when a song STARTS (the audio element's `play` event), and
   * that event does not fire again for a song the browser starts programmatically during an advance.
   * Measured live on 2026-09-17: after the owner starred the song that was playing, nothing was left
   * in the queue, no `play` event arrived for the next song, and the radio ran out of material — the
   * third song was never written. Watching the state on air and writing when the queue is empty closes
   * that hole without changing the owner's rule: exactly one song ahead, never two.
   */
  useEffect(() => {
    if (!wantPlay.current) return
    if (queued.length >= 1 || busy !== null) return
    ensureAhead()
  }, [queued.length, busy, ensureAhead])

/**
   * On-air watchdog.
   *
   * The owner's rule is absolute: "once I press play it plays until I stop." The advance itself is
   * verified (firing `ended` moves the card from one song to the next), but the RESUME could not be
   * observed from my test browser — Chrome suspends media in a hidden tab — and a fix I cannot see
   * working is a guess. So this does not rely on any single event being delivered in the right
   * order: every 2 seconds, if the owner has asked for radio and the element is sitting paused
   * mid-song, it presses play again.
   *
   * It cannot fight the owner: pausing or stopping clears the intent first.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const el = audio.current
      if (el === null || !wantPlay.current) return
      if (current === null) return
      const atEnd = el.duration > 0 && el.currentTime > 0 && el.currentTime >= el.duration - 0.5
      if (el.paused && !atEnd) void el.play().catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [current])

  // One ticker for the lockout countdown; it does nothing while unlocked.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((lockUntil.current - Date.now()) / 1000))
      setLockLeft(current => (current === left ? current : left))
    }, 250)
    return () => window.clearInterval(timer)
  }, [])

  const lock = useCallback((): void => {
    lockUntil.current = Date.now() + 5000
    setLockLeft(5)
  }, [])

  /**
   * On air: write a NEW song and play it when it lands (owner's rule, 2026-09-17 — "every new air means
   * a new song"). It never resumes an old one: the live folder holds only what this session wrote, and
   * reserved songs live in their own folder, for other work rather than for the radio's rotation.
   */
  const goOnAir = useCallback((): void => {
    if (lockLeft > 0) return
    const el = audio.current
    if (el === null) return
    lock()
    wantPlay.current = true
    // A new air means a new song, so the reservation snapshot of the last one is done with.
    setReservedNow(null)
    setShareId(null)
    void goLive()
  }, [lockLeft, goLive, lock])

  /** Off air: stop immediately, and sweep the live song — a reserved copy survives untouched. */
  const goOffAir = useCallback((): void => {
    if (lockLeft > 0) return
    lock()
    wantPlay.current = false
    audio.current?.pause()
    setPlaying(false)
    setReservedNow(null)
    setShareId(null)
    void prune([])
  }, [lockLeft, lock, prune])

  /**
   * Star means RESERVE (owner's rule, 2026-09-17: *"Star means reserve it but get it out of the radio
   * live pipeline"*). This posts `reserve`, not a rating: the host copies the song into the reserved
   * folder, marks the live copy, and the radio's rotation drops it on the next poll while the song
   * that is playing keeps playing to its end.
   *
   * The snapshot is kept because reserving REMOVES the song from the live payload — without it the
   * card would lose the title (and the share action) the instant the owner starred what he is hearing.
   */
  const reserve = useCallback(async (): Promise<void> => {
    if (current === null) return
    const snapshot = { id: current.id, title: current.title }
    try {
      await post('reserve', { id: current.id })
      setReservedNow(snapshot)
    } catch (err) { setError(String(err).slice(0, 120)) }
    await refresh()
  }, [current, refresh])

  /** Unstar: the reserved copy is deleted. That is the way to get rid of something — see the host. */
  const unstar = useCallback(async (id: string): Promise<void> => {
    try { await post('unstar', { id }) } catch (err) { setError(String(err).slice(0, 120)) }
    if (reservedNow?.id === id) setReservedNow(null)
    await refresh()
  }, [refresh, reservedNow])

  /** Publish one song and show its link — the same action for the live song and a reserved row. */
  const share = useCallback(async (id: string): Promise<void> => {
    setShareBusy(id)
    try {
      await post('share', { id })
      await refresh()
      setShareId(id)
    } catch (err) { setError(String(err).slice(0, 160)) } finally { setShareBusy(null) }
  }, [refresh])

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
  const pct = dur > 0 ? Math.max(0, Math.min(100, (pos / dur) * 100)) : 0
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
        if (currentId !== null) played.current.add(currentId)
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
      onEnded: () => {
        // Keep playing: the owner asked for radio, not for one song.
        wantPlay.current = true
        step(1)
      },
      onError: () => setError('audio failed'),
    }),

    // ── compact card ──────────────────────────────────────────────────────
    h('div', { className: 'hhq-radio-top' },
      h('button', {
        type: 'button',
        className: `hhq-radio-tower${playing ? ' hhq-radio-tower-on' : ''}`
          + (lockLeft > 0 ? ' hhq-radio-tower-locked' : ''),
        onClick: playing ? goOffAir : goOnAir,
        disabled: lockLeft > 0,
        title: lockLeft > 0
          ? `locked for ${lockLeft}s (misclick guard)`
          : playing ? 'On air — click to go off air' : 'Go on air',
      }, lockLeft > 0 ? String(lockLeft) : '📡'),
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
        : h('span', { className: playing ? 'hhq-radio-ok' : 'hhq-radio-down' },
            playing ? `● ON AIR · ${ready} ready`
              : health?.up === true ? `● off air · ${ready} ready` : '● renderer down'),
      (() => {
        // Once starred, the song has left the live payload and the card names the reservation
        // instead: a snapshot is the difference between an empty card and a card that still
        // reads the title right after the owner pressed the star.
        const shown = current ?? reservedNow
        return h('button', {
          type: 'button',
          className: `hhq-radio-star${reservedNow?.id === shown?.id && shown !== null ? ' on' : ''}`,
          disabled: shown === null,
          onClick: () => {
            if (reservedNow !== null && shown?.id === reservedNow.id) { void unstar(reservedNow.id); return }
            void reserve()
          },
          title: reservedNow !== null && shown?.id === reservedNow.id
            ? 'Reserved — it is out of the radio and kept in your list. Click to unstar (deletes the reserved copy)'
            : 'Reserve it: it is copied out of the radio into your list and stops being radio material',
        }, '★')
      })()),

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
                    onClick: () => {
                      wantPlay.current = false
                      audio.current?.pause()
                      setPlaying(false)
                      // Stopping is going off air: the live song dies here, its reserved copy does not.
                      void prune([])
                    },
                  }, '■ Stop')),

                h('div', { className: 'hhq-radio-rate' },
                  h('span', { className: 'hhq-radio-lab' }, 'Reserve'),
                  (() => {
                    const shown = current ?? reservedNow
                    const isReserved = reservedNow !== null && shown?.id === reservedNow.id
                    return h('button', {
                      type: 'button',
                      className: `hhq-radio-star${isReserved ? ' on' : ''}`,
                      disabled: shown === null,
                      onClick: () => {
                        if (isReserved) { void unstar(reservedNow.id); return }
                        void reserve()
                      },
                      title: isReserved
                        ? 'Reserved — out of the radio, kept in your list. Unstar deletes the reserved copy'
                        : 'Star it to reserve it: copied to the reserved folder, gone from the radio as it moves on',
                    }, '★')
                  })(),
                  h('button', {
                    type: 'button',
                    className: 'hhq-radio-chip',
                    disabled: shareBusy !== null || current === null,
                    title: 'Publish this song and get a link you can send to anyone',
                    onClick: () => { if (current !== null) void share(current.id) },
                  }, shareBusy === current?.id ? 'sharing…' : '⇪ share'),
                  h('button', { type: 'button', className: 'hhq-radio-chip', onClick: () => { void generate(1) } }, '♻ more like this'),
                  h('button', { type: 'button', className: 'hhq-radio-chip hhq-radio-chip-bad', onClick: () => { void neverAgain() } }, '✕ never again')),

                (() => {
                  // One link block for both cases: the song on air and a reserved row. The link comes
                  // from the payload (the sidecar that actually holds it), so a refresh never loses it.
                  const shareOf = (id: string | null): string | undefined =>
                    id === null ? undefined
                      : id === current?.id ? current?.shareUrl
                        : starred.find(t => t.id === id)?.shareUrl
                  const linkId = (shareId !== null && shareOf(shareId) !== undefined ? shareId : null)
                    ?? (current?.shareUrl !== undefined ? current.id : null)
                    ?? starred.find(t => t.shareUrl !== undefined)?.id ?? null
                  const link = shareOf(linkId)
                  if (link === undefined) return null
                  return h('div', { className: 'hhq-radio-share' },
                    h('div', { className: 'hhq-radio-lab' }, 'Share link — anyone with this can listen'),
                    h('input', { className: 'hhq-radio-share-input', readOnly: true, value: link,
                      onFocus: (event: React.FocusEvent<HTMLInputElement>) => event.currentTarget.select() }),
                    h('div', { className: 'hhq-radio-row' },
                      h('button', {
                        type: 'button', className: 'hhq-radio-btn',
                        onClick: () => {
                          void navigator.clipboard.writeText(link)
                            .then(() => setError('link copied'))
                            .catch(() => setError('copy failed — select the field instead'))
                        },
                      }, 'Copy'),
                      h('button', {
                        type: 'button', className: 'hhq-radio-btn hhq-radio-btn-stop',
                        title: 'Kill this link: the song stays where it is, the link stops working',
                        onClick: () => {
                          if (linkId === null) return
                          void post('revoke', { id: linkId })
                            .then(() => { setShareId(null); return refresh() })
                            .catch((err: unknown) => setError(String(err).slice(0, 160)))
                        },
                      }, 'Revoke')))
                })(),
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
                  `Play takes the radio on air: it writes a new song, plays it, and writes the next one before this one ends. Each song is deleted as the radio moves past it — press ★ on one you want to keep and it is reserved, out of the radio, into your Starred list.`),

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
                // The one list the modal shows is the RESERVED folder (owner's rule, 2026-09-17:
                // "our list looks at starred"). It is the host's `starred` array, not a filter over
                // the live tracks — a reserved song has already left the live folder. Each row is a
                // share target, and one ★ per row (the five-star scale is gone).
                ...starred.length > 0
                  ? [
                      h('div', { className: 'hhq-radio-lab' }, `Starred · ${starred.length}`),
                      ...starred.slice(0, 10).map(t => h('div', { key: t.id, className: 'hhq-radio-hrow' },
                        h('span', { className: 'hhq-radio-qi-t' }, t.title),
                        h('button', {
                          type: 'button',
                          className: 'hhq-radio-chip',
                          disabled: shareBusy !== null,
                          title: 'Publish this reserved song and get a link you can send to anyone',
                          onClick: () => { void share(t.id) },
                        }, shareBusy === t.id ? 'sharing…' : '⇪ share'),
                        h('button', {
                          type: 'button',
                          className: 'hhq-radio-chip hhq-radio-chip-bad',
                          title: 'Unstar: delete the reserved copy. The radio never gets it back',
                          onClick: () => { void unstar(t.id) },
                        }, '✕'),
                        h('span', { className: 'hhq-radio-hrow-s' }, '★'))),
                    ]
                  : [])),
            h('div', { className: 'hhq-radio-foot' },
              h('span', null, health?.up === true
                ? `ai-server · ${health.jobs ?? 0} jobs · ${health.avgSeconds === null ? '—' : `${health.avgSeconds.toFixed(1)}s`} avg`
                : `ai-server unreachable${health?.error === undefined ? '' : ` · ${health.error.slice(0, 60)}`}`),
              h('span', null, `${stats?.rated ?? 0} rated · avg ${stats?.starsAvg ?? '—'}★`))))
      : null)
}
