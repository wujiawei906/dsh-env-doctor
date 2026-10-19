/**
 * Version parsing and the small range subset this plugin needs.
 *
 * Supported requirement forms: `*`, `latest`, `lts/*`, a bare or partial version
 * (`20`, `20.11`, `v20.11.0`), and space/comma separated comparators built from
 * `>=`, `>`, `<=`, `<`, `=`, `^`, and `~`.
 */

/** Parse the first `major[.minor[.patch]]` triple in a string. @param value - Any version-ish text. @returns The triple, or null when no digits are present. */
export function parseVersion(value) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value ?? ''))
  if (match === null) return null
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

/** Render a parsed triple. @param parts - Triple from {@link parseVersion}. @returns Dotted version text. */
export function formatVersion(parts) {
  return parts.join('.')
}

/**
 * Compare two parsed triples.
 * @param a - Left triple.
 * @param b - Right triple.
 * @returns Negative, zero, or positive, like a comparator.
 */
export function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left - right
  }
  return 0
}

/** Whether a requirement string imposes no constraint at all. @param range - Requirement text. @returns True for empty, `*`, `latest`, and `lts/*`. */
export function isOpenRange(range) {
  const text = String(range ?? '').trim().toLowerCase()
  return text === '' || text === '*' || text === 'latest' || text.startsWith('lts/')
}

/**
 * Test one partial version such as `20` or `20.11` as a prefix requirement.
 * @param version - Installed triple.
 * @param text - Partial version text.
 * @returns True when the installed version shares every stated component.
 */
function matchesPartial(version, text) {
  const parts = String(text).replace(/^v/u, '').split('.').filter((part) => part !== '' && part !== 'x' && part !== '*')
  for (let index = 0; index < parts.length && index < 3; index += 1) {
    if (version[index] !== Number(parts[index])) return false
  }
  return true
}

/**
 * Evaluate one comparator against an installed version.
 * @param version - Installed triple.
 * @param token - One comparator such as `>=18.17.0`, `^20.10.0`, or `20.11`.
 * @returns True when the comparator is satisfied.
 */
function matchesComparator(version, token) {
  const operator = /^(>=|<=|>|<|=|\^|~)/u.exec(token)?.[1] ?? '='
  const rest = operator === '=' ? token : token.slice(operator.length)
  const target = parseVersion(rest)
  if (target === null) return true
  const text = rest.replace(/^v/u, '')
  const partial = !/\d+\.\d+\.\d+/u.test(text)
  switch (operator) {
    case '>=':
      return compareVersions(version, target) >= 0
    case '>':
      return compareVersions(version, target) > 0
    case '<=':
      return compareVersions(version, target) <= 0
    case '<':
      return compareVersions(version, target) < 0
    case '^': {
      const upper = target[0] > 0 ? [target[0] + 1, 0, 0] : [0, target[1] + 1, 0]
      return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0
    }
    case '~': {
      const upper = [target[0], target[1] + 1, 0]
      return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0
    }
    default:
      return partial ? matchesPartial(version, text) : compareVersions(version, target) === 0
  }
}

/**
 * Decide whether an installed version satisfies a requirement.
 * @param installed - Version text as reported by the runtime.
 * @param range - Requirement text, possibly empty.
 * @returns True when satisfied; false when the version is unreadable or the range fails.
 */
export function satisfies(installed, range) {
  const version = parseVersion(installed)
  if (version === null) return false
  const text = String(range ?? '').trim()
  if (isOpenRange(text)) return true
  // Rejoin comparators split from their version by whitespace (`>= 6.0.0`), which
  // would otherwise leave a bare version token that reads as an exact match.
  const tokens = text
    .replace(/(>=|<=|>|<|=|\^|~)\s+/gu, '$1')
    .split(/[\s,]+/u)
    .filter((token) => token !== '')
  if (tokens.length === 0) return true
  return tokens.every((token) => matchesComparator(version, token))
}
