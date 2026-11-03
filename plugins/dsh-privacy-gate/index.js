/**
 * DSH privacy gate — a Host bundle that keeps PII local.
 *
 * Why ingestion (and not egress): DSH deep-freezes the outbound LLM request and
 * derives it as a pure fold of the session log, so no plugin can rewrite the
 * request on its way out (`dsh-agent-loop` buildRequest,
 * `ShyPie/docs/research/dsh-hooks.md` §4). Masking therefore happens
 * before bytes become model-visible events:
 *
 *   Gate 1  tools/post-execute      redact every tool result before it is logged
 *   Gate 2  privacy_extract /       local PDF/OCR extraction in this plugin, the
 *           privacy_ocr / scan /    text masked here, a blocked conversion is a
 *           rehydrate               tool error (fail closed)
 *   Gate 3  agent/pre-step          redact user text, reject attachment steps
 *   Guards  ctx.tools.guard         deny read_image and binary document reads
 *
 * The bundle is deliberately NOT installed by the repository it ships in; see
 * README.md for the install/verify steps.
 */
import z from '@deepseek-ai/schemastery'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { resolveConfig } from './lib/config.js'
import { loadOrCreateKey } from './lib/keyfile.js'
import { createAudit, hashPath } from './lib/audit.js'
import { installGates } from './lib/gate.js'
import { buildToolDefinitions } from './lib/tools.js'
import { runExtractCli } from './lib/extract.js'

/** Plugin name shown in diagnostics. */
export const name = 'privacy-gate'

/** Services this plugin needs; without `tools` it stays inactive. */
export const inject = ['tools']

/** Directory of this package (the bundle root). */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where plaintext-adjacent state lives. Not inside the repository: the placeholder key and
 * the rehydrated artifacts must not be committed, copied or shared with the bundle. A row
 * may override either path; these are only the defaults.
 */
const PRIVATE_HOME = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'privacy')
  : join(homedir(), '.dsh', 'privacy')

/** Deployment defaults: the extractor is resolved relative to this checkout if unset. */
const WORKFLOW_ROOT = join(HERE, '..', '..')
const DEPLOYMENT_DEFAULTS = Object.freeze({
  extractCli: join(WORKFLOW_ROOT, 'packages', 'local-extract', 'cli.js'),
  // Never inside the repository: these hold plaintext and a secret key.
  artifactDir: join(PRIVATE_HOME, 'artifacts'),
  keyFile: join(PRIVATE_HOME, 'placeholder.key'),
})

/**
 * Row config schema. `lib/config.js` re-validates the same keys (it is what the
 * unit tests exercise); schemastery validates the row at activation so a typo
 * fails at mount instead of mid-session.
 */
export const Config = z.object({
  allowPaths: z.array(z.string()).default([]),
  detectors: z.array(z.string()).default([]),
  personWords: z.array(z.string()).default([]),
  extractCli: z.string().default(''),
  audit: z.object({
    enabled: z.boolean().default(false),
    path: z.string().default(''),
  }),
  placeholderKey: z.object({
    file: z.string().default(''),
  }),
  blockNonTextResults: z.boolean().default(true),
  artifactDir: z.string().default(''),
  toolTimeoutMs: z.number().step(1).min(1).default(120_000),
  maxExtractChars: z.number().step(1).min(1).default(200_000),
})

/**
 * Load the vendored `pii-core` copy and build the redactor.
 * @returns {{ pii: object, redactor: object } | { error: Error }}
 */
async function createRedaction(config) {
  let pii
  try {
    pii = await import(new URL('./vendor/pii-core.js', import.meta.url).href)
  } catch (error) {
    return { error: new Error(`vendored pii-core could not be loaded (${error.message}); run scripts/vendor-core.mjs`) }
  }
  if (typeof pii.createRedactor !== 'function') {
    return { error: new Error('vendored pii-core does not export createRedactor') }
  }
  try {
    const { key } = loadOrCreateKey(config.placeholderKey.file)
    const redactor = pii.createRedactor({
      key,
      ...(config.detectors.length > 0 ? { kinds: config.detectors } : {}),
      ...(config.personWords.length > 0 ? { allowWords: config.personWords } : {}),
    })
    return { pii, redactor }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/** Write one local artifact with owner-only permissions (it holds plaintext). */
function writeArtifact(target, content) {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Activate the bundle.
 * @param {object} ctx - plugin context.
 * @param {object} config - validated row config.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config, DEPLOYMENT_DEFAULTS)
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`privacy-gate: ${message}`)
    } catch {
      // Logging must never affect activation.
    }
  }

  const audit = createAudit(resolved.audit)
  const redaction = await createRedaction(resolved)
  const state = { broken: redaction.error ?? null }
  const redactor = redaction.redactor ?? null
  const pii = redaction.pii ?? null

  if (state.broken !== null) {
    warn(`local redaction is unavailable (${state.broken.message}); every gate fails closed`)
  }

  installGates({ ctx, config: resolved, redactor, state, audit })

  for (const definition of buildToolDefinitions({
    config: resolved,
    redactor,
    pii,
    runExtract: (options) => runExtractCli({
      ...options,
      cliPath: resolved.extractCli,
      nodePath: process.execPath,
    }),
    writeArtifact,
    audit,
    hashPath,
  })) {
    ctx.tools.register(definition)
  }

  // The model-visible history and every derived request are masked; the raw
  // prompt text still exists locally in the session log (`agent/inbox/spliced`).
  // That residual is documented, not hidden — docs/research/dsh-hooks.md §5b.
  warn('active: tool results and model-visible prompts are masked; raw prompt text remains in this machine\'s session log (agent/inbox/spliced)')
}
