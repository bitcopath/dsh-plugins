/**
 * Dependency-free semver comparison shared by both halves of the hawk-hq
 * plugin: the host half decides `updateAvailable` for
 * `GET /plugin/hawk-hq/version`, and the browser half re-decides it when it
 * falls back to reading the npm registry directly (no harness restart needed).
 *
 * Only the subset that matters here is implemented — strict
 * `major.minor.patch[-prerelease]` with semver's prerelease ordering, where a
 * plain release outranks any prerelease of the same numbers. An unparsable
 * version compares equal, so a weird tag can never fake an update.
 */

/** Parsed version: the three numbers plus the prerelease identifier list. */
interface ParsedVersion {
  readonly numbers: readonly number[]
  readonly prerelease: readonly (number | string)[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/** Parse `1.2.3`, `1.2.3-rc.4` or `v1.2.3-rc.4`; null when it is not a version. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(text.trim())
  if (match === null) return null
  const prerelease = match[4] === undefined
    ? []
    : match[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  }
}

/** Compare one prerelease identifier pair per semver: numeric < alphanumeric. */
function compareIdentifier(left: number | string, right: number | string): number {
  if (left === right) return 0
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1
  if (typeof left === 'number') return -1
  if (typeof right === 'number') return 1
  return left < right ? -1 : 1
}

/**
 * Compare two versions: -1 when `left` is older, 1 when newer, 0 when equal or
 * unparsable.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (let index = 0; index < 3; index++) {
    const x = a.numbers[index] ?? 0
    const y = b.numbers[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  // A release outranks a prerelease of the same numbers (1.0.0 > 1.0.0-rc.1).
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const depth = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < depth; index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const verdict = compareIdentifier(x, y)
    if (verdict !== 0) return verdict
  }
  return 0
}
