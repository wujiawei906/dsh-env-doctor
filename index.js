/**
 * Environment Doctor — a Host bundle for the current Harness profile.
 *
 * It registers one tool, `ensure_environment`, which reads a project's own
 * manifests (package.json and lockfiles, requirements.txt/pyproject.toml,
 * .nvmrc/.python-version/.tool-versions, .env templates, and the optional
 * `.dsh-env.json` declaration), judges whether this device is configured for
 * that project, and repairs what it can: installing dependencies, creating a
 * virtual environment, materializing `.env`, and fetching a portable runtime
 * when the device has none.
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { diagnose } from './lib/diagnose.js'

/** Cordis plugin identity. */
export const name = 'env-doctor'
/** Registry this tool registers into. */
export const inject = ['tools']

/**
 * Append one activation line to `$DSH_HOME/env-doctor.log`.
 *
 * The profile loader keeps failures in its own diagnostics; this file is the
 * one place a user can confirm that this bundle really mounted. A write
 * failure must never break activation.
 */
function noteActivation() {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    appendFileSync(join(home, 'env-doctor.log'), `${new Date().toISOString()} env-doctor activated (pid ${process.pid})\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
}

/** Human labels for check statuses. */
const STATUS_LABEL = {
  ok: '正常',
  missing: '缺失',
  mismatch: '版本不符',
  outdated: '需更新',
  unresolved: '待处理',
  info: '提示',
  repaired: '已修复',
}

/** Human labels for repair outcomes. */
const REPAIR_LABEL = {
  applied: '已执行',
  failed: '失败',
  skipped: '跳过',
}

/** Human labels for verdicts. */
const VERDICT_LABEL = {
  complete: '环境完善',
  repaired: '缺失项已自动修复',
  incomplete: '仍有未解决项',
  'no-manifest': '未发现依赖清单',
}

/** Longest rendered report handed back to the model. */
const MAX_REPORT_CHARS = 8000

/** Output schema fragment shared by every check entry. */
const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['ok', 'missing', 'mismatch', 'outdated', 'unresolved', 'info', 'repaired'] },
    detail: { type: 'string', required: true },
    fixable: { type: 'boolean', required: true },
  },
}

/**
 * Resolve the directory to inspect: an explicit argument first, then the
 * calling agent's workspace, then the process working directory.
 * @param args - Validated tool arguments.
 * @param exec - Tool execution context.
 * @returns Absolute directory path.
 */
function resolveDirectory(args, exec) {
  if (typeof args.directory === 'string' && args.directory.trim() !== '') return resolve(args.directory)
  const workspace = exec?.agent?.session?.header?.cwd
  if (typeof workspace === 'string' && workspace.trim() !== '') return workspace
  return process.cwd()
}

/**
 * Render the report as compact text for the conversation.
 * @param value - Tool output value.
 * @returns Bounded report text.
 */
function renderReport(value) {
  const lines = []
  const kinds = value.project.kinds.length === 0 ? '未识别' : value.project.kinds.join('、')
  const manifests = value.project.manifests.map((entry) => entry.file).join('、')
  lines.push(`环境诊断：${value.directory}`)
  lines.push(`项目类型：${kinds}｜判定：${VERDICT_LABEL[value.verdict] ?? value.verdict}`)
  lines.push(`依据文件：${manifests === '' ? '无' : manifests}`)
  const summary = value.summary
  lines.push(`统计：正常 ${summary.ok}，已修复 ${summary.repaired}，缺失 ${summary.missing}，版本不符 ${summary.mismatch}，需更新 ${summary.outdated}，待处理 ${summary.unresolved}，提示 ${summary.info}`)
  lines.push('')
  for (const entry of value.checks) {
    lines.push(`[${STATUS_LABEL[entry.status] ?? entry.status}] ${entry.title}：${entry.detail}`)
  }
  if (value.repairs.length > 0) {
    lines.push('', '修复记录：')
    for (const repair of value.repairs) {
      lines.push(`- ${repair.title} → ${REPAIR_LABEL[repair.status] ?? repair.status}：${repair.detail}`)
      if (typeof repair.command === 'string' && repair.command !== '') lines.push(`    命令：${repair.command}`)
      if (typeof repair.output === 'string' && repair.output !== '') lines.push(`    输出：${repair.output.replace(/\n/gu, '\n    ')}`)
    }
  }
  if (value.notes.length > 0) {
    lines.push('', '说明：')
    for (const note of value.notes) lines.push(`- ${note}`)
  }
  const text = lines.join('\n')
  return text.length <= MAX_REPORT_CHARS ? text : `${text.slice(0, MAX_REPORT_CHARS)}\n…（报告已截断）`
}

/**
 * Register the environment tool.
 * @param ctx - Plugin context providing the tool registry.
 */
export function apply(ctx) {
  noteActivation()
  ctx.tools.register(defineTool({
    name: 'ensure_environment',
    description: [
      '读取一个项目目录中的依赖与版本清单（package.json 及锁文件、requirements.txt/pyproject.toml、.nvmrc/.python-version/.tool-versions、.env 模板，以及可选的 .dsh-env.json），',
      '判断本设备的运行环境是否配置完善，并在不完善时自动补齐：安装缺失依赖、创建 Python 虚拟环境、从模板生成 .env，必要时下载便携版 Node.js/CPython。',
      '在开始一个新项目、遇到「找不到命令/模块」「依赖缺失」「环境不一致」类问题，或用户要求检查/配置本机运行环境时使用。',
      '返回结构化结果：checks 为逐项判定，repairs 为本次实际执行的修复，verdict 为 complete/repaired/incomplete/no-manifest。',
    ].join(''),
    parameters: {
      directory: { type: 'string', description: '要检查的项目目录（绝对路径或相对当前目录）；缺省使用当前工作区目录。' },
      autoFix: { type: 'boolean', description: '发现缺失时是否自动修复，默认 true；设为 false 只诊断。' },
      installDependencies: { type: 'boolean', description: '是否允许运行包管理器安装依赖，默认 true。' },
      allowRuntimeDownload: { type: 'boolean', description: '本机完全缺少所需运行时（Node.js/CPython）时，是否下载便携版到 DSH 主目录，默认 true。' },
      manageEnvFile: { type: 'boolean', description: '是否允许依据 .env 模板生成或补全 .env，默认 true。' },
      installTimeoutMs: { type: 'integer', description: '单条安装/下载命令的超时毫秒数，默认 900000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          directory: { type: 'string', required: true },
          project: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kinds: { type: 'array', required: true, items: { type: 'string' } },
              manifests: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    file: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          verdict: { type: 'string', required: true, enum: ['complete', 'repaired', 'incomplete', 'no-manifest'] },
          summary: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              ok: { type: 'integer', required: true },
              missing: { type: 'integer', required: true },
              mismatch: { type: 'integer', required: true },
              outdated: { type: 'integer', required: true },
              unresolved: { type: 'integer', required: true },
              info: { type: 'integer', required: true },
              repaired: { type: 'integer', required: true },
            },
          },
          checks: { type: 'array', required: true, items: CHECK_SCHEMA },
          repairs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['applied', 'failed', 'skipped'] },
                detail: { type: 'string', required: true },
                command: { type: 'string' },
                output: { type: 'string' },
              },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    execute: async (args, exec) => {
      const directory = resolveDirectory(args, exec)
      return diagnose(directory, {
        autoFix: args.autoFix ?? true,
        installDependencies: args.installDependencies ?? true,
        allowRuntimeDownload: args.allowRuntimeDownload ?? true,
        manageEnvFile: args.manageEnvFile ?? true,
        installTimeoutMs: args.installTimeoutMs ?? 900000,
        signal: exec?.signal,
      })
    },
    isConcurrencySafe: () => false,
    presentCall: () => ({ card: 'generic', title: '检查并补齐运行环境', kind: 'write' }),
  }))
}
