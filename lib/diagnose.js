/**
 * Diagnosis orchestration: read the project, probe the device, judge every
 * requirement, then hand the repairable ones to `repair.js` and re-check.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDirectory, isFile, readProject } from './manifests.js'
import { detectAllRuntimes } from './runtimes.js'
import { isOpenRange, satisfies } from './version.js'
import { runCommand } from './exec.js'
import { applyRepairs } from './repair.js'

/** Defaults for every knob the tool exposes. */
const DEFAULT_SETTINGS = {
  autoFix: true,
  installDependencies: true,
  allowRuntimeDownload: true,
  manageEnvFile: true,
  installTimeoutMs: 900000,
  signal: undefined,
}

/** Statuses that mean "this device is not complete yet". */
const BLOCKING = ['missing', 'mismatch', 'outdated', 'unresolved']

/**
 * Build one check record.
 * @param id - Stable check identifier.
 * @param title - Human-readable label.
 * @param status - One of ok/missing/mismatch/outdated/unresolved/info/repaired.
 * @param detail - Explanation shown to the caller.
 * @param fixable - Whether a repair action exists for it.
 * @returns The check record.
 */
function check(id, title, status, detail, fixable = false) {
  return { id, title, status, detail, fixable }
}

/**
 * Normalize a Python distribution name for comparison.
 * @param name - Distribution name.
 * @returns Canonical lowercase, dash-separated name.
 */
function normalizeName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/gu, '-')
}

/**
 * List a directory without throwing.
 * @param path - Directory path.
 * @returns Entry names, empty when unreadable.
 */
async function safeReaddir(path) {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/**
 * Select runtime candidates against an optional requirement.
 * @param candidates - Probed candidates.
 * @param requirement - Requirement text, or null.
 * @returns `{ ready, matching, best }`.
 */
function select(candidates, requirement) {
  const ready = candidates.filter((item) => item.ready)
  const matching = requirement === null || isOpenRange(requirement)
    ? ready
    : ready.filter((item) => satisfies(item.version, requirement))
  return { ready, matching, best: matching[0] ?? null }
}

/**
 * Read the installed Python distributions through pip.
 * @param python - Selected interpreter candidate.
 * @param context - Diagnosis context with `directory` and `options`.
 * @returns Distribution name to version, or null when pip is unusable.
 */
async function pipPackages(python, context) {
  const prefix = python.args.slice(0, -1)
  const result = await runCommand(python.command, [...prefix, '-m', 'pip', 'list', '--format=json', '--disable-pip-version-check'], {
    cwd: context.directory,
    timeoutMs: 120000,
    signal: context.options.signal,
  })
  if (result.failed) return null
  const start = result.stdout.indexOf('[')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(result.stdout.slice(start))
    return new Map(parsed.map((entry) => [normalizeName(entry.name), String(entry.version)]))
  } catch {
    return null
  }
}

/**
 * Choose the Node.js package manager to install with.
 * @param project - Parsed project.
 * @param runtimes - Probed runtimes.
 * @returns `{ name, prefix }`, with nulls when nothing is available.
 */
function chooseNodeManager(project, runtimes) {
  const declared = project.node.packageManager?.name ?? null
  const order = [declared, project.node.lockfile, 'pnpm', 'npm', 'yarn', 'bun']
  for (const name of order) {
    if (name === null || name === undefined) continue
    const candidate = (runtimes[name] ?? []).find((item) => item.ready)
    if (candidate !== undefined) return { name, prefix: candidate.prefix, source: candidate.label }
  }
  return { name: null, prefix: null, source: null }
}

/**
 * Judge the project's Node.js dependencies.
 * @param project - Parsed project.
 * @param context - Diagnosis context.
 * @returns `{ check, action }` when a judgement applies, else null.
 */
async function judgeNodeDependencies(project, context) {
  if (!project.node.present || project.node.dependencies.length === 0) return null
  const nodeModules = join(context.directory, 'node_modules')
  const hasNodeModules = await isDirectory(nodeModules)
  const installed = new Set(await safeReaddir(nodeModules))
  // Scoped packages live one level down (`@scope/name`), so the scope directory
  // alone must not stand in for the package itself.
  for (const entry of [...installed]) {
    if (!entry.startsWith('@')) continue
    for (const child of await safeReaddir(join(nodeModules, entry))) installed.add(`${entry}/${child}`)
  }
  const missingProd = project.node.dependencies.filter((entry) => entry.kind === 'prod' && !installed.has(entry.name))
  const missingDev = project.node.dependencies.filter((entry) => entry.kind === 'dev' && !installed.has(entry.name))
  const manager = chooseNodeManager(project, context.runtimes)
  const detailBase = manager.name === null ? '未发现可用的 Node.js 包管理器' : `将使用 ${manager.name}（${manager.source}）`
  let stale = false
  if (hasNodeModules && project.node.lockfileFile !== null) {
    const stamp = project.node.lockfile === 'pnpm'
      ? join(nodeModules, '.modules.yaml')
      : join(nodeModules, '.package-lock.json')
    const [lockTime, stampTime] = await Promise.all([
      stat(join(context.directory, project.node.lockfileFile)).then((value) => value.mtimeMs, () => null),
      stat(stamp).then((value) => value.mtimeMs, () => null),
    ])
    if (lockTime !== null && stampTime !== null) stale = lockTime > stampTime + 1000
  }
  const fixable = manager.prefix !== null && context.options.installDependencies
  const names = (entries) => `${entries.slice(0, 4).map((entry) => entry.name).join('、')}${entries.length > 4 ? ' 等' : ''}`
  if (!hasNodeModules || missingProd.length > 0) {
    const absent = hasNodeModules ? missingProd : project.node.dependencies.filter((entry) => entry.kind === 'prod')
    return {
      check: check('deps:node', 'Node.js 依赖', 'missing', `缺少 ${missingProd.length} 个生产依赖：${names(absent)}；${detailBase}`, fixable),
      action: { id: 'deps:node', title: '安装 Node.js 依赖', kind: 'install-node-dependencies', prefix: manager.prefix },
    }
  }
  if (missingDev.length > 0) {
    return {
      check: check('deps:node', 'Node.js 依赖', 'missing', `缺少 ${missingDev.length} 个开发依赖：${names(missingDev)}；${detailBase}`, fixable),
      action: { id: 'deps:node', title: '安装 Node.js 依赖', kind: 'install-node-dependencies', prefix: manager.prefix },
    }
  }
  if (stale) {
    return {
      check: check('deps:node', 'Node.js 依赖', 'outdated', `锁文件比已安装的 node_modules 更新；${detailBase}`, fixable),
      action: { id: 'deps:node', title: '同步 Node.js 依赖', kind: 'install-node-dependencies', prefix: manager.prefix },
    }
  }
  return {
    check: check('deps:node', 'Node.js 依赖', 'ok', `${project.node.dependencies.length} 个直接依赖均已安装`, false),
    action: null,
  }
}

/**
 * Judge the project's Python dependencies.
 * @param project - Parsed project.
 * @param context - Diagnosis context.
 * @returns `{ check, action }` when a judgement applies, else null.
 */
async function judgePythonDependencies(project, context) {
  const required = [...project.python.requirements, ...project.python.pyprojectDependencies]
  if (!project.python.present || required.length === 0) return null
  const unique = new Map(required.map((entry) => [normalizeName(entry.name), entry]))
  const python = context.selection.python.best
  if (python === null) {
    return {
      check: check('deps:python', 'Python 依赖', 'unresolved', `项目声明了 ${unique.size} 个依赖，但本设备没有可用的 Python 解释器`, false),
      action: null,
    }
  }
  const packages = await pipPackages(python, context)
  if (packages === null) {
    return {
      check: check('deps:python', 'Python 依赖', 'unresolved', `无法通过 ${python.version ?? '未知版本'} 的 pip 读取已安装列表；修复时将先引导 pip`, context.options.installDependencies),
      action: context.options.installDependencies
        ? { id: 'deps:python', title: '安装 Python 依赖', kind: 'install-python-dependencies', requirementsFile: project.python.requirementsFile }
        : null,
    }
  }
  const missing = []
  for (const [name, entry] of unique) {
    const installedVersion = packages.get(name)
    if (installedVersion === undefined) {
      missing.push(entry.name)
      continue
    }
    const pinned = /==\s*([0-9][^\s,;]*)/u.exec(entry.spec ?? '')
    if (pinned !== null && installedVersion !== pinned[1]) missing.push(`${entry.name}（需要 ${pinned[1]}，已装 ${installedVersion}）`)
  }
  if (missing.length === 0) {
    return {
      check: check('deps:python', 'Python 依赖', 'ok', `${unique.size} 个声明依赖均存在于 ${python.label ?? python.command}`, false),
      action: null,
    }
  }
  return {
    check: check('deps:python', 'Python 依赖', 'missing', `缺少 ${missing.length} 项：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' 等' : ''}`, context.options.installDependencies),
    action: context.options.installDependencies
      ? { id: 'deps:python', title: '安装 Python 依赖', kind: 'install-python-dependencies', requirementsFile: project.python.requirementsFile }
      : null,
  }
}

/**
 * Judge environment variables declared by a template or the explicit manifest.
 * @param project - Parsed project.
 * @param context - Diagnosis context.
 * @returns `{ check, action }` when a judgement applies, else null.
 */
async function judgeEnvironment(project, context) {
  const declared = [...new Set([...project.envKeys, ...(project.custom?.env ?? []).map(String)])]
  if (declared.length === 0) return null
  const envPath = join(context.directory, '.env')
  const existing = new Set()
  if (await isFile(envPath)) {
    const text = await readFile(envPath, 'utf8').catch(() => '')
    for (const line of String(text).split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)
      if (match !== null) existing.add(match[1])
    }
  }
  const missing = declared.filter((key) => !existing.has(key) && process.env[key] === undefined)
  if (missing.length === 0) {
    return { check: check('env:file', '环境变量', 'ok', `${declared.length} 个声明的变量均已存在`, false), action: null }
  }
  const canWrite = context.options.manageEnvFile && project.envTemplate !== null
  return {
    check: check(
      'env:file',
      '环境变量',
      'missing',
      `缺少 ${missing.length} 个变量：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''}${project.envTemplate === null ? '（项目未提供 .env 模板，需要手动填写）' : `（可从 ${project.envTemplate} 生成）`}`,
      canWrite,
    ),
    action: canWrite
      ? { id: 'env:file', title: `从 ${project.envTemplate} 生成 .env`, kind: 'create-env-file', template: project.envTemplate, keys: missing }
      : null,
  }
}

/**
 * Run every check the explicit manifest declares.
 * @param project - Parsed project.
 * @param context - Diagnosis context.
 * @returns `{ checks, actions }`.
 */
async function judgeDeclaredCommands(project, context) {
  const checks = []
  const commands = Array.isArray(project.custom?.commands) ? project.custom.commands : []
  for (const [index, entry] of commands.entries()) {
    if (entry === null || typeof entry !== 'object' || typeof entry.command !== 'string') continue
    const id = `command:${entry.id ?? index}`
    const title = typeof entry.title === 'string' ? entry.title : `检查命令 ${entry.command}`
    const expected = typeof entry.expectExitCode === 'number' ? entry.expectExitCode : 0
    const result = await runCommand(entry.command, Array.isArray(entry.args) ? entry.args.map(String) : [], {
      cwd: context.directory,
      timeoutMs: typeof entry.timeoutMs === 'number' ? entry.timeoutMs : 120000,
      signal: context.options.signal,
    })
    const ok = result.code === expected
    checks.push(check(id, title, ok ? 'ok' : 'unresolved', ok ? '命令通过' : `退出码 ${result.code}${result.message === undefined ? '' : `（${result.message}）`}`, false))
  }
  return checks
}

/**
 * Inspect a directory once, producing checks and the repairs they justify.
 * @param directory - Absolute project directory.
 * @param settings - Effective settings.
 * @returns `{ context, checks, actions }`.
 */
async function inspect(directory, settings) {
  const project = await readProject(directory)
  const runtimes = await detectAllRuntimes({ signal: settings.signal, timeoutMs: 20000 })
  const custom = project.custom !== null && typeof project.custom === 'object' && !Array.isArray(project.custom) ? project.custom : {}
  const declaredRuntimes = custom.runtimes !== null && typeof custom.runtimes === 'object' ? custom.runtimes : {}
  const requirements = {
    node: declaredRuntimes.node ?? project.toolVersions.node ?? project.node.requiredNode ?? null,
    python: declaredRuntimes.python ?? project.toolVersions.python ?? project.python.requiresPython ?? null,
    pnpm: declaredRuntimes.pnpm ?? project.toolVersions.pnpm ?? null,
    git: declaredRuntimes.git ?? null,
  }
  const selection = {
    node: select(runtimes.node ?? [], requirements.node),
    python: select(runtimes.python ?? [], requirements.python),
    pnpm: select(runtimes.pnpm ?? [], requirements.pnpm),
    npm: select(runtimes.npm ?? [], null),
    yarn: select(runtimes.yarn ?? [], null),
    bun: select(runtimes.bun ?? [], null),
    git: select(runtimes.git ?? [], null),
  }
  if (project.python.venv !== null) {
    const venvProbe = await runCommand(project.python.venv.python, ['--version'], { cwd: directory, timeoutMs: 15000, signal: settings.signal })
    const venvText = `${venvProbe.stdout}\n${venvProbe.stderr}`
    const version = /(\d+\.\d+\.\d+)/u.exec(venvText)?.[1] ?? null
    const venvCandidate = {
      id: 'project-venv',
      kind: 'python',
      source: 'project',
      label: '项目虚拟环境 .venv',
      command: project.python.venv.python,
      args: ['--version'],
      prefix: [project.python.venv.python],
      path: project.python.venv.python,
      version,
      raw: venvText.trim(),
      ready: !venvProbe.failed && version !== null,
    }
    if (venvCandidate.ready) {
      selection.python = select([venvCandidate, ...(runtimes.python ?? [])], requirements.python)
    }
  }

  const context = { directory, project, runtimes, selection, options: settings }
  const checks = []
  const actions = []
  const notes = [...project.notes]

  const needsNode = project.node.present || requirements.node !== null
  if (needsNode) {
    const { ready, matching, best } = selection.node
    if (best !== null && matching.length > 0) {
      checks.push(check('runtime:node', 'Node.js 运行时', 'ok', `已就绪：${best.version}（${best.label}）${requirements.node === null ? '' : `，满足要求 ${requirements.node}`}`, false))
    } else if (ready.length > 0) {
      checks.push(check('runtime:node', 'Node.js 运行时', 'mismatch', `已安装 ${ready[0].version}，但项目要求 ${requirements.node}`, settings.allowRuntimeDownload))
      if (settings.allowRuntimeDownload) actions.push({ id: 'runtime:node', title: `安装 Node.js ${requirements.node}`, kind: 'download-node', requirement: requirements.node })
    } else {
      checks.push(check('runtime:node', 'Node.js 运行时', 'missing', `未发现可用的 Node.js${requirements.node === null ? '' : `（要求 ${requirements.node}）`}`, settings.allowRuntimeDownload))
      if (settings.allowRuntimeDownload) actions.push({ id: 'runtime:node', title: '安装便携版 Node.js', kind: 'download-node', requirement: requirements.node })
    }
  }

  const needsPython = project.python.present || requirements.python !== null
  if (needsPython) {
    const { ready, matching, best } = selection.python
    if (best !== null && matching.length > 0) {
      checks.push(check('runtime:python', 'Python 运行时', 'ok', `已就绪：${best.version}（${best.label}）${requirements.python === null ? '' : `，满足要求 ${requirements.python}`}`, false))
    } else if (ready.length > 0) {
      checks.push(check('runtime:python', 'Python 运行时', 'mismatch', `已安装 ${ready[0].version}，但项目要求 ${requirements.python}`, settings.allowRuntimeDownload))
      if (settings.allowRuntimeDownload) actions.push({ id: 'runtime:python', title: `安装 CPython ${requirements.python}`, kind: 'download-python', requirement: requirements.python })
    } else {
      checks.push(check('runtime:python', 'Python 运行时', 'missing', `未发现可用的 Python${requirements.python === null ? '' : `（要求 ${requirements.python}）`}`, settings.allowRuntimeDownload))
      if (settings.allowRuntimeDownload) actions.push({ id: 'runtime:python', title: '安装便携版 CPython', kind: 'download-python', requirement: requirements.python })
    }
  }

  const wantsPnpm = project.node.lockfile === 'pnpm' || project.node.packageManager?.name === 'pnpm'
  if (wantsPnpm) {
    const { best } = selection.pnpm
    const declared = project.node.packageManager?.name === 'pnpm' ? `项目声明 pnpm@${project.node.packageManager.version ?? '未指定'}` : '项目使用 pnpm-lock.yaml'
    const alternative = [['npm', selection.npm.best], ['yarn', selection.yarn.best], ['bun', selection.bun.best]].find(([, candidate]) => candidate !== null)
    if (best !== null) {
      checks.push(check('runtime:pnpm', 'pnpm 包管理器', 'ok', `已就绪：${best.version}（${best.label}）；${declared}`, false))
    } else if (alternative !== undefined) {
      checks.push(check('runtime:pnpm', 'pnpm 包管理器', 'info', `本设备没有 pnpm（${declared}），依赖将改用 ${alternative[0]} 安装`, false))
    } else {
      checks.push(check('runtime:pnpm', 'pnpm 包管理器', 'missing', `本设备没有 pnpm（${declared}），也没有 npm、yarn 或 bun 可用`, false))
    }
  }

  const gitRequirement = declaredRuntimes.git ?? null
  const wantsGit = gitRequirement !== null || await isDirectory(join(directory, '.git'))
  if (wantsGit) {
    const { best } = selection.git
    if (best !== null) checks.push(check('runtime:git', 'Git', 'ok', `已就绪：${best.version}（${best.label}）`, false))
    else checks.push(check('runtime:git', 'Git', 'unresolved', '未发现 git；需要版本控制操作时请先安装 Git for Windows', false))
  }

  for (const judge of [judgeNodeDependencies, judgePythonDependencies, judgeEnvironment]) {
    const outcome = await judge(project, context)
    if (outcome === null) continue
    checks.push(outcome.check)
    if (outcome.action !== null && outcome.action !== undefined && outcome.check.fixable) actions.push(outcome.action)
  }
  checks.push(...await judgeDeclaredCommands(project, context))

  for (const extra of project.extras) {
    checks.push(check(`extra:${extra.file}`, extra.file, 'info', extra.kind === 'container' ? '容器相关文件，环境医生不会自动改动容器配置' : '项目自带的命令入口，可按需手动执行', false))
  }

  const setup = Array.isArray(custom.setup) ? custom.setup : []
  for (const [index, entry] of setup.entries()) {
    if (entry === null || typeof entry !== 'object' || typeof entry.command !== 'string') continue
    actions.push({
      id: `setup:${entry.id ?? index}`,
      title: typeof entry.title === 'string' ? entry.title : `执行 ${entry.command}`,
      kind: 'setup-command',
      argv: [entry.command, ...(Array.isArray(entry.args) ? entry.args.map(String) : [])],
    })
  }

  return { context, checks, actions, notes }
}

/**
 * Replace a check that a repair just satisfied with a `repaired` record.
 * @param before - Checks from the first pass.
 * @param after - Checks from the second pass.
 * @param repairs - Applied repair outcomes.
 * @returns Merged checks.
 */
function mergeRepairs(before, after, repairs) {
  const repaired = new Set(repairs.filter((entry) => entry.status === 'applied').map((entry) => entry.id))
  return after.map((entry) => {
    const previous = before.find((item) => item.id === entry.id)
    if (previous === undefined || !repaired.has(entry.id)) return entry
    if (BLOCKING.includes(previous.status) && entry.status === 'ok') {
      return { ...entry, status: 'repaired', detail: `${previous.detail} → 已修复：${entry.detail}` }
    }
    return entry
  })
}

/**
 * Count check statuses.
 * @param checks - Merged checks.
 * @returns Status counters.
 */
function summarize(checks) {
  const summary = { ok: 0, missing: 0, mismatch: 0, outdated: 0, unresolved: 0, info: 0, repaired: 0 }
  for (const entry of checks) {
    if (entry.status in summary) summary[entry.status] += 1
  }
  return summary
}

/**
 * Diagnose one directory and, when asked, repair it.
 * @param directory - Absolute project directory.
 * @param options - Tool arguments plus `signal`.
 * @returns The full report consumed by the tool output schema.
 * @throws When the directory cannot be read.
 */
export async function diagnose(directory, options = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...options }
  if (!await isDirectory(directory)) throw new Error(`不是可读目录：${directory}`)

  const first = await inspect(directory, settings)
  let checks = first.checks
  let repairs = []
  let notes = first.notes
  if (settings.autoFix && first.actions.length > 0) {
    repairs = await applyRepairs(first.actions, first.context)
    const second = await inspect(directory, settings)
    checks = mergeRepairs(first.checks, second.checks, repairs)
    notes = [...first.notes, ...second.notes.filter((note) => !first.notes.includes(note))]
  }

  const summary = summarize(checks)
  const blocking = checks.filter((entry) => BLOCKING.includes(entry.status))
  const hasManifest = first.context.project.manifests.length > 0
  let verdict = 'incomplete'
  if (!hasManifest && first.context.project.custom === null) verdict = 'no-manifest'
  else if (blocking.length === 0) verdict = repairs.some((entry) => entry.status === 'applied') ? 'repaired' : 'complete'

  return {
    directory,
    project: {
      kinds: first.context.project.kinds,
      manifests: first.context.project.manifests,
    },
    verdict,
    summary,
    checks,
    repairs,
    notes,
  }
}
