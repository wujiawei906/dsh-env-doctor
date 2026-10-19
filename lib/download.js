/**
 * Portable runtime acquisition: download and unpack a standalone Node.js or
 * CPython distribution under the Harness home without touching `PATH` or any
 * system-wide installation.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { runCommand } from './exec.js'
import { resolveDshHome } from './runtimes.js'

/** Where this plugin keeps runtimes it installed itself. @returns Absolute directory. */
function installRoot() {
  return join(resolveDshHome(), 'dsh-runtimes', 'env-doctor')
}

/**
 * Download one URL to a file.
 * @param url - Absolute https URL.
 * @param destination - Target file path.
 * @param options - `signal` and `timeoutMs`.
 * @returns `{ ok, bytes, error }`.
 */
export async function downloadFile(url, destination, options = {}) {
  const controller = new AbortController()
  const relay = () => controller.abort()
  options.signal?.addEventListener('abort', relay, { once: true })
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 900000)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-env-doctor' },
    })
    if (!response.ok || response.body === null) return { ok: false, bytes: 0, error: `HTTP ${response.status} for ${url}` }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
    const size = (await stat(destination)).size
    return { ok: true, bytes: size }
  } catch (error) {
    return { ok: false, bytes: 0, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relay)
  }
}

/**
 * Unpack a `.zip` or `.tar.gz` archive, preferring the platform's own tooling.
 * @param archive - Archive path.
 * @param destination - Existing directory to unpack into.
 * @param options - `signal`.
 * @returns `{ ok, error }`.
 */
async function extractArchive(archive, destination, options) {
  let firstError = null
  if (process.platform === 'win32' && archive.endsWith('.zip')) {
    const script = `Expand-Archive -LiteralPath '${archive.replace(/'/gu, "''")}' -DestinationPath '${destination.replace(/'/gu, "''")}' -Force`
    const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { signal: options.signal, timeoutMs: 600000 })
    if (!result.failed) return { ok: true }
    firstError = result.message ?? result.stderr
  }
  const tar = await runCommand('tar', ['-xf', archive, '-C', destination], { signal: options.signal, timeoutMs: 600000 })
  if (!tar.failed) return { ok: true }
  return { ok: false, error: firstError ?? tar.message ?? tar.stderr }
}

/**
 * Move the single top-level directory an archive unpacked into.
 * @param directory - Directory holding the unpacked tree.
 * @returns The resolved content directory.
 */
async function flattenSingleDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length === 1 && entries[0].isDirectory()) return join(directory, entries[0].name)
  return directory
}

/**
 * Build the Node.js distribution tag for this device.
 * @returns `{ tag, archive }` fragments for a version.
 */
function nodePlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return { tag: `win-${arch}`, extension: 'zip' }
  if (process.platform === 'darwin') return { tag: `darwin-${arch}`, extension: 'tar.gz' }
  return { tag: `linux-${arch}`, extension: 'tar.gz' }
}

/**
 * Resolve a Node.js requirement to a concrete published version.
 * @param range - Requirement text such as `>=20` or `20`.
 * @param options - `signal`.
 * @returns `{ ok, version, error }`.
 */
export async function resolveNodeVersion(range, options = {}) {
  const response = await fetch('https://nodejs.org/dist/index.json', { signal: options.signal })
  if (!response.ok) return { ok: false, error: `nodejs.org answered HTTP ${response.status}` }
  const releases = await response.json()
  const wanted = /(\d+)/u.exec(String(range ?? ''))?.[1]
  for (const release of releases) {
    if (release?.version === undefined) continue
    const version = String(release.version).replace(/^v/u, '')
    if (wanted === undefined || version.split('.')[0] === wanted) return { ok: true, version }
  }
  return { ok: false, error: `no published Node.js release matches "${range}"` }
}

/**
 * Install a portable Node.js distribution under the Harness home.
 * @param version - Concrete `x.y.z` version.
 * @param options - `signal`.
 * @returns `{ ok, node, pnpm, version, log, error }`.
 */
export async function installNodeRuntime(version, options = {}) {
  const { tag, extension } = nodePlatform()
  const target = join(installRoot(), `node-v${version}-${tag}`)
  const nodeExe = join(target, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const log = []
  try {
    if (await stat(nodeExe).then(() => true, () => false)) {
      return { ok: true, node: nodeExe, version, log: [`already installed at ${nodeExe}`] }
    }
    await mkdir(target, { recursive: true })
    const archive = join(installRoot(), `node-v${version}-${tag}.${extension}`)
    const url = `https://nodejs.org/dist/v${version}/node-v${version}-${tag}.${extension}`
    log.push(`downloading ${url}`)
    const download = await downloadFile(url, archive, { signal: options.signal })
    if (!download.ok) throw new Error(download.error)
    log.push(`downloaded ${Math.round(download.bytes / 1048576)} MiB`)
    const extraction = await extractArchive(archive, target, options)
    if (!extraction.ok) throw new Error(extraction.error)
    const content = await flattenSingleDirectory(target)
    if (content !== target) {
      for (const entry of await readdir(content)) await rename(join(content, entry), join(target, entry))
      await rm(content, { recursive: true, force: true })
    }
    await rm(archive, { force: true })
    if (!await stat(nodeExe).then(() => true, () => false)) throw new Error(`node executable missing after unpack: ${nodeExe}`)
    log.push(`installed ${nodeExe}`)
    return { ok: true, node: nodeExe, version, log }
  } catch (error) {
    return { ok: false, log, error: String(error?.message ?? error) }
  }
}

/**
 * Build the python-build-standalone asset matcher for this device.
 * @returns `{ platform, arch }` fragments of asset names.
 */
function pythonPlatform() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'win32') return { platform: 'pc-windows-msvc', arch, extension: 'tar.gz' }
  if (process.platform === 'darwin') return { platform: 'apple-darwin', arch, extension: 'tar.gz' }
  return { platform: 'unknown-linux-gnu', arch, extension: 'tar.gz' }
}

/**
 * Install a portable CPython distribution from python-build-standalone.
 * @param range - Requirement text such as `>=3.11`.
 * @param options - `signal`.
 * @returns `{ ok, python, version, log, error }`.
 */
export async function installPythonRuntime(range, options = {}) {
  const { platform, arch, extension } = pythonPlatform()
  const log = []
  try {
    const response = await fetch('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', {
      signal: options.signal,
      headers: { 'user-agent': 'dsh-env-doctor', accept: 'application/vnd.github+json' },
    })
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`)
    const release = await response.json()
    const wanted = /(\d+)\.(\d+)/u.exec(String(range ?? ''))
    const wantedPrefix = wanted === null ? null : `${wanted[1]}.${wanted[2]}.`
    const assets = Array.isArray(release.assets) ? release.assets : []
    const match = assets.find((asset) => {
      const name = String(asset?.name ?? '')
      if (!name.startsWith('cpython-') || !name.endsWith(`-${platform}-${arch}-install_only.${extension}`)) return false
      if (wantedPrefix === null) return true
      return name.slice('cpython-'.length).startsWith(wantedPrefix)
    })
    if (match === undefined) throw new Error(`no python-build-standalone asset for CPython ${range} on ${platform}-${arch}`)
    const version = /^cpython-(\d+\.\d+\.\d+)/u.exec(match.name)?.[1] ?? 'unknown'
    const target = join(installRoot(), `python-${version}-${platform}-${arch}`)
    const pythonExe = join(target, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']))
    if (await stat(pythonExe).then(() => true, () => false)) {
      return { ok: true, python: pythonExe, version, log: [`already installed at ${pythonExe}`] }
    }
    await mkdir(target, { recursive: true })
    const archive = join(installRoot(), match.name)
    log.push(`downloading ${match.browser_download_url}`)
    const download = await downloadFile(String(match.browser_download_url), archive, { signal: options.signal })
    if (!download.ok) throw new Error(download.error)
    log.push(`downloaded ${Math.round(download.bytes / 1048576)} MiB`)
    const extraction = await extractArchive(archive, target, options)
    if (!extraction.ok) throw new Error(extraction.error)
    await rm(archive, { force: true })
    if (!await stat(pythonExe).then(() => true, () => false)) throw new Error(`python executable missing after unpack: ${pythonExe}`)
    log.push(`installed ${pythonExe}`)
    return { ok: true, python: pythonExe, version, log }
  } catch (error) {
    return { ok: false, log, error: String(error?.message ?? error) }
  }
}
