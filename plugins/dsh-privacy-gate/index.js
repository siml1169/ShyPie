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
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { resolveConfig } from './lib/config.js'
import { loadOrCreateKey } from './lib/keyfile.js'
import { createAudit, hashPath } from './lib/audit.js'
import { installGates } from './lib/gate.js'
import { buildToolDefinitions } from './lib/tools.js'
import { runExtractCli } from './lib/extract.js'
import { createSessionRegistry } from './lib/sessions.js'
import { buildLiveRowConfig, liveFromConfig, SETTINGS_NAMESPACE } from './lib/settings.js'

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

/**
 * Deployment defaults: the extractor is resolved from this checkout when the bundle is
 * installed by folder, and from the installed `@shypie_privacy/local-extract` package when
 * it is installed from npm — `HERE/../..` is the profile's `node_modules` in that case, so
 * the sibling path does not exist. An empty result makes the tools fail with a message that
 * names the missing setting instead of spawning a path that cannot exist.
 */
const WORKFLOW_ROOT = join(HERE, '..', '..')

function defaultExtractCli() {
  const sibling = join(WORKFLOW_ROOT, 'packages', 'local-extract', 'cli.js')
  if (existsSync(sibling)) return sibling
  try {
    return createRequire(import.meta.url).resolve('@shypie_privacy/local-extract/cli.js')
  } catch {
    return ''
  }
}

const DEPLOYMENT_DEFAULTS = Object.freeze({
  extractCli: defaultExtractCli(),
  // Never inside the repository: these hold plaintext and a secret key.
  artifactDir: join(PRIVATE_HOME, 'artifacts'),
  keyFile: join(PRIVATE_HOME, 'placeholder.key'),
  // Per-session activation record; `<DSH_HOME>/sessions` is the directory the snapshot reads.
  sessionsPath: join(PRIVATE_HOME, 'sessions.json'),
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
  egressAllowProviders: z.array(z.string()).default([]),
  egressAllowModels: z.array(z.string()).default([]),
  egressMaxChars: z.number().step(1).min(1).default(2_000_000),
  egressMaxNodes: z.number().step(1).min(1).default(200_000),
  scope: z.string().default('session'),
  sessionsPath: z.string().default(''),
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

/** Settings namespace the GUI page binds to; kebab-case, like the row id. */
export { SETTINGS_NAMESPACE, liveFromConfig } from './lib/settings.js'

/**
 * Live settings surfaced by the Settings page. These layer over the row config, which stays
 * the deployment default — a value the user has not touched is inherited from the patch.
 */
export const LiveConfig = z.object({
  scope: z.string().default('session'),
  allowPaths: z.array(z.string()).default([]),
  extractCli: z.string().default(''),
  detectors: z.array(z.string()).default([]),
  personWords: z.array(z.string()).default([]),
  blockNonTextResults: z.boolean().default(true),
  auditEnabled: z.boolean().default(false),
  auditPath: z.string().default(''),
  egressAllowProviders: z.array(z.string()).default([]),
  egressAllowModels: z.array(z.string()).default([]),
  ocrEngine: z.string().default('local'),
  visionProvider: z.string().default(''),
  visionModel: z.string().default(''),
})

/**
 * Re-resolve the config from the row layer plus a live settings value and swap it into the
 * dependency object the gates and tools read.
 * @param {object} live - a validated LiveConfig value.
 * @param {object} rowConfig - the row layer, kept below the live one.
 * @param {object} deps - the mutable dependency object.
 */
export async function applyLiveSettings(live, rowConfig, deps) {
  const merged = resolveConfig(buildLiveRowConfig(rowConfig, live), DEPLOYMENT_DEFAULTS)

  const redaction = await createRedaction(merged)
  deps.config = merged
  deps.redactor = redaction.redactor ?? null
  deps.pii = redaction.pii ?? null
  deps.state = { broken: redaction.error ?? null }
  deps.audit = createAudit(merged.audit)
  deps.sessions = createSessionRegistry({
    file: merged.sessionsPath,
    scope: merged.scope,
    sessionsDir: join(dirname(PRIVATE_HOME), 'sessions'),
  })
  return merged
}

/**
 * Register the `privacy-gate` settings namespace so the Settings page can edit it live.
 * The service is optional: without it the row config remains the only surface.
 * @param {object} ctx
 * @param {object} rowConfig
 * @param {object} deps
 * @param {(message: string) => void} warn
 */
async function registerSettings(ctx, rowConfig, deps, warn) {
  if (typeof ctx.settings?.register !== 'function') {
    warn('settings service unavailable; the row config is the only configuration surface')
    return
  }
  let brand = (value) => value
  try {
    const mod = await import('@deepseek-ai/dsh-settings')
    if (typeof mod?.settingsNamespace === 'function') brand = mod.settingsNamespace
  } catch {
    // Branding is a type-level concern; the raw namespace string is what the service stores.
  }
  try {
    const scope = ctx.settings.register(brand(SETTINGS_NAMESPACE), LiveConfig, {
      applies: 'live',
      base: liveFromConfig(deps.config),
    })
    scope.watch(async (next) => {
      try {
        await applyLiveSettings(next, rowConfig, deps)
      } catch (error) {
        warn(`a live settings change was rejected: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    warn(`settings namespace not registered: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Activate the bundle.
 * @param {object} ctx - plugin context.
 * @param {object} config - validated row config.
 */
export async function apply(ctx, config) {
  const rowConfig = config ?? {}
  const resolved = resolveConfig(rowConfig, DEPLOYMENT_DEFAULTS)
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`privacy-gate: ${message}`)
    } catch {
      // Logging must never affect activation.
    }
  }

  const audit = createAudit(resolved.audit)
  const redaction = await createRedaction(resolved)

  // One mutable dependency object: the gates and the tools read it per call, so a settings
  // change can retarget them without unloading the plugin.
  const deps = {
    ctx,
    config: resolved,
    redactor: redaction.redactor ?? null,
    pii: redaction.pii ?? null,
    state: { broken: redaction.error ?? null },
    audit,
    sessions: createSessionRegistry({
      file: resolved.sessionsPath,
      scope: resolved.scope,
      // Scope of the gate: per session (default) or the whole profile. The registry snapshots
      // the sessions that predate this activation once, so old history is never gated.
      sessionsDir: join(dirname(PRIVATE_HOME), 'sessions'),
    }),
  }

  if (deps.state.broken !== null) {
    warn(`local redaction is unavailable (${deps.state.broken.message}); every gate fails closed`)
  }

  installGates(deps)

  for (const definition of buildToolDefinitions({
    ...deps,
    runExtract: (options) => runExtractCli({
      ...options,
      cliPath: deps.config.extractCli,
      nodePath: process.execPath,
    }),
    writeArtifact,
    hashPath,
  })) {
    ctx.tools.register(definition)
  }

  await registerSettings(ctx, rowConfig, deps, warn)

  // The model-visible history and every derived request are masked; the raw
  // prompt text still exists locally in the session log (`agent/inbox/spliced`).
  // That residual is documented, not hidden — docs/research/dsh-hooks.md §5b.
  warn('active: tool results and model-visible prompts are masked; raw prompt text remains in this machine\'s session log (agent/inbox/spliced)')
}
