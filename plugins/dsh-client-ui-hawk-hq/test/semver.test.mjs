import { compareVersions } from '../src/semver.ts'
const cases = [
  ['0.1.5-rc.1', '0.1.1-rc.2', 1, 'published newer release-candidate'],
  ['0.1.1-rc.2', '0.1.1-rc.2', 0, 'identical'],
  ['0.1.1-rc.2', '0.1.5-rc.1', -1, 'installed older'],
  ['0.1.5', '0.1.5-rc.2', 1, 'release outranks its prerelease'],
  ['0.1.10', '0.1.9', 1, 'numeric, not lexicographic'],
  ['1.0.0', '0.9.9', 1, 'major'],
  ['0.1.5-alpha.2', '0.1.5-rc.2', -1, 'alpha before rc'],
  ['0.1.5-rc.10', '0.1.5-rc.9', 1, 'numeric prerelease id'],
  ['garbage', '0.1.1', 0, 'unparsable compares equal (never fakes an update)'],
]
let bad = 0
for (const [a, b, want, why] of cases) {
  const got = Math.sign(compareVersions(a, b))
  const ok = got === want
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${a} vs ${b} → ${got} (want ${want}) — ${why}`)
}
console.log(bad === 0 ? '\nall semver cases pass' : `\n${bad} FAILURES`)
process.exit(bad === 0 ? 0 : 1)
