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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

import { resolveConfig } from './lib/config.js'
import { loadOrCreateKey } from './lib/keyfile.js'
import { createAudit, hashPath } from './lib/audit.js'
import { installGates } from './lib/gate.js'
import { buildToolDefinitions } from './lib/tools.js'
import { runExtractCli } from './lib/extract.js'
import { createSessionRegistry } from './lib/sessions.js'
import { buildLiveRowConfig, liveFromConfig } from './lib/settings.js'
import { loadSettings, registerRoutes } from './lib/http.js'

/** Plugin name shown in diagnostics. */
export const name = 'privacy-gate'

/** Services this plugin needs; without `tools` it stays inactive. `webServer` is resolved later
 * in a child scope for the settings route, so it never blocks the entry's activation. */
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
  ocrEngine: z.string().default('local'),
  ocrLang: z.string().default(''),
  imageParts: z.string().default('ocr'),
  visionProvider: z.string().default(''),
  visionModel: z.string().default(''),
  allowAgentDisable: z.boolean().default(false),
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

/** The live-settings projection shared with the Settings page. */
export { liveFromConfig } from './lib/settings.js'

/**
 * Re-resolve the config from the row layer plus a live settings value and swap it into the
 * dependency object the gates and tools read.
 * @param {object} live - a live settings value (see `liveFromConfig`).
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
 * Mount the same-origin settings API the page talks to.
 *
 * The page cannot use a settings namespace: the host api-proxy serves only an allowlist of
 * namespaces and third-party ones answer `settings-not-exposed`. The working third-party plugins in
 * this profile (Plugin Hub) instead register their own routes, so this mirrors that.
 * @param {object} ctx
 * @param {string} file - JSON record outside the repository.
 * @param {object} rowConfig
 * @param {object} deps
 * @param {(message: string) => void} warn
 */
function mountSettingsApi(ctx, file, rowConfig, deps, warn) {
  // The OCR capability probe spawns PowerShell on Windows; cache it so a page refresh is cheap.
  let engines = { at: 0, value: { engines: [], note: '' } }
  const probeEngines = async () => {
    if (Date.now() - engines.at < 5 * 60_000) return engines.value
    let value = { engines: [], note: '' }
    try {
      const cliPath = deps.config.extractCli
      if (typeof cliPath === 'string' && cliPath.length > 0) {
        const module = join(dirname(cliPath), 'engines.js')
        if (existsSync(module)) {
          const mod = await import(pathToFileURL(module).href)
          if (typeof mod.detectOcrEngines === 'function') {
            // `detectOcrEngines()` answers `{ engines, detail }`, not a bare array.
            const detection = await mod.detectOcrEngines()
            const list = Array.isArray(detection) ? detection : Array.isArray(detection?.engines) ? detection.engines : []
            value = {
              engines: list.map((engine) => ({
                name: String(engine?.name ?? 'unknown'),
                available: true,
                detail: Number.isSafeInteger(engine?.maxImageDimension) ? `max image ${engine.maxImageDimension}px` : '',
                languages: Array.isArray(engine?.languages) ? engine.languages.map(String) : [],
              })),
              note: typeof detection?.detail === 'string' ? detection.detail : '',
            }
          }
        }
      }
    } catch (error) {
      warn(`OCR probe failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    engines = { at: Date.now(), value }
    return value
  }

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () =>
        registerRoutes(host.webServer, {
          file,
          warn,
          apply: async (value) => {
            const base = liveFromConfig(resolveConfig(rowConfig, DEPLOYMENT_DEFAULTS))
            await applyLiveSettings({ ...base, ...value }, rowConfig, deps)
          },
          describe: () => ({
            value: liveFromConfig(deps.config),
            revision: loadSettings(file).revision,
            defaults: liveFromConfig(resolveConfig(rowConfig, DEPLOYMENT_DEFAULTS)),
          }),
          session: {
            get: (id) => deps.sessions.status(id),
            set: (id, enabled) => {
              deps.sessions.setEnabled(id, enabled)
              return deps.sessions.status(id)
            },
          },
          probeEngines,
        }),
      'privacy-gate: settings routes',
    )
  })
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
    // Prompt attachments are opaque references: only the host's attachment service can
    // read their bytes. `ctx.get` keeps this optional — without the service the step is
    // rejected instead of the entry failing to activate (see lib/ingest.js).
    readAttachment: (attachment, signal) => {
      const store = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
      if (store === undefined || store === null || typeof store.readImage !== 'function') {
        throw new Error('privacy-gate: the attachment service is unavailable')
      }
      return store.readImage(attachment, signal)
    },
    runOcr: (options) => runExtractCli({
      ...options,
      cliPath: deps.config.extractCli,
      nodePath: process.execPath,
    }),
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

  // Persisted page settings layer over the row config, so a restart keeps what the user saved.
  const settingsFile = join(PRIVATE_HOME, 'settings.json')
  const saved = loadSettings(settingsFile)
  if (Object.keys(saved.value).length > 0) {
    try {
      await applyLiveSettings({ ...liveFromConfig(resolved), ...saved.value }, rowConfig, deps)
    } catch (error) {
      warn(`saved settings were ignored (${error instanceof Error ? error.message : String(error)}); the row config applies`)
    }
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

  mountSettingsApi(ctx, settingsFile, rowConfig, deps, warn)

  // The model-visible history and every derived request are masked; the raw
  // prompt text still exists locally in the session log (`agent/inbox/spliced`).
  // That residual is documented, not hidden — docs/research/dsh-hooks.md §5b.
  warn('active: tool results and model-visible prompts are masked; raw prompt text remains in this machine\'s session log (agent/inbox/spliced)')
}
