/** Subprocess helpers: bounded, cancellable, never throwing. */
import { execFile } from 'node:child_process'

/** Longest stdout/stderr tail kept per command. */
const MAX_OUTPUT_CHARS = 8000
/** Longest single line kept when rendering a command failure. */
const MAX_LINE_CHARS = 400

/**
 * Keep the tail of a captured stream, marking truncation.
 * @param value - Raw captured text.
 * @returns Bounded text.
 */
function bound(value) {
  const text = String(value ?? '')
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]…\n${text.slice(-MAX_OUTPUT_CHARS)}`
}

/** Whether a command name needs a Windows command shell to resolve (.cmd/.bat shims). */
function needsShell(command) {
  if (process.platform !== 'win32') return false
  if (/[\\/]/u.test(command)) return false
  return true
}

/**
 * Run one program and capture its result without ever rejecting.
 * @param command - Executable name or absolute path.
 * @param args - Argument vector.
 * @param options - `cwd`, `env` additions, `timeoutMs`, and an abort `signal`.
 * @returns `{ command, args, code, stdout, stderr, failed, timedOut, missing, message }`.
 */
export function runCommand(command, args = [], options = {}) {
  const { cwd, env, timeoutMs = 600000, signal } = options
  const useShell = needsShell(command)
  const file = useShell ? (process.env.ComSpec ?? 'cmd.exe') : command
  const argv = useShell ? ['/d', '/s', '/c', command, ...args] : args
  const printable = [command, ...args].join(' ')
  return new Promise((resolve) => {
    const finish = (result) => resolve({ command, args, printable, ...result })
    try {
      execFile(file, argv, {
        cwd,
        env: env === undefined ? process.env : { ...process.env, ...env },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        signal,
      }, (error, stdout, stderr) => {
        const missing = error?.code === 'ENOENT'
        const code = error === null || error === undefined
          ? 0
          : typeof error.code === 'number'
            ? error.code
            : missing
              ? 127
              : 1
        finish({
          code,
          stdout: bound(stdout),
          stderr: bound(stderr),
          failed: code !== 0,
          timedOut: error?.killed === true && error?.signal !== undefined,
          missing,
          message: error === null || error === undefined ? undefined : String(error.message ?? '').split('\n')[0].slice(0, MAX_LINE_CHARS),
        })
      })
    } catch (error) {
      finish({
        code: 1,
        stdout: '',
        stderr: '',
        failed: true,
        timedOut: false,
        missing: false,
        message: String(error?.message ?? error).slice(0, MAX_LINE_CHARS),
      })
    }
  })
}
