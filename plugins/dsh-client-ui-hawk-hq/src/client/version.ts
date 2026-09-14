/**
 * DSH version badge for the sidebar head — the seat between the brand row and
 * the New Session button, which the installed ui-sidebar bundle only grows
 * through the small out-of-tree patch that
 * `scripts/apply-dsh-ui-fixes.sh` applies (and reapplies after a harness
 * upgrade).
 *
 * Reading rules: the running version is always visible.
 * When a newer version is published the row reads `0.1.1-rc.2 → v0.1.5-rc.1`
 * with the newer number in bold red, so it cannot be missed; with nothing
 * newer it is plain green. A pending or failed update check is never dressed
 * as green — it goes neutral with the reason in the tooltip.
 *
 * Where the numbers come from:
 *   - running version: `GET /plugin/hawk-hq/version` (authoritative, cached in
 *     the host half) once that route is live, otherwise the value baked into
 *     this bundle at build time by the apply script;
 *   - newest published version: the same route, otherwise the npm registry
 *     read straight from the browser — the registry serves CORS `*`, so the
 *     badge works without restarting the harness.
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { VersionPayload } from '../wire.ts'
import { compareVersions } from '../semver.ts'
import { DSH_BUILD_STAMP, DSH_VERSION_AT_BUILD } from './dsh-build.ts'
import { API } from './util.ts'

/** Abbreviated registry document: dist-tags only, ~100 KB instead of megabytes. */
const REGISTRY_DOC_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh'
/** Poll cadence while the host is still producing its first registry answer. */
const RETRY_MS = 4000
/** Give up polling after this many attempts (the badge then stays neutral). */
const MAX_TRIES = 8

/** Render tone: green when current, red-bold when an update exists. */
type Tone = 'ok' | 'update' | 'unknown'

/** What the badge renders, normalised across both data sources. */
interface BadgeState {
  /** The running harness version. */
  readonly current: string
  /** Newest published version, null when no check has succeeded yet. */
  readonly latest: string | null
  /** True when `latest` is strictly newer than `current`. */
  readonly updateAvailable: boolean
  /** Every dist-tag the registry publishes (latest/next/alpha). */
  readonly distTags: Readonly<Record<string, string>>
  /** Which source produced this state. */
  readonly source: 'harness' | 'registry' | 'build'
  /** ISO timestamp of the registry answer, null when there is none. */
  readonly checkedAt: string | null
  /** Why no registry answer is available. */
  readonly error: string | null
  /** A check is still pending or stale: keep polling, render neutral. */
  readonly quiet: boolean
}

/** Normalise a host-half payload. */
function fromHost(payload: VersionPayload): BadgeState {
  const current = payload.current ?? DSH_VERSION_AT_BUILD
  const latest = payload.latest
  return {
    current,
    latest,
    updateAvailable: latest !== null && compareVersions(latest, current) > 0,
    distTags: { ...payload.distTags },
    source: 'harness',
    checkedAt: payload.error === undefined ? payload.checkedAt : null,
    error: payload.error ?? null,
    quiet: payload.pending === true || payload.stale === true,
  }
}

/** Error text without a stack. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the registry straight from the browser (the no-restart fallback). */
async function fromRegistry(): Promise<BadgeState> {
  const base: Omit<BadgeState, 'latest' | 'updateAvailable' | 'distTags' | 'source' | 'checkedAt' | 'error' | 'quiet'> = {
    current: DSH_VERSION_AT_BUILD,
  }
  try {
    const response = await fetch(REGISTRY_DOC_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
    const doc = (await response.json()) as { 'dist-tags'?: Record<string, string> }
    const distTags: Record<string, string> = doc['dist-tags'] ?? {}
    const latest = typeof distTags.latest === 'string' ? distTags.latest : null
    return {
      ...base,
      latest,
      updateAvailable: latest !== null && compareVersions(latest, base.current) > 0,
      distTags,
      source: 'registry',
      checkedAt: new Date().toISOString(),
      error: null,
      quiet: false,
    }
  } catch (error) {
    return {
      ...base,
      latest: null,
      updateAvailable: false,
      distTags: {},
      source: 'build',
      checkedAt: null,
      error: messageOf(error),
      quiet: false,
    }
  }
}

/** Ask the host half; null when the route is not live yet (pre-restart install). */
async function fromHarness(): Promise<{ state: BadgeState; retry: boolean } | null> {
  try {
    const response = await fetch(`${API}/version`)
    if (!response.ok) return null
    const state = fromHost((await response.json()) as VersionPayload)
    return { state, retry: state.quiet }
  } catch {
    return null
  }
}

/** One load attempt: host half first, registry fallback second. */
async function loadState(): Promise<{ state: BadgeState; retry: boolean }> {
  const host = await fromHarness()
  if (host !== null) return host
  return { state: await fromRegistry(), retry: false }
}

/** Green only when a successful check says this install is the newest. */
function toneOf(state: BadgeState | null): Tone {
  if (state === null) return 'unknown'
  if (state.updateAvailable) return 'update'
  if (state.error !== null) return 'unknown'
  if (state.latest === null) return 'unknown'
  return 'ok'
}

/** Tooltip: what is shown, what is published, where it came from. */
function tooltipOf(state: BadgeState | null): string {
  const lines: string[] = []
  const current = state?.current ?? DSH_VERSION_AT_BUILD
  lines.push(`DSH harness ${current}`)
  if (state?.latest != null) {
    lines.push(
      state.updateAvailable
        ? `newest published: ${state.latest} — update available`
        : `newest published: ${state.latest} — this install is current`,
    )
  }
  const distTags: Readonly<Record<string, string>> = state?.distTags ?? {}
  const tags = Object.entries(distTags)
  if (tags.length > 0) lines.push(tags.map(([tag, version]) => `${tag}: ${version}`).join(' · '))
  if (state?.error != null) lines.push(`update check failed: ${state.error}`)
  else if (state === null || (state.latest === null && state.quiet)) lines.push('checking the npm registry…')
  if (state?.checkedAt != null) lines.push(`checked ${new Date(state.checkedAt).toLocaleString()}`)
  else if (state != null && state.latest === null) lines.push('no registry answer yet')
  lines.push(
    state == null
      ? 'source: bundle (built)'
      : state.source === 'harness'
        ? 'source: hawk-hq host route'
        : state.source === 'registry'
          ? 'source: npm registry (browser)'
          : 'source: bundle (built)',
  )
  if (DSH_BUILD_STAMP !== '') lines.push(`bundle built ${DSH_BUILD_STAMP}`)
  lines.push('reapply after a harness upgrade: scripts/apply-dsh-ui-fixes.sh')
  return lines.join('\n')
}

/** The `sidebar.version` occupant: the running harness version, always visible. */
export function DshVersionBadge({ wide }: { readonly wide?: boolean }): ReactNode {
  const [state, setState] = useState<BadgeState | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let tries = 0
    const run = async (): Promise<void> => {
      const { state: next, retry } = await loadState()
      if (cancelled) return
      setState(next)
      tries += 1
      if (retry && tries < MAX_TRIES) timer = window.setTimeout(() => void run(), RETRY_MS)
    }
    void run()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  // The collapsed 56px rail carries icons only; the badge belongs to the wide column.
  if (wide === false) return null

  const current = state?.current ?? DSH_VERSION_AT_BUILD
  const tone = toneOf(state)
  const latest = state?.latest ?? null
  const updating = state?.updateAvailable === true && latest !== null

  // No "DSH" prefix and no wasted vertical space — the row is
  // just the version, in the tone that says what it means. The tooltip still
  // spells out that it is the harness version.
  const children: ReactNode[] = [
    h('span', { className: `hhq-ver-current hhq-ver-${tone}`, key: 'current' }, current),
  ]
  if (updating) {
    children.push(h('span', { className: 'hhq-ver-arrow', key: 'arrow' }, '→'))
    children.push(h('span', { className: 'hhq-ver-new', key: 'latest' }, `v${latest}`))
  }

  return h('div', { className: 'hhq-ver', title: tooltipOf(state) }, ...children)
}
