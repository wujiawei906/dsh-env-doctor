/**
 * Repair actions: everything the diagnosis decided to change on this device.
 *
 * Every action is self-contained and returns a machine-readable outcome; no
 * action throws, because a failed repair is a report line, not a tool failure.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from './exec.js'
import { installNodeRuntime, installPythonRuntime, resolveNodeVersion } from './download.js'
import { isFile } from './manifests.js'

/**
 * Read a `.env`-style file into a key set.
 * @param path - Absolute file path.
 * @returns Declared keys.
 */
async function readEnvKeys(path) {
  const keys = new Set()
  try {
    const text = await readFile(path, 'utf8')
    for (const line of text.split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)
      if (match !== null) keys.add(match[1])
    }
  } catch {
    // A missing file simply declares nothing.
  }
  return keys
}

/**
 * Keep the last few lines of command output for the report.
 * @param result - Result from `runCommand`.
 * @returns Bounded tail text.
 */
function tail(result) {
  return `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-6).join('\n').slice(0, 1500)
}

/**
 * Run the project's Node.js dependency installation with the best available
 * package manager.
 * @param action - Action carrying the command `prefix`.
 * @param context - Diagnosis context.
 * @returns Repair outcome.
 */
async function installNodeDependencies(action, context) {
  const prefix = action.prefix
  if (prefix === null || prefix === undefined) {
    return { id: action.id, title: action.title, status: 'failed', detail: '本设备没有可用的 Node.js 包管理器' }
  }
  const result = await runCommand(prefix[0], [...prefix.slice(1), 'install'], {
    cwd: context.directory,
    timeoutMs: context.options.installTimeoutMs,
    signal: context.options.signal,
  })
  return {
    id: action.id,
    title: action.title,
    status: result.failed ? 'failed' : 'applied',
    detail: result.failed ? (result.message ?? `退出码 ${result.code}`) : `已使用 ${prefix.join(' ')} 完成安装`,
    command: `${result.printable}（工作目录 ${context.directory}）`,
    output: tail(result),
  }
}

/**
 * Prepare a project virtual environment when one is missing.
 * @param context - Diagnosis context.
 * @returns `{ ok, python, detail }` where `python` is a runnable candidate.
 */
async function ensureVenv(context) {
  const { project, selection } = context
  if (project.python.venv !== null) {
    return {
      ok: true,
      python: { command: project.python.venv.python, args: ['--version'], label: '项目虚拟环境 .venv' },
      detail: '复用项目已有的 .venv',
    }
  }
  const python = selection.python.best
  if (python === null) return { ok: false, python: null, detail: '本设备没有可用的 Python 解释器' }
  const target = join(context.directory, '.venv')
  const created = await runCommand(python.command, [...python.args.slice(0, -1), '-m', 'venv', '.venv'], {
    cwd: context.directory,
    timeoutMs: context.options.installTimeoutMs,
    signal: context.options.signal,
  })
  if (created.failed) return { ok: false, python: null, detail: created.message ?? `创建 .venv 失败，退出码 ${created.code}` }
  const exe = join(target, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
  if (!await isFile(exe)) return { ok: false, python: null, detail: `已创建 .venv，但找不到解释器 ${exe}` }
  return { ok: true, python: { command: exe, args: ['--version'], label: '项目虚拟环境 .venv' }, detail: '已创建 .venv' }
}

/**
 * Install the project's Python dependencies into its environment.
 * @param action - Action describing the dependency source.
 * @param context - Diagnosis context.
 * @returns Repair outcome.
 */
async function installPythonDependencies(action, context) {
  const prepared = await ensureVenv(context)
  if (!prepared.ok) return { id: action.id, title: action.title, status: 'failed', detail: prepared.detail }
  const python = prepared.python
  const environment = { PIP_DISABLE_PIP_VERSION_CHECK: '1' }
  const steps = []
  const pip = await runCommand(python.command, ['-m', 'pip', '--version'], {
    cwd: context.directory,
    timeoutMs: 60000,
    signal: context.options.signal,
  })
  if (pip.failed) {
    const bootstrap = await runCommand(python.command, ['-m', 'ensurepip', '--upgrade'], {
      cwd: context.directory,
      timeoutMs: context.options.installTimeoutMs,
      signal: context.options.signal,
    })
    steps.push(bootstrap.failed ? '引导 pip 失败' : '已引导 pip')
  }
  const args = action.requirementsFile === null || action.requirementsFile === undefined
    ? ['-m', 'pip', 'install', '.']
    : ['-m', 'pip', 'install', '-r', action.requirementsFile]
  const result = await runCommand(python.command, args, {
    cwd: context.directory,
    env: environment,
    timeoutMs: context.options.installTimeoutMs,
    signal: context.options.signal,
  })
  const suffix = steps.length === 0 ? '' : `（${steps.join('，')}）`
  return {
    id: action.id,
    title: action.title,
    status: result.failed ? 'failed' : 'applied',
    detail: result.failed
      ? `${prepared.detail}；安装失败：${result.message ?? `退出码 ${result.code}`}${suffix}`
      : `${prepared.detail}；依赖已安装${suffix}`,
    command: `${result.printable}（工作目录 ${context.directory}）`,
    output: tail(result),
  }
}

/**
 * Materialize a `.env` file from the project's template, adding only keys that
 * are still absent.
 * @param action - Action carrying the template name and missing keys.
 * @param context - Diagnosis context.
 * @returns Repair outcome.
 */
async function createEnvFile(action, context) {
  const target = join(context.directory, '.env')
  const templatePath = join(context.directory, action.template)
  const missing = action.keys ?? []
  try {
    if (!await isFile(target)) {
      const template = await readFile(templatePath, 'utf8')
      const declared = new Set()
      for (const line of template.split('\n')) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)
        if (match !== null) declared.add(match[1])
      }
      const extra = missing.filter((key) => !declared.has(key))
      const content = extra.length === 0
        ? template
        : `${template.replace(/\n*$/u, '\n')}\n# added by env-doctor\n${extra.map((key) => `${key}=`).join('\n')}\n`
      await writeFile(target, content, 'utf8')
      return {
        id: action.id,
        title: action.title,
        status: 'applied',
        detail: `已从 ${action.template} 生成 .env${extra.length === 0 ? '' : `，并补充 ${extra.length} 个模板外的声明变量`}`,
        command: `${action.template} -> .env`,
      }
    }
    const existing = await readEnvKeys(target)
    const absent = missing.filter((key) => !existing.has(key))
    if (absent.length === 0) return { id: action.id, title: action.title, status: 'skipped', detail: '.env 已包含模板中的全部变量' }
    await appendFile(target, `\n# added by env-doctor\n${absent.map((key) => `${key}=`).join('\n')}\n`, 'utf8')
    return { id: action.id, title: action.title, status: 'applied', detail: `已向 .env 追加 ${absent.length} 个空值变量`, command: `append ${absent.join(', ')} -> .env` }
  } catch (error) {
    return { id: action.id, title: action.title, status: 'failed', detail: String(error?.message ?? error) }
  }
}

/**
 * Download and unpack a portable runtime into the Harness home.
 * @param action - Action naming the runtime and its requirement.
 * @param context - Diagnosis context.
 * @returns Repair outcome.
 */
async function downloadRuntime(action, context) {
  if (action.kind === 'download-node') {
    const resolved = await resolveNodeVersion(action.requirement, { signal: context.options.signal })
    if (!resolved.ok) return { id: action.id, title: action.title, status: 'failed', detail: resolved.error }
    const installed = await installNodeRuntime(resolved.version, { signal: context.options.signal })
    return {
      id: action.id,
      title: action.title,
      status: installed.ok ? 'applied' : 'failed',
      detail: installed.ok ? `已安装 Node.js ${installed.version}（${installed.node}）` : `下载失败：${installed.error}`,
      command: `download Node.js v${resolved.version}`,
      output: installed.log.join('\n').slice(0, 1200),
    }
  }
  const installed = await installPythonRuntime(action.requirement, { signal: context.options.signal })
  return {
    id: action.id,
    title: action.title,
    status: installed.ok ? 'applied' : 'failed',
    detail: installed.ok ? `已安装 CPython ${installed.version}（${installed.python}）` : `下载失败：${installed.error}`,
    command: `download CPython ${action.requirement}`,
    output: installed.log.join('\n').slice(0, 1200),
  }
}

/**
 * Run a project-declared setup command.
 * @param action - Action carrying the command vector.
 * @param context - Diagnosis context.
 * @returns Repair outcome.
 */
async function runSetupCommand(action, context) {
  const [command, ...args] = action.argv
  if (command === undefined) return { id: action.id, title: action.title, status: 'skipped', detail: '命令为空' }
  const result = await runCommand(command, args, {
    cwd: context.directory,
    timeoutMs: context.options.installTimeoutMs,
    signal: context.options.signal,
  })
  return {
    id: action.id,
    title: action.title,
    status: result.failed ? 'failed' : 'applied',
    detail: result.failed ? (result.message ?? `退出码 ${result.code}`) : '命令执行完成',
    command: `${result.printable}（工作目录 ${context.directory}）`,
    output: tail(result),
  }
}

/**
 * Execute one planned repair.
 * @param action - Planned action.
 * @param context - Diagnosis context.
 * @returns Repair outcome.
 */
export async function executeAction(action, context) {
  switch (action.kind) {
    case 'install-node-dependencies':
      return installNodeDependencies(action, context)
    case 'install-python-dependencies':
      return installPythonDependencies(action, context)
    case 'create-env-file':
      return createEnvFile(action, context)
    case 'download-node':
    case 'download-python':
      return downloadRuntime(action, context)
    case 'setup-command':
      return runSetupCommand(action, context)
    default:
      return { id: action.id, title: action.title, status: 'skipped', detail: `不支持的动作 ${action.kind}` }
  }
}

/**
 * Execute planned repairs in order.
 * @param actions - Planned actions.
 * @param context - Diagnosis context.
 * @returns Repair outcomes.
 */
export async function applyRepairs(actions, context) {
  const outcomes = []
  for (const action of actions) {
    try {
      outcomes.push(await executeAction(action, context))
    } catch (error) {
      outcomes.push({ id: action.id, title: action.title, status: 'failed', detail: String(error?.message ?? error) })
    }
  }
  return outcomes
}
