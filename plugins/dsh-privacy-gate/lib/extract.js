/**
 * Adapter for the local extraction CLI (`packages/local-extract/cli.js`).
 *
 * Contract: `node cli.js --json <mode> <path> [--max-chars N] [--pages A-B]
 * [--lang deu+eng]`; exit 0 + JSON on success, exit 3 + JSON
 * `{ ok:false, blocked:true, reason, detail }` on a policy block, exit 2 on a
 * usage error. The gate turns every non-success into a tool error, so a blocked
 * conversion can never fall through as content (docs/interface-contract.md I3).
 *
 * No network, no shell: the CLI is spawned directly with the Node executable
 * that runs this plugin.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Modes accepted by the CLI. */
export const EXTRACT_MODES = Object.freeze(['pdf', 'ocr', 'doc', 'image', 'auto'])

/** Upper bound on captured stdout so a runaway CLI cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Build the argv for one extraction.
 * @param {{ mode: string, filePath: string, maxChars?: number, pages?: string, lang?: string, cliPath: string, nodePath?: string }} options
 * @returns {{ command: string, args: string[] }}
 */
export function buildExtractCommand(options) {
  const { mode, filePath, cliPath } = options
  if (typeof cliPath !== 'string' || cliPath.length === 0) throw new Error('privacy-gate: extractCli is not configured')
  if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('privacy-gate: extraction path is required')
  if (!EXTRACT_MODES.includes(mode)) throw new Error(`privacy-gate: unknown extraction mode "${String(mode)}"`)
  const args = [cliPath, '--json', mode, filePath]
  if (options.maxChars !== undefined) args.push('--max-chars', String(options.maxChars))
  if (options.pages !== undefined && options.pages !== '') args.push('--pages', options.pages)
  if (options.lang !== undefined && options.lang !== '') args.push('--lang', options.lang)
  return { command: options.nodePath ?? process.execPath, args }
}

/**
 * Normalize one CLI invocation into either extracted text or a blocked result.
 * Pure: takes the captured process outcome.
 * @param {{ status: number|null, stdout: string, stderr: string, timedOut?: boolean }} run
 * @returns {{ ok: true, mode: string, engine: string, text: string, pages?: number, warnings: string[] }
 *   | { ok: false, blocked: true, reason: string, detail?: string }}
 */
export function parseExtractOutput(run) {
  const stdout = typeof run?.stdout === 'string' ? run.stdout : ''
  const status = typeof run?.status === 'number' ? run.status : -1

  if (run?.timedOut === true) return { ok: false, blocked: true, reason: 'TIMEOUT' }

  let body
  try {
    body = JSON.parse(stdout)
  } catch {
    return { ok: false, blocked: true, reason: status === 0 ? 'PARSE_FAILED' : `EXIT_${status}` }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, blocked: true, reason: 'PARSE_FAILED' }
  }

  if (status !== 0 || body.ok !== true) {
    const reason = typeof body.reason === 'string' && body.reason.length > 0 ? body.reason : `EXIT_${status}`
    const detail = typeof body.detail === 'string' ? body.detail.slice(0, 300) : undefined
    return { ok: false, blocked: true, reason, ...(detail === undefined ? {} : { detail }) }
  }

  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return { ok: false, blocked: true, reason: 'PARSE_FAILED' }
  }
  return {
    ok: true,
    mode: typeof body.mode === 'string' ? body.mode : 'auto',
    engine: typeof body.engine === 'string' ? body.engine : 'unknown',
    text: body.text,
    ...(Number.isSafeInteger(body.pages) ? { pages: body.pages } : {}),
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((warning) => typeof warning === 'string') : [],
  }
}

/**
 * Run the local extraction CLI once.
 * @param {{ cliPath: string, nodePath?: string, mode: string, filePath: string, maxChars?: number,
 *   pages?: string, lang?: string, timeoutMs?: number }} options
 * @returns {Promise<object>} `parseExtractOutput` result.
 */
export async function runExtractCli(options) {
  if (typeof options.cliPath !== 'string' || options.cliPath.length === 0) {
    throw new Error('privacy-gate: extractCli is not configured and @shypie_privacy/local-extract is not installed; set extractCli to a local-extract cli.js path')
  }
  if (!existsSync(options.cliPath)) {
    throw new Error(`privacy-gate: local extractor CLI not found at ${options.cliPath}; document stays local and unread`)
  }
  const { command, args } = buildExtractCommand(options)
  const timeoutMs = options.timeoutMs ?? 120_000

  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflow = false
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      if (stdout.length > MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill()
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`privacy-gate: local extractor failed to start: ${error.message}`))
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      if (overflow) {
        resolve({ ok: false, blocked: true, reason: 'OUTPUT_TOO_LARGE' })
        return
      }
      try {
        resolve(parseExtractOutput({ status, stdout, stderr, timedOut }))
      } catch (error) {
        reject(error)
      }
    })
  })
}
