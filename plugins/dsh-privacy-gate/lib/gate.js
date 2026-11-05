/**
 * The three DSH gates, as pure decision shapers plus one thin installer.
 *
 * Seam map (evidence: `ShyPie/docs/research/dsh-hooks.md`):
 *   Gate 1  tools/post-execute  (waterfall)  — redact every tool result before
 *           the loop appends `tool/result`; block binary payloads and
 *           unmaskable media; `next()` when nothing changes.
 *   Gate 3  agent/pre-step      (waterfall)  — redact user text, read an
 *           attached image with the local extractor and substitute masked text,
 *           and reject a step whose attachment cannot be read locally.
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
import { createEgressGuard } from './egress.js'
import { convertPromptAttachments } from './ingest.js'

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

  // Filter mode keeps the local transcript raw; it still scans for the
  // unmaskable BLOB/media shapes that Magpie's text masking can never fix.
  if (config.textPolicy === 'filter') {
    try {
      const base = Object.hasOwn(decision, 'value')
        ? decision.value
        : (Array.isArray(decision.content) ? decision.content : result?.content)
      if (Object.hasOwn(decision, 'value') || (result !== null && typeof result === 'object' && result.isError !== true)) {
        const value = Object.hasOwn(decision, 'value') ? decision.value : result?.value
        if (value !== undefined) {
          const valueOut = redactStringTree(redactor, value)
          if (valueOut.blocked) return blockDecision('privacy-gate: tool result carried a binary payload (BLOB); withheld')
        }
      }
      const contentOut = redactBlocks(redactor, Array.isArray(base) ? base : [], { blockNonText: config.blockNonTextResults })
      if (contentOut.blocked) {
        return blockDecision(
          contentOut.reason === 'BLOB'
            ? 'privacy-gate: tool result carried a binary payload (BLOB); withheld'
            : 'privacy-gate: tool result carried image/file content that cannot be masked; withheld',
        )
      }
      return decision
    } catch {
      return blockDecision('privacy-gate: filter scan failed; tool result withheld')
    }
  }

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
 *
 * The decision's messages are what the loop appends to the session log, so this
 * is the only place where an attachment can still become text: converting it
 * here keeps the image out of the transcript and out of every later request.
 * @param {{ config: object, redactor: object|null, state: { broken: Error|null }, audit: object,
 *   readAttachment?: Function, runOcr?: Function, ctx?: object }} deps
 * @param {{ agent?: object }} payload - the waterfall payload.
 * @param {{ kind?: string, messages?: object[] }} decision - the decision returned by `next()`.
 * @returns {Promise<object>} the decision to return to the loop.
 */
export async function shapePreStep(deps, payload, decision) {
  const { redactor, state, audit } = deps
  if (state.broken !== null) return { kind: 'reject' }
  if (decision === null || typeof decision !== 'object') return { kind: 'reject' }
  if (decision.kind === 'reject') return decision
  if (!Array.isArray(decision.messages)) return decision
  if (redactor === null || redactor === undefined) return { kind: 'reject' }

  try {
    const ingested = await convertPromptAttachments(deps, decision.messages)
    if (ingested.ok !== true) {
      audit.record({ kind: 'attachment-blocked', length: 0, count: 0, path_hash: '' })
      try {
        deps.ctx?.logger?.warn?.(`privacy-gate: step blocked — the attached image could not be read locally (${ingested.reason})`)
      } catch {
        // Logging must never change the verdict.
      }
      return { kind: 'reject' }
    }
    if (ingested.converted > 0) {
      audit.record({ kind: 'attachment-ocr', length: ingested.chars, count: ingested.converted, path_hash: '' })
    }

    // Filter mode keeps the extracted attachment text raw in the local log;
    // Magpie masks the outbound text. Scan without replacing so BLOB/media
    // still fail closed.
    if (deps.config?.textPolicy === 'filter') {
      const scan = redactMessages(redactor, ingested.messages, { blockNonText: true })
      if (scan.blocked) {
        audit.record({ kind: 'prompt-blocked', length: 0, count: scan.attachments.length, path_hash: '' })
        return { kind: 'reject' }
      }
      if (ingested.converted > 0) {
        audit.record({ kind: 'attachment-ocr', length: ingested.chars, count: ingested.converted, path_hash: '' })
        return { ...decision, messages: ingested.messages }
      }
      return decision
    }

    // blockNonText stays on: after the conversion an `image` block can only
    // appear when it is not an image attachment (defensive), and file/audio/
    // video parts have no local reader at all, so the step is rejected.
    const out = redactMessages(redactor, ingested.messages, { blockNonText: true })
    if (out.blocked) {
      audit.record({
        kind: 'prompt-blocked',
        length: out.chars,
        count: out.attachments.length,
        path_hash: '',
      })
      return { kind: 'reject' }
    }
    if (!out.changed && ingested.converted === 0) return decision
    if (out.changed) audit.record({ kind: 'prompt', length: out.chars, count: out.tokens.length, path_hash: '' })
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
 * Whether the gate applies to one session. A deployment without a registry keeps the old
 * system-wide behaviour, which is also what `scope: 'system'` selects.
 * @param {{ sessions?: { isEnabled(id: string|undefined): boolean } }} deps
 * @param {string|undefined} sessionId
 */
function gateActive(deps, sessionId) {
  if (deps.sessions === undefined || deps.sessions === null) return true
  return deps.sessions.isEnabled(sessionId)
}

/**
 * Register every gate on one plugin context.
 * @param {{ ctx: object, config: object, redactor: object|null, state: { broken: Error|null }, audit: object, sessions?: object }} deps
 * @returns {() => void} a disposer for all registrations.
 */
export function installGates(deps) {
  const { ctx } = deps
  const disposers = []

  disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!gateActive(deps, exec?.agent?.id)) return decision
    if (decision !== null && typeof decision === 'object' && decision.kind === 'block') return decision
    return shapePostExecute(deps, exec, result, decision)
  }))

  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!gateActive(deps, payload?.agent?.id)) return decision
    return await shapePreStep(deps, payload, decision)
  }))

  disposers.push(ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const blocks = await next()
    if (!gateActive(deps, dispatch?.agent?.id ?? dispatch?.sessionId)) return blocks
    return shapePtcDispatchLog(deps, blocks)
  }))

  // Final fail-closed boundary: inspect the exact request before the provider
  // adapter (and Magpie) can see it. Prepended so no earlier listener can call
  // next() first; throwing here is the rejection.
  disposers.push(ctx.on('llm/stream', createEgressGuard(deps), {
    prepend: true,
    global: true,
  }))

  disposers.push(ctx.tools.guard((exec) => (gateActive(deps, exec?.agent?.id) ? guardDecision(exec, deps.config) : undefined)))

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
