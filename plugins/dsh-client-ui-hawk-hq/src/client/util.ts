/** Small formatting helpers shared by the hawk-hq settings pages. */

/** The plugin's route prefix on the harness web server (same origin). */
export const API = '/plugin/hawk-hq'

/** Format a nullable number with unit, em-dash when absent. */
export function fmtUnit(value: number | null, digits: number, unit: string): string {
  if (value === null) return '—'
  return `${value.toFixed(digits)}${unit}`
}

/** Format bytes as GiB with one decimal. */
export function fmtGiB(bytes: number | null): string {
  if (bytes === null) return '—'
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

/** Compact token counts: 1.23M / 45.6K / 123. */
export function fmtTokens(n: number | null): string {
  if (n === null) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** USD balance, em-dash when absent. */
export function fmtUsd(value: number | null): string {
  if (value === null) return '—'
  return `$${value.toFixed(2)}`
}

/** Balance with its currency symbol ($/¥/€), em-dash when absent. */
export function fmtBalance(value: number | null, currency: string | null): string {
  if (value === null) return '—'
  const symbol = currency === 'CNY' ? '¥' : currency === 'EUR' ? '€' : '$'
  return `${symbol}${value.toFixed(2)}`
}

/**
 * Parse a timestamp that is either ISO 8601 (`2026-09-01T15:13:23+03:00`)
 * or sqlite UTC (`2026-09-01 15:23:02`); null when unparsable.
 */
export function parseTs(ts: string | null): Date | null {
  if (ts === null) return null
  const normalized = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Relative age ("5m ago") plus absolute fallback for old/invalid stamps. */
export function timeAgo(ts: string | null): string {
  const date = parseTs(ts)
  if (date === null) return ts ?? '—'
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleString()
}

/** Absolute local time for list rows. */
export function fmtClock(ts: string | null): string {
  const date = parseTs(ts)
  return date === null ? (ts ?? '') : date.toLocaleString()
}
