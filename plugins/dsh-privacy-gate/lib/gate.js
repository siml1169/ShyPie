/**
 * The three DSH gates, as pure decision shapers plus one thin installer.
 *
 * Seam map (evidence: `ShyPie/docs/research/dsh-hooks.md`):
 *   Gate 1  tools/post-execute  (waterfall)  — redact every tool result before
 *           the loop appends `tool/result`; block binary payloads and
 *           unmaskable media; `next()` when nothing changes.
 *   Gate 3  agent/pre-step      (waterfall)  — redact user text and reject
 *           attachment-bearing steps before any request exists.
 *   Guards  ctx.tools.guard()   (sync)       — deny `read_image` and binary
 *           document reads outside `allowPaths`.
 *   Extra   tools/ptc-dispatch-log (waterfall) — redact the durable log copy of
 *           `run_code` sub-dispatches (defensive; see research §1 UNVERIFIED).
 *
 * Every entry point is fail-closed: an exception, a malformed decision, or an
 * unavailable redactor denies/blocks instead of passing content through.
 */
import { redactBlocks, redactMessages, redactStringTree } from './redact.js'
import { isBinaryDocPath, isPathAllowed, displayName } from './paths.js'

/** Tool whose result content is an image this gate cannot mask. */
export const READ_IMAGE_TOOL = 'read_image'

/** Tool whose arguments name a file to read. */
export const READ_TOOL = 'read'

/** Feedback content for a withheld tool result (never echoes the result). */
const WITHHELD_TEXT = 'privacy-gate: tool result withheld (local masking unavailable or content unmaskable)'

/** Content used for a withheld PTC sub-dispatch log copy. */
const PTC_WITHHELD = Object.freeze([{ type: 'text', text: '[privacy-gate: sub-dispatch content withheld]' }])

function blockDecision(text) {
  return { kind: 'block', feedback: [{ type: 'text', text }] }
}

/**
 * The monotonic tool guard. Synchronous by contract
 * (references/practices.md:17): it may only inspect the parsed arguments.
 * @returns {string|undefined} a denial reason, or undefined to allow.
 */
export function guardDecision(exec, config) {
  if (exec === null || typeof exec !== 'object') return 'privacy-gate: malformed tool execution denied'
  const name = typeof exec.name === 'string' ? exec.name : ''
  if (name === READ_IMAGE_TOOL) {
    return 'privacy-gate: read_image is denied — image content cannot be masked locally; use privacy_ocr to extract text, or send the image to a local-only model'
  }
  if (name === READ_TOOL) {
    const args = exec.arguments
    const filePath = args !== null && typeof args === 'object' && typeof args.file_path === 'string' ? args.file_path : undefined
    if (filePath !== undefined && isBinaryDocPath(filePath) && !isPathAllowed(filePath, config.allowPaths)) {
      return `privacy-gate: reading binary/document file "${displayName(filePath)}" is denied — use privacy_extract or privacy_ocr so only masked text is returned, or move it under an allowed path`
    }
  }
  return undefined
}

/**
 * Shape one `tools/post-execute` result.
 * @param {{ config: object, redactor: object|null, state: { broken: Error|null }, audit: object }} deps
 * @param {{ name?: string }} exec - the execution that ran.
 * @param {{ isError?: boolean, value?: unknown, content?: object[] }} result - the dispatched result.
 * @param {object} decision - the decision returned by `next()`.
 * @returns {object} the decision to return to the registry.
 */
export function shapePostExecute(deps, exec, result, decision) {
  const { config, redactor, state, audit } = deps
  if (state.broken !== null) return blockDecision('privacy-gate: local redaction unavailable; tool result withheld')
  if (decision === null || typeof decision !== 'object') return blockDecision('privacy-gate: malformed post-execute decision; result withheld')
  // Another policy already owns the outcome: never override a block.
  if (decision.kind === 'block') return decision
  if (decision.kind !== 'accept') return blockDecision('privacy-gate: unsupported post-execute decision; result withheld')
  if (redactor === null || redactor === undefined) return blockDecision('privacy-gate: local redaction unavailable; tool result withheld')

  try {
    // A value-replacing inner listener: redact the replacement value.
    if (Object.hasOwn(decision, 'value')) {
      const valueOut = redactStringTree(redactor, decision.value)
      if (valueOut.blocked) return blockDecision('privacy-gate: tool result carried a binary payload (BLOB); withheld')
      if (!valueOut.changed) return decision
      audit.record({ kind: 'tool-value', length: valueOut.chars, count: valueOut.tokens.length, path_hash: '' })
      return { ...decision, value: valueOut.value }
    }

    const base = Array.isArray(decision.content) ? decision.content : result?.content
    const contentOut = redactBlocks(redactor, base ?? [], { blockNonText: config.blockNonTextResults })
    if (contentOut.blocked) {
      return blockDecision(
        contentOut.reason === 'BLOB'
          ? 'privacy-gate: tool result carried a binary payload (BLOB); withheld'
          : 'privacy-gate: tool result carried image/file content that cannot be masked; withheld',
      )
    }

    // For a success, replacing `value` re-derives BOTH content and the logged
    // `meta` through the tool definition (dsh-tools createSuccessResult), which
    // is the only way to sanitize `meta`. Error results keep their meta
    // (a post-execute accept cannot replace the value of a failed result).
    if (result !== null && typeof result === 'object' && result.isError !== true) {
      const valueOut = redactStringTree(redactor, result.value)
      if (valueOut.blocked) return blockDecision('privacy-gate: tool result carried a binary payload (BLOB); withheld')
      if (valueOut.changed) {
        audit.record({ kind: 'tool-result', length: valueOut.chars + contentOut.chars, count: valueOut.tokens.length, path_hash: '' })
        return { kind: 'accept', value: valueOut.value }
      }
    }

    if (contentOut.changed) {
      audit.record({ kind: 'tool-result', length: contentOut.chars, count: contentOut.tokens.length, path_hash: '' })
      return { ...decision, content: contentOut.blocks }
    }
    return decision
  } catch {
    return blockDecision('privacy-gate: redaction failed; tool result withheld')
  }
}

/**
 * Shape one `agent/pre-step` decision.
 * @param {{ config: object, redactor: object|null, state: { broken: Error|null }, audit: object }} deps
 * @param {{ agent?: object }} payload - the waterfall payload.
 * @param {{ kind?: string, messages?: object[] }} decision - the decision returned by `next()`.
 * @returns {object} the decision to return to the loop.
 */
export function shapePreStep(deps, payload, decision) {
  const { redactor, state, audit } = deps
  if (state.broken !== null) return { kind: 'reject' }
  if (decision === null || typeof decision !== 'object') return { kind: 'reject' }
  if (decision.kind === 'reject') return decision
  if (!Array.isArray(decision.messages)) return decision
  if (redactor === null || redactor === undefined) return { kind: 'reject' }

  try {
    // blockNonText is always on here: an image/file part cannot be masked, so
    // the step is rejected (CONTRACT gate 3) rather than forwarded.
    const out = redactMessages(redactor, decision.messages, { blockNonText: true })
    if (out.blocked) {
      audit.record({
        kind: 'prompt-blocked',
        length: out.chars,
        count: out.attachments.length,
        path_hash: '',
      })
      return { kind: 'reject' }
    }
    if (!out.changed) return decision
    audit.record({ kind: 'prompt', length: out.chars, count: out.tokens.length, path_hash: '' })
    // Spread the decision so fields such as `startsRequestSeries` survive
    // (references/practices.md:16).
    return { ...decision, messages: out.messages }
  } catch {
    return { kind: 'reject' }
  }
}

/**
 * Shape one `tools/ptc-dispatch-log` content array (durable log copy of a
 * `run_code` sub-dispatch).
 * @returns {object[]} the content blocks to log.
 */
export function shapePtcDispatchLog(deps, blocks) {
  const { config, redactor, state } = deps
  if (state.broken !== null) return [...PTC_WITHHELD]
  if (redactor === null || redactor === undefined) return [...PTC_WITHHELD]
  try {
    const out = redactBlocks(redactor, Array.isArray(blocks) ? blocks : [], { blockNonText: config.blockNonTextResults })
    if (out.blocked) return [...PTC_WITHHELD]
    return out.changed ? out.blocks : blocks
  } catch {
    return [...PTC_WITHHELD]
  }
}

/**
 * Register every gate on one plugin context.
 * @param {{ ctx: object, config: object, redactor: object|null, state: { broken: Error|null }, audit: object }} deps
 * @returns {() => void} a disposer for all registrations.
 */
export function installGates(deps) {
  const { ctx } = deps
  const disposers = []

  disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision !== null && typeof decision === 'object' && decision.kind === 'block') return decision
    return shapePostExecute(deps, exec, result, decision)
  }))

  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    return shapePreStep(deps, payload, decision)
  }))

  disposers.push(ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const blocks = await next()
    return shapePtcDispatchLog(deps, blocks)
  }))

  disposers.push(ctx.tools.guard((exec) => guardDecision(exec, deps.config)))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Teardown must never throw out of a plugin unload.
      }
    }
  }
}
