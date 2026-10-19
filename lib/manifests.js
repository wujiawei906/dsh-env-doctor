/**
 * Project manifest discovery and parsing.
 *
 * Reading is intentionally forgiving: every malformed or unreadable file becomes a
 * note instead of an error, because a diagnosis must still be produced for a
 * half-broken checkout.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Lockfile name to package manager, in precedence order. */
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-lock.yml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
]

/** Files that ask for a specific Python dependency set. */
const PYTHON_MANIFESTS = ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Pipfile', 'environment.yml', 'setup.py']

/** Container/deployment files worth reporting but never repairing automatically. */
const EXTRA_FILES = [
  ['Dockerfile', 'container'],
  ['docker-compose.yml', 'container'],
  ['docker-compose.yaml', 'container'],
  ['Makefile', 'task-runner'],
  ['justfile', 'task-runner'],
  ['Taskfile.yml', 'task-runner'],
]

/** Candidate names for the explicit, optional project manifest. */
const CUSTOM_MANIFESTS = ['.dsh-env.json', 'dsh-env.json', join('.dsh', 'env.json')]

/** Candidate names for an environment-variable template. */
const ENV_TEMPLATES = ['.env.example', '.env.sample', '.env.template', 'env.example']

/** Whether a path exists as a regular file. @param path - Absolute path. @returns True when a file is present. */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Whether a path exists as a directory. @param path - Absolute path. @returns True when a directory is present. */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Read a text file, returning null instead of throwing.
 * @param path - Absolute path.
 * @returns File text, or null when unreadable.
 */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse one `requirements.txt` line into a distribution name and its raw spec.
 * @param line - One line of the file.
 * @returns The parsed requirement, or null for comments, blanks, and options.
 */
function parseRequirement(line) {
  const text = line.split('#')[0].trim()
  if (text === '' || text.startsWith('-')) return null
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/u.exec(text)
  if (match === null) return null
  return { name: match[1], spec: text }
}

/**
 * Extract every quoted entry of a TOML array body.
 * @param body - Text between the brackets.
 * @returns Quoted entries in order.
 */
function tomlArrayEntries(body) {
  const entries = []
  const pattern = /["']([^"']+)["']/gu
  let match = pattern.exec(body)
  while (match !== null) {
    entries.push(match[1])
    match = pattern.exec(body)
  }
  return entries
}

/**
 * Extract a `[...]` section body from TOML text.
 * @param text - Whole document.
 * @param section - Section header without brackets.
 * @returns Section body, or null when absent.
 */
function tomlSection(text, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`\\[${escaped}\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`, 'u').exec(text)
  return match === null ? null : match[1]
}

/**
 * Parse the dependency information available in `pyproject.toml`
 * (PEP 621 `[project]` plus Poetry's `[tool.poetry.dependencies]`).
 * @param text - Whole document.
 * @returns `{ dependencies, requiresPython }`.
 */
function parsePyproject(text) {
  const dependencies = []
  let requiresPython = null
  const project = tomlSection(text, 'project')
  if (project !== null) {
    const array = /dependencies\s*=\s*\[([\s\S]*?)\]/u.exec(project)
    if (array !== null) {
      for (const entry of tomlArrayEntries(array[1])) dependencies.push(parseRequirement(entry))
    }
    const python = /requires-python\s*=\s*["']([^"']+)["']/u.exec(project)
    if (python !== null) requiresPython = python[1]
  }
  const poetry = tomlSection(text, 'tool.poetry.dependencies')
  if (poetry !== null) {
    for (const line of poetry.split('\n')) {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/u.exec(line)
      if (match === null || match[1].toLowerCase() === 'python') continue
      dependencies.push({ name: match[1], spec: match[1] })
    }
  }
  return { dependencies: dependencies.filter((entry) => entry !== null), requiresPython }
}

/**
 * Parse a `.tool-versions` (asdf/mise) document.
 * @param text - Whole document.
 * @returns Tool name to requested version, with `nodejs` normalized to `node`.
 */
function parseToolVersions(text) {
  const versions = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z0-9._-]+)\s+(\S+)/u.exec(line.split('#')[0])
    if (match === null) continue
    const tool = match[1].toLowerCase() === 'nodejs' ? 'node' : match[1].toLowerCase()
    versions[tool] = match[2]
  }
  return versions
}

/**
 * Parse the keys declared by an environment template.
 * @param text - Whole template.
 * @returns Distinct variable names in declaration order.
 */
function parseEnvKeys(text) {
  const keys = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)
    if (match === null || seen.has(match[1])) continue
    seen.add(match[1])
    keys.push(match[1])
  }
  return keys
}

/**
 * Locate an existing Python virtual environment inside the project.
 * @param directory - Project directory.
 * @returns Relative venv path, or null.
 */
async function findVenv(directory) {
  for (const name of ['.venv', 'venv', 'env']) {
    for (const relative of process.platform === 'win32'
      ? [['Scripts', 'python.exe']]
      : [['bin', 'python'], ['bin', 'python3']]) {
      const candidate = join(directory, name, ...relative)
      if (await isFile(candidate)) return { directory: join(directory, name), python: candidate }
    }
  }
  return null
}

/**
 * Read everything the diagnosis needs from one project directory.
 * @param directory - Absolute project directory.
 * @returns Parsed manifest state plus notes about unreadable or malformed files.
 */
export async function readProject(directory) {
  const manifests = []
  const notes = []
  const extras = []
  const record = async (file, kind) => {
    if (await isFile(join(directory, file))) {
      manifests.push({ file, kind })
      return true
    }
    return false
  }

  const node = {
    present: false,
    packageJson: null,
    packageManager: null,
    lockfile: null,
    lockfileFile: null,
    dependencies: [],
    requiredNode: null,
  }
  if (await record('package.json', 'node')) {
    node.present = true
    const text = await readText(join(directory, 'package.json'))
    try {
      node.packageJson = JSON.parse(text ?? '')
    } catch {
      notes.push('package.json is not valid JSON; Node.js checks were skipped.')
    }
    if (text !== null && node.packageJson !== null) {
      const engines = node.packageJson.engines ?? {}
      if (typeof engines.node === 'string') node.requiredNode = engines.node
      const declared = node.packageJson.packageManager
      if (typeof declared === 'string' && declared !== '') {
        const [name, version] = declared.split('@')
        node.packageManager = { name, version: version ?? null }
      }
      for (const [kind, field] of [['prod', 'dependencies'], ['dev', 'devDependencies']]) {
        const group = node.packageJson[field]
        if (group === null || typeof group !== 'object') continue
        for (const [name, range] of Object.entries(group)) node.dependencies.push({ name, range: String(range), kind })
      }
    }
  }
  for (const [file, manager] of LOCKFILES) {
    if (await record(file, 'node')) {
      node.lockfile = manager
      node.lockfileFile = file
      break
    }
  }

  const python = {
    present: false,
    requirementsFile: null,
    requirements: [],
    pyprojectPresent: false,
    pyprojectDependencies: [],
    requiresPython: null,
    venv: await findVenv(directory),
  }
  if (await record('requirements.txt', 'python')) {
    python.present = true
    python.requirementsFile = 'requirements.txt'
    const text = (await readText(join(directory, 'requirements.txt'))) ?? ''
    python.requirements = text.split('\n').map(parseRequirement).filter((entry) => entry !== null)
  }
  if (await record('pyproject.toml', 'python')) {
    python.present = true
    python.pyprojectPresent = true
    const parsed = parsePyproject((await readText(join(directory, 'pyproject.toml'))) ?? '')
    python.pyprojectDependencies = parsed.dependencies
    python.requiresPython = parsed.requiresPython
  }
  for (const file of PYTHON_MANIFESTS) {
    if (file === 'requirements.txt' || file === 'pyproject.toml') continue
    if (await record(file, 'python')) python.present = true
  }

  const toolVersions = {}
  for (const file of ['.nvmrc', '.node-version', '.tool-versions', '.python-version']) {
    if (!await record(file, 'versions')) continue
    const text = ((await readText(join(directory, file))) ?? '').trim()
    if (file === '.tool-versions') Object.assign(toolVersions, parseToolVersions(text))
    else if (file === '.python-version') toolVersions.python = text.split('\n')[0].trim()
    else toolVersions.node = text.split('\n')[0].trim()
  }

  let envTemplate = null
  let envKeys = []
  for (const file of ENV_TEMPLATES) {
    if (!await record(file, 'env')) continue
    envTemplate = file
    envKeys = parseEnvKeys((await readText(join(directory, file))) ?? '')
    break
  }
  const envFile = await isFile(join(directory, '.env'))

  for (const [file, kind] of EXTRA_FILES) {
    if (await isFile(join(directory, file))) extras.push({ file, kind })
  }

  let custom = null
  let customFile = null
  for (const file of CUSTOM_MANIFESTS) {
    if (!await isFile(join(directory, file))) continue
    customFile = file
    try {
      custom = JSON.parse((await readText(join(directory, file))) ?? '')
      manifests.push({ file, kind: 'declaration' })
    } catch {
      notes.push(`${file} is not valid JSON; the explicit declaration was ignored.`)
    }
    break
  }

  const kinds = []
  if (node.present) kinds.push('node')
  if (python.present) kinds.push('python')
  if (kinds.length === 0 && extras.length > 0) kinds.push('unrecognized')

  return {
    directory,
    manifests,
    kinds,
    node,
    python,
    toolVersions,
    envTemplate,
    envKeys,
    envFile,
    extras,
    custom,
    customFile,
    notes,
  }
}
