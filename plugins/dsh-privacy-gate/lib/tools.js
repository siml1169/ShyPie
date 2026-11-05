/**
 * The gate's four model-facing tools.
 *
 * Every tool is a plain `ToolDefinition` (name/description/parameters/output/
 * execute), i.e. the raw form accepted by `ctx.tools.register()` — see the
 * research note §3 for why argument validation therefore lives here.
 *
 * The invariant every tool enforces: **nothing but redacted text can leave the
 * tool**. A blocked extraction, a binary-hit text, or an unavailable redactor is
 * a thrown error, never content (docs/interface-contract.md I3).
 */
import { join, isAbsolute, normalize } from 'node:path'
import { realpathSync } from 'node:fs'
import { objectSchema, parseArguments } from './schema.js'
import { redactText, tokenSummary, hitSummary } from './redact.js'
import { isWithinPath, isPathAllowed } from './paths.js'

/**
 * Gate 2 owns the path policy for documents (docs/interface-contract.md): a document may be read only
 * from `allowPaths`, and `..`/symlink escapes are rejected by checking both the lexical
 * path and its realpath. Empty `allowPaths` means nothing is allowed (fail closed).
 * @param {string} filePath
 * @param {{ allowPaths: string[] }} config
 * @returns {string} the resolved path to hand to the extractor
 */
function resolveAllowedDocument(filePath, config) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('privacy-gate: a document path is required')
  }
  let real = filePath
  try {
    real = realpathSync.native(filePath)
  } catch {
    // Missing file: keep the lexical path so the extractor reports the real error. The
    // lexical check below still applies to it.
  }
  if (!isPathAllowed(filePath, config.allowPaths) || !isPathAllowed(real, config.allowPaths)) {
    throw new Error(
      'privacy-gate: document path is outside allowPaths; local extraction refused and no bytes were read',
    )
  }
  return real
}

/** Placeholder summary schema shared by the token/hit outputs. */
const SUMMARY_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    count: { type: 'integer' },
    length: { type: 'integer' },
  },
  required: ['kind', 'count', 'length'],
}

const EXTRACTED_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string' },
    engine: { type: 'string' },
    text: { type: 'string' },
    chars: { type: 'integer' },
    pages: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    redacted: { type: 'boolean' },
    tokens: { type: 'array', items: SUMMARY_ITEM_SCHEMA },
  },
  required: ['mode', 'engine', 'text', 'chars', 'pages', 'warnings', 'redacted', 'tokens'],
}

const SCAN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    redacted: { type: 'boolean' },
    hits: { type: 'array', items: SUMMARY_ITEM_SCHEMA },
  },
  required: ['text', 'redacted', 'hits'],
}

const REHYDRATE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    replaced: { type: 'integer' },
    kinds: { type: 'array', items: { type: 'string' } },
  },
  required: ['path', 'replaced', 'kinds'],
}

/** Extractor parameter spec (`privacy_extract`). */
export const EXTRACT_SPEC = Object.freeze({
  path: { type: 'string', required: true, description: 'Absolute path of the local document. It is never uploaded.' },
  mode: { type: 'string', enum: ['pdf', 'doc', 'auto'], description: 'Extraction mode. Defaults to auto.' },
  max_chars: { type: 'integer', description: 'Maximum extracted characters.' },
  pages: { type: 'string', description: 'Page range such as 1-5.' },
  lang: { type: 'string', description: 'OCR languages such as deu+eng.' },
})

/** OCR parameter spec (`privacy_ocr`). */
export const OCR_SPEC = Object.freeze({
  path: { type: 'string', required: true, description: 'Absolute path of the local image or scanned PDF. It is never uploaded.' },
  max_chars: { type: 'integer', description: 'Maximum extracted characters.' },
  pages: { type: 'string', description: 'Page range such as 1-5.' },
  lang: { type: 'string', description: 'OCR languages such as deu+eng.' },
})

/** Inline scan parameter spec (`privacy_scan`). */
export const SCAN_SPEC = Object.freeze({
  text: { type: 'string', required: true, minLength: 1, description: 'Text to scan and mask.' },
})

/** Rehydrate parameter spec (`privacy_rehydrate`). */
export const REHYDRATE_SPEC = Object.freeze({
  text: { type: 'string', required: true, minLength: 1, description: 'Text containing placeholders.' },
  artifact_path: {
    type: 'string',
    required: true,
    minLength: 1,
    description: 'Destination file for the restored local artifact (relative to the configured artifact directory).',
  },
})

function requireRedactor(redactor) {
  if (redactor === null || redactor === undefined) {
    throw new Error('privacy-gate: local redaction is unavailable; the call is denied')
  }
  return redactor
}

function bounded(value, limit) {
  if (typeof value === 'string' && value.length > limit) {
    throw new Error(`privacy-gate: output exceeded maxExtractChars (${limit}); the document stays local`)
  }
  return value
}

function blockedError(reason) {
  return new Error(`privacy-gate: local conversion blocked (${reason}); nothing was sent to a model`)
}

/**
 * Resolve the rehydrate destination inside the artifact directory.
 * Pure: rejects traversal and absolute paths outside the directory.
 */
export function resolveArtifactPath(artifactPath, artifactDir) {
  const candidate = isAbsolute(artifactPath) ? normalize(artifactPath) : normalize(join(artifactDir, artifactPath))
  if (!isWithinPath(candidate, artifactDir)) {
    throw new Error('privacy-gate: artifact_path must stay inside the configured artifact directory')
  }
  return candidate
}

/**
 * Build the four tool definitions.
 * @param {{
 *   config: object,
 *   redactor: object|null,
 *   pii: { findPlaceholders?: (text: string) => Array<{ token: string, kind: string }> }|null,
 *   runExtract: (options: object) => Promise<object>,
 *   writeArtifact: (path: string, content: string) => void,
 *   audit: { record: (entry: object) => boolean },
 *   hashPath: (path: string) => string,
 * }} deps
 * @returns {object[]} registry-ready definitions.
 */
export function buildToolDefinitions(deps) {
  const { redactor, pii, runExtract, writeArtifact, audit, hashPath } = deps
  // config is read per call: the settings page can retarget allowPaths, the extractor and the
  // budgets while the plugin is loaded.
  const configOf = () => deps.config

  const extractDefinition = (name, spec, description, fixedMode) => ({
    name,
    description,
    parameters: objectSchema(spec),
    output: {
      schema: EXTRACTED_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const parsed = parseArguments(spec, args)
      if (parsed.ok === false) throw new Error(`privacy-gate: ${parsed.error}`)
      const active = requireRedactor(redactor)
      const input = parsed.value
      const documentPath = resolveAllowedDocument(input.path, configOf())
      const result = await runExtract({
        mode: fixedMode ?? input.mode ?? 'auto',
        filePath: documentPath,
        maxChars: input.max_chars ?? configOf().maxExtractChars,
        pages: input.pages,
        lang: input.lang,
        timeoutMs: configOf().toolTimeoutMs,
      })
      if (result === null || typeof result !== 'object') {
        throw new Error('privacy-gate: local extractor returned no result; the document stays local')
      }
      if (result.ok !== true) {
        audit.record({ kind: 'extract-blocked', length: 0, count: 0, path_hash: hashPath(input.path) })
        throw blockedError(typeof result.reason === 'string' ? result.reason : 'UNKNOWN')
      }
      const redacted = redactText(active, result.text)
      if (redacted.blocked) throw new Error('privacy-gate: extracted text carried a binary payload (BLOB); withheld')
      bounded(redacted.text, configOf().maxExtractChars)
      audit.record({ kind: 'extract', length: result.text.length, count: redacted.tokens.length, path_hash: hashPath(input.path) })
      return {
        mode: typeof result.mode === 'string' ? result.mode : (fixedMode ?? input.mode ?? 'auto'),
        engine: typeof result.engine === 'string' ? result.engine : 'unknown',
        text: redacted.text,
        chars: redacted.text.length,
        pages: Number.isSafeInteger(result.pages) ? result.pages : 0,
        warnings: Array.isArray(result.warnings) ? result.warnings.filter((warning) => typeof warning === 'string') : [],
        redacted: redacted.changed,
        tokens: tokenSummary(redacted.tokens),
      }
    },
  })

  return [
    extractDefinition(
      'privacy_extract',
      EXTRACT_SPEC,
      'Extract text from a local PDF, Office document, or document file and return it already PII-masked. Extraction runs entirely on this machine; if local conversion is not possible the call fails and no content is returned.',
      null,
    ),
    extractDefinition(
      'privacy_ocr',
      OCR_SPEC,
      'OCR a local image or scanned PDF with a local OCR engine and return the text already PII-masked. If no local OCR engine is available the call fails; the document is never uploaded.',
      'ocr',
    ),
    {
      name: 'privacy_scan',
      description: 'Mask PII in text you are about to use, returning the masked text plus a kind/count/length summary. Values are never echoed.',
      parameters: objectSchema(SCAN_SPEC),
      output: {
        schema: SCAN_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const parsed = parseArguments(SCAN_SPEC, args)
        if (parsed.ok === false) throw new Error(`privacy-gate: ${parsed.error}`)
        const active = requireRedactor(redactor)
        const redacted = redactText(active, parsed.value.text)
        if (redacted.blocked) throw new Error('privacy-gate: text carries a binary payload (BLOB); withheld')
        audit.record({ kind: 'scan', length: parsed.value.text.length, count: redacted.tokens.length, path_hash: '' })
        return {
          text: redacted.text,
          redacted: redacted.changed,
          hits: hitSummary(redacted.hits),
        }
      },
    },
    {
      name: 'privacy_rehydrate',
      description: 'Resolve placeholders inside this tool into a local artifact file and return only its path and counts. The plaintext values are written locally and never returned to the model.',
      parameters: objectSchema(REHYDRATE_SPEC),
      output: {
        schema: REHYDRATE_OUTPUT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: `Restored ${value.replaced} placeholder(s) into ${value.path} (kinds: ${value.kinds.length === 0 ? 'none' : value.kinds.join(', ')}). The values are local and were not returned.`,
        }],
      },
      async execute(args) {
        const parsed = parseArguments(REHYDRATE_SPEC, args)
        if (parsed.ok === false) throw new Error(`privacy-gate: ${parsed.error}`)
        const active = requireRedactor(redactor)
        if (pii === null || typeof pii?.findPlaceholders !== 'function' || typeof active.restore !== 'function') {
          throw new Error('privacy-gate: placeholder restore is unavailable in this deployment; the call is denied')
        }
        const placeholders = pii.findPlaceholders(parsed.value.text)
        if (!Array.isArray(placeholders) || placeholders.length === 0) {
          throw new Error('privacy-gate: no placeholders found; nothing was written')
        }
        // `restore()` only knows the values masked by THIS redactor instance
        // (the vault is not wired), so an unresolvable placeholder must not be
        // reported as restored.
        const resolvable = placeholders.filter((placeholder) => typeof placeholder?.token === 'string' && active.restore(placeholder.token) !== placeholder.token)
        if (resolvable.length === 0) {
          throw new Error('privacy-gate: none of the placeholders resolve in this session (values are session-local); nothing was written')
        }
        const target = resolveArtifactPath(parsed.value.artifact_path, configOf().artifactDir)
        const restored = active.restore(parsed.value.text)
        if (typeof restored !== 'string') throw new Error('privacy-gate: restore returned no text; nothing was written')
        writeArtifact(target, restored)
        const kinds = [...new Set(resolvable.map((placeholder) => placeholder.kind).filter((kind) => typeof kind === 'string'))].sort()
        audit.record({ kind: 'rehydrate', length: parsed.value.text.length, count: resolvable.length, path_hash: hashPath(target) })
        return { path: target, replaced: resolvable.length, kinds }
      },
    },
    {
      name: 'privacy_session',
      description:
        'Report or change whether the privacy gate protects the current session. `status` is always allowed; `enable` opts this session in; `disable` is refused unless the deployment allows an agent to turn the gate off (allowAgentDisable). The record holds the session id and a boolean, never content.',
      parameters: objectSchema({
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'enable', 'disable'],
          description: 'status | enable | disable',
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
            enabled: { type: 'boolean' },
            explicit: { type: 'boolean' },
            sessionId: { type: 'string' },
          },
          required: ['scope', 'enabled', 'explicit', 'sessionId'],
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `privacy-gate scope=${value.scope} enabled=${value.enabled} explicit=${value.explicit}`,
          },
        ],
      },
      async execute(args, exec) {
        const parsed = parseArguments({ action: { type: 'string', required: true } }, args)
        if (parsed.ok === false) throw new Error(`privacy-gate: ${parsed.error}`)
        const action = parsed.value.action
        if (!['status', 'enable', 'disable'].includes(action)) {
          throw new Error('privacy-gate: action must be status, enable or disable')
        }
        const registry = deps.sessions
        if (registry === undefined || registry === null) {
          throw new Error('privacy-gate: session scope is unavailable in this deployment')
        }
        const sessionId = exec?.agent?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new Error('privacy-gate: this tool needs a session context; call it from a session, not from a bare host')
        }
        if (action === 'enable') registry.setEnabled(sessionId, true)
        if (action === 'disable') {
          if (configOf().allowAgentDisable !== true) {
            throw new Error('privacy-gate: disabling the gate for a session is not permitted by this deployment (allowAgentDisable: false)')
          }
          registry.setEnabled(sessionId, false)
        }
        audit.record({ kind: `session-${action}`, length: 0, count: 0, path_hash: '' })
        const status = registry.status(sessionId)
        return { ...status, sessionId: typeof status.sessionId === 'string' ? status.sessionId : '' }
      },
    },
  ]
}
