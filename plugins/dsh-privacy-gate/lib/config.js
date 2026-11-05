/**
 * Pure configuration resolution for the DSH privacy gate.
 *
 * No imports: evaluated directly by the unit tests. The resolved value is a
 * detached, deeply frozen plain object, so a later mutation of the row config
 * can never change gate behaviour mid-session.
 */

/**
 * Every accepted configuration key (unknown keys are a startup error).
 * There is deliberately no `failClosed` switch: the gate always fails closed, and a
 * config key that looked like it could turn that off was removed after review.
 */
export const CONFIG_KEYS = Object.freeze([
  'allowPaths',
  'detectors',
  'personWords',
  'extractCli',
  'audit',
  'placeholderKey',
  'blockNonTextResults',
  'artifactDir',
  'toolTimeoutMs',
  'maxExtractChars',
  'egressAllowProviders',
  'egressAllowModels',
  'egressMaxChars',
  'egressMaxNodes',
  'scope',
  'sessionsPath',
  'allowAgentDisable',
  'ocrEngine',
  'ocrLang',
  'imageParts',
  'fileParts',
  'textPolicy',
  'visionProvider',
  'visionModel',
])

/** Defaults for a deployment that configures nothing. */
export const DEFAULTS = Object.freeze({
  allowPaths: [],
  detectors: [],
  personWords: [],
  extractCli: '',
  audit: Object.freeze({ enabled: false, path: '' }),
  placeholderKey: Object.freeze({ file: '' }),
  blockNonTextResults: true,
  artifactDir: '',
  toolTimeoutMs: 120_000,
  maxExtractChars: 200_000,
  // Filter mode keeps raw local text; only the Magpie gateway is allowed to receive it by default.
  egressAllowProviders: ['magpie*'],
  egressAllowModels: [],
  egressMaxChars: 2_000_000,
  egressMaxNodes: 200_000,
  // Per-session activation is the default: a session that predates first activation is left
  // alone instead of blocking every turn on history that cannot be masked.
  scope: 'session',
  sessionsPath: '',
  // Extractor preference. 'local' never leaves the machine; 'vision' would opt into a model
  // call for images the local engines cannot read, and is configuration-only for now.
  allowAgentDisable: false,
  ocrEngine: 'local',
  ocrLang: '',
  // What a prompt attachment (an `image` content block) becomes: 'ocr' reads it
  // with the local extractor and sends masked text, 'block' rejects the step.
  // 'ocr' is the default because blocking a scan the machine could read defeats
  // the point of the gate; extraction failure still blocks (see lib/ingest.js).
  imageParts: 'ocr',
  // PDF/Office attachments are extracted locally and stored as text; 'block' rejects them.
  fileParts: 'extract',
  // 'filter' keeps raw local text and lets Magpie mask the outbound request; 'mask' redacts locally.
  textPolicy: 'filter',
  visionProvider: '',
  visionModel: '',
})

function fail(message) {
  throw new Error(`privacy-gate config: ${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(name, value) {
  if (!Array.isArray(value)) fail(`${name} must be an array of strings`)
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) fail(`${name} must contain non-empty strings`)
  }
  return value.map((item) => item.trim())
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`)
  return value
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * Validate and normalize one plugin row config.
 * @param {unknown} raw - the row's `config` value.
 * @param {Record<string, string>} base - deployment paths supplied by `index.js`
 *   (`extractCli`, `artifactDir`, `keyFile`), used when the row leaves a path empty.
 * @returns The resolved configuration.
 */
export function resolveConfig(raw = {}, base = {}) {
  if (raw === undefined || raw === null) raw = {}
  if (!isPlainObject(raw)) fail('config must be an object')

  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) {
      fail(`unknown key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`)
    }
  }

  const auditRaw = raw.audit ?? {}
  if (!isPlainObject(auditRaw)) fail('audit must be an object')
  const keyRaw = raw.placeholderKey ?? {}
  if (!isPlainObject(keyRaw)) fail('placeholderKey must be an object')

  const resolved = {
    allowPaths: stringList('allowPaths', raw.allowPaths ?? DEFAULTS.allowPaths),
    detectors: stringList('detectors', raw.detectors ?? DEFAULTS.detectors),
    personWords: stringList('personWords', raw.personWords ?? DEFAULTS.personWords),
    extractCli: typeof (raw.extractCli ?? '') === 'string' ? (raw.extractCli ?? '') : fail('extractCli must be a string'),
    audit: {
      enabled: auditRaw.enabled ?? false,
      path: auditRaw.path ?? '',
    },
    placeholderKey: {
      file: keyRaw.file ?? '',
    },
    blockNonTextResults: raw.blockNonTextResults ?? DEFAULTS.blockNonTextResults,
    artifactDir: typeof (raw.artifactDir ?? '') === 'string' ? (raw.artifactDir ?? '') : fail('artifactDir must be a string'),
    toolTimeoutMs: positiveInteger('toolTimeoutMs', raw.toolTimeoutMs ?? DEFAULTS.toolTimeoutMs),
    maxExtractChars: positiveInteger('maxExtractChars', raw.maxExtractChars ?? DEFAULTS.maxExtractChars),
    egressAllowProviders: stringList('egressAllowProviders', raw.egressAllowProviders ?? DEFAULTS.egressAllowProviders),
    egressAllowModels: stringList('egressAllowModels', raw.egressAllowModels ?? DEFAULTS.egressAllowModels),
    egressMaxChars: positiveInteger('egressMaxChars', raw.egressMaxChars ?? DEFAULTS.egressMaxChars),
    egressMaxNodes: positiveInteger('egressMaxNodes', raw.egressMaxNodes ?? DEFAULTS.egressMaxNodes),
    scope: raw.scope ?? DEFAULTS.scope,
    sessionsPath: typeof (raw.sessionsPath ?? '') === 'string' ? (raw.sessionsPath ?? '') : fail('sessionsPath must be a string'),
    allowAgentDisable: raw.allowAgentDisable ?? DEFAULTS.allowAgentDisable,
    ocrEngine: raw.ocrEngine ?? DEFAULTS.ocrEngine,
    ocrLang: typeof (raw.ocrLang ?? '') === 'string' ? (raw.ocrLang ?? '') : fail('ocrLang must be a string'),
    imageParts: raw.imageParts ?? DEFAULTS.imageParts,
    fileParts: raw.fileParts ?? DEFAULTS.fileParts,
    textPolicy: raw.textPolicy ?? DEFAULTS.textPolicy,
    visionProvider: typeof (raw.visionProvider ?? '') === 'string' ? (raw.visionProvider ?? '') : fail('visionProvider must be a string'),
    visionModel: typeof (raw.visionModel ?? '') === 'string' ? (raw.visionModel ?? '') : fail('visionModel must be a string'),
  }

  if (resolved.scope !== 'session' && resolved.scope !== 'system') fail('scope must be "session" or "system"')
  if (!['local', 'vision', 'auto'].includes(resolved.ocrEngine)) fail('ocrEngine must be "local", "vision" or "auto"')
  if (resolved.imageParts !== 'ocr' && resolved.imageParts !== 'block') fail('imageParts must be "ocr" or "block"')
  if (resolved.fileParts !== 'extract' && resolved.fileParts !== 'block') fail('fileParts must be "extract" or "block"')
  if (resolved.textPolicy !== 'filter' && resolved.textPolicy !== 'mask') fail('textPolicy must be "filter" or "mask"')
  if (typeof resolved.allowAgentDisable !== 'boolean') fail('allowAgentDisable must be a boolean')

  if (typeof resolved.blockNonTextResults !== 'boolean') fail('blockNonTextResults must be a boolean')
  if (typeof resolved.audit.enabled !== 'boolean') fail('audit.enabled must be a boolean')
  if (typeof resolved.audit.path !== 'string') fail('audit.path must be a string')
  if (typeof resolved.placeholderKey.file !== 'string') fail('placeholderKey.file must be a string')
  if (resolved.audit.enabled && resolved.audit.path.length === 0) fail('audit.path is required when audit.enabled is true')

  // Deployment-supplied fallbacks for the path-valued settings.
  resolved.extractCli = resolved.extractCli.length > 0 ? resolved.extractCli : (base.extractCli ?? '')
  resolved.artifactDir = resolved.artifactDir.length > 0 ? resolved.artifactDir : (base.artifactDir ?? '')
  resolved.sessionsPath = resolved.sessionsPath.length > 0 ? resolved.sessionsPath : (base.sessionsPath ?? '')
  resolved.placeholderKey.file = resolved.placeholderKey.file.length > 0
    ? resolved.placeholderKey.file
    : (base.keyFile ?? '')

  if (resolved.extractCli.length === 0) fail('extractCli has no default in this deployment')
  if (resolved.artifactDir.length === 0) fail('artifactDir has no default in this deployment')
  if (resolved.placeholderKey.file.length === 0) fail('placeholderKey.file has no default in this deployment')

  return deepFreeze(structuredClone(resolved))
}
