/**
 * Runtime discovery: what the device provides through `PATH`, what the Harness
 * ships as a bundled payload, and what sits in well-known install directories
 * that were never added to `PATH`.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { runCommand } from './exec.js'
import { isDirectory, isFile } from './manifests.js'

/** Absolute Harness home directory. @returns `$DSH_HOME`, else `~/.dsh`. */
export function resolveDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(os.homedir(), '.dsh')
}

/**
 * Build a candidate from an executable path whose version is printed by `--version`.
 * @param kind - Runtime family.
 * @param source - Where the candidate came from.
 * @param label - Human-readable origin.
 * @param command - Executable name or path.
 * @param args - Version-printing arguments.
 * @returns A candidate record.
 */
function candidate(kind, source, label, command, args) {
  return {
    id: `${source}:${command}`,
    kind,
    source,
    label,
    command,
    args,
    prefix: [command],
    path: /[\\/]/u.test(command) ? command : null,
    version: null,
    raw: '',
    ready: false,
  }
}

/**
 * Enumerate bundled payloads under `$DSH_HOME/dsh-runtimes`.
 * @returns Candidates for bundled Node.js, pnpm, and Python, when present.
 */
export async function listBundledRuntimes() {
  const root = join(resolveDshHome(), 'dsh-runtimes')
  const found = { node: [], python: [], pnpm: [] }
  if (!await isDirectory(root)) return found
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dependencies = join(root, entry.name, 'dependencies')
    const nodeExe = join(dependencies, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    const pnpmEntry = join(dependencies, 'pnpm', 'bin', 'pnpm.mjs')
    const pythonExe = join(dependencies, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']))
    const label = `bundled runtime "${entry.name}"`
    if (await isFile(nodeExe)) {
      found.node.push(candidate('node', 'bundled', label, nodeExe, ['--version']))
    }
    if (await isFile(pnpmEntry) && await isFile(nodeExe)) {
      const pnpm = candidate('pnpm', 'bundled', label, nodeExe, [pnpmEntry, '--version'])
      pnpm.prefix = [nodeExe, pnpmEntry]
      pnpm.path = pnpmEntry
      found.pnpm.push(pnpm)
    }
    if (await isFile(pythonExe)) {
      found.python.push(candidate('python', 'bundled', label, pythonExe, ['--version']))
    }
  }
  return found
}

/**
 * Python interpreters installed in the well-known Windows locations, which are
 * frequently absent from `PATH`.
 * @returns Candidate records.
 */
async function wellKnownWindowsPython() {
  const candidates = []
  const roots = [
    process.env.LOCALAPPDATA === undefined ? null : join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
    process.env.ProgramFiles === undefined ? null : join(process.env.ProgramFiles, 'Python'),
  ]
  for (const root of roots) {
    if (root === null || !await isDirectory(root)) continue
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Python\s*3/u.test(entry.name)) continue
      const exe = join(root, entry.name, 'python.exe')
      if (await isFile(exe)) candidates.push(candidate('python', 'well-known', 'Windows install directory', exe, ['--version']))
    }
  }
  return candidates
}

/**
 * Candidate list for one runtime family: system names first, then well-known
 * absolute locations.
 * @param kind - Runtime family.
 * @returns Ordered candidates.
 */
export async function builtinCandidates(kind) {
  const path = process.env.PATH ?? ''
  const list = []
  switch (kind) {
    case 'node': {
      list.push(candidate('node', 'system', 'PATH', 'node', ['--version']))
      const programFiles = process.env.ProgramFiles
      if (programFiles !== undefined) {
        const exe = join(programFiles, 'nodejs', 'node.exe')
        if (await isFile(exe)) list.push(candidate('node', 'well-known', 'Windows install directory', exe, ['--version']))
      }
      break
    }
    case 'python': {
      if (process.platform === 'win32') {
        list.push(candidate('python', 'system', 'PATH', 'python', ['--version']))
        list.push(candidate('python', 'system', 'PATH (py launcher)', 'py', ['-3', '--version']))
      } else {
        list.push(candidate('python', 'system', 'PATH', 'python3', ['--version']))
        list.push(candidate('python', 'system', 'PATH', 'python', ['--version']))
      }
      list.push(...await wellKnownWindowsPython())
      break
    }
    case 'pnpm':
      list.push(candidate('pnpm', 'system', 'PATH', 'pnpm', ['--version']))
      break
    case 'npm':
      list.push(candidate('npm', 'system', 'PATH', 'npm', ['--version']))
      break
    case 'yarn':
      list.push(candidate('yarn', 'system', 'PATH', 'yarn', ['--version']))
      break
    case 'bun':
      list.push(candidate('bun', 'system', 'PATH', 'bun', ['--version']))
      break
    case 'git':
      list.push(candidate('git', 'system', 'PATH', 'git', ['--version']))
      if (process.env.ProgramFiles !== undefined) {
        const exe = join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe')
        if (await isFile(exe)) list.push(candidate('git', 'well-known', 'Windows install directory', exe, ['--version']))
      }
      break
    case 'uv':
      list.push(candidate('uv', 'system', 'PATH', 'uv', ['--version']))
      break
    default:
      break
  }
  if (path === '' && list.length === 0) return []
  return list
}

/**
 * Run one candidate's version probe.
 * @param item - Candidate record.
 * @param options - `signal` and `timeoutMs`.
 * @returns The candidate with `version`, `raw`, and `ready` filled in.
 */
export async function probeRuntime(item, options = {}) {
  const result = await runCommand(item.command, item.args, {
    timeoutMs: options.timeoutMs ?? 20000,
    signal: options.signal,
  })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  const match = /(\d+(?:\.\d+){1,3})/u.exec(text)
  return {
    ...item,
    raw: text.split('\n').find((line) => line.trim() !== '') ?? '',
    version: match === null ? null : match[1],
    ready: !result.failed && match !== null,
    failure: result.failed ? (result.missing ? 'not found' : (result.message ?? `exit ${result.code}`)) : undefined,
  }
}

/**
 * Probe every candidate for one runtime family; ready candidates come first,
 * bundled payloads ahead of system installs.
 * @param kind - Runtime family.
 * @param options - `signal`, `timeoutMs`, and `includeBundled`.
 * @returns Probed candidates in preference order.
 */
export async function detectRuntime(kind, options = {}) {
  const bundled = options.includeBundled === false ? { node: [], python: [], pnpm: [] } : await listBundledRuntimes()
  const probed = []
  for (const item of bundled[kind] ?? []) probed.push(await probeRuntime(item, options))
  for (const item of await builtinCandidates(kind)) probed.push(await probeRuntime(item, options))
  const rank = (item) => (item.ready ? 0 : 1) * 2 + (item.source === 'bundled' ? 0 : 1)
  return probed.sort((left, right) => rank(left) - rank(right))
}

/**
 * Detect every runtime this plugin can act on.
 * @param options - `signal` and `timeoutMs`.
 * @returns Map of runtime family to probed candidates, best first.
 */
export async function detectAllRuntimes(options = {}) {
  const families = ['node', 'pnpm', 'npm', 'yarn', 'bun', 'python', 'git', 'uv']
  const entries = await Promise.all(families.map(async (kind) => [kind, await detectRuntime(kind, options)]))
  return Object.fromEntries(entries)
}
