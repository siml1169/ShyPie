/**
 * Local ingestion of prompt attachments.
 *
 * A composer attachment reaches the agent as an `image` content block whose
 * `attachment` is an opaque, content-addressed reference (`dsh-llm`
 * ImageBlock). Two consequences shape this module:
 *
 *   - only the host's attachment service can read the bytes, so the gate must
 *     ask it (`ctx.attachments.readImage`), and
 *   - the model never gets a chance to call `privacy_ocr` first: the step that
 *     carries the image is either converted here or rejected.
 *
 * `agent/pre-step` is the last seam where that is still possible — the loop
 * appends the decision's messages to the session log (`dsh-agent-loop`
 * `turn()`), so converting here keeps the bytes out of the transcript and out
 * of every later request. Converting later (at `llm/stream`) is not an option:
 * that request is frozen and derived from the log.
 *
 * Fail-closed: no attachment service, no extractor, an unreadable object, an
 * OCR failure or an empty result all end as a rejection, never as a step with
 * the image still in it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { redactText } from './redact.js'

/** Extension per media type: the extractor sniffs magic bytes, the name is for humans. */
const EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Locate every image block in an outgoing message list.
 * @param {object[]} messages
 * @returns {{ messageIndex: number, blockIndex: number, attachment: object|null }[]}
 */
export function collectImageBlocks(messages) {
  const found = []
  if (!Array.isArray(messages)) return found
  messages.forEach((message, messageIndex) => {
    const content = isPlainObject(message) && Array.isArray(message.content) ? message.content : []
    content.forEach((block, blockIndex) => {
      if (isPlainObject(block) && block.type === 'image') {
        found.push({ messageIndex, blockIndex, attachment: isPlainObject(block.attachment) ? block.attachment : null })
      }
    })
  })
  return found
}

/**
 * Compose the text block that replaces one image. Mentions only metadata the
 * attachment reference already carries (never a filesystem path).
 * @param {{ mediaType?: string, bytes?: number, name?: string }} ref
 * @param {string} engine
 * @returns {string}
 */
export function ocrHeader(ref, engine) {
  const mediaType = typeof ref.mediaType === 'string' && ref.mediaType.length > 0 ? ref.mediaType : 'image'
  const name = typeof ref.name === 'string' && ref.name.length > 0 ? ` "${ref.name.slice(0, 120)}"` : ''
  const size = Number.isSafeInteger(ref.bytes) ? `, ${ref.bytes} bytes` : ''
  return `[privacy-gate: local OCR of an attached ${mediaType}${name}${size}, engine ${engine}]`
}

/** Cut extracted text at the configured budget, marking the cut. */
function capText(text, maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[privacy-gate: OCR output truncated at ${maxChars} characters]`
}

/**
 * Run the local extractor over one attachment's bytes.
 * @returns {Promise<{ ok: true, text: string, engine: string } | { ok: false, reason: string }>}
 */
async function ocrBytes(deps, attachment, data) {
  const extension = EXTENSIONS[attachment.mediaType] ?? 'bin'
  let directory = null
  try {
    directory = mkdtempSync(join(tmpdir(), 'shypie-ocr-'))
    const filePath = join(directory, `attachment.${extension}`)
    writeFileSync(filePath, Buffer.from(data), { mode: 0o600 })
    const result = await deps.runOcr({
      mode: 'ocr',
      filePath,
      maxChars: deps.config.maxExtractChars,
      ...(typeof deps.config.ocrLang === 'string' && deps.config.ocrLang.length > 0 ? { lang: deps.config.ocrLang } : {}),
      timeoutMs: deps.config.toolTimeoutMs,
    })
    if (result === null || typeof result !== 'object' || result.ok !== true) {
      return { ok: false, reason: typeof result?.reason === 'string' ? result.reason : 'OCR_FAILED' }
    }
    if (typeof result.text !== 'string' || result.text.trim().length === 0) return { ok: false, reason: 'OCR_EMPTY' }
    return { ok: true, text: capText(result.text, deps.config.maxExtractChars), engine: typeof result.engine === 'string' ? result.engine : 'local' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : 'OCR_FAILED' }
  } finally {
    if (directory !== null) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // A leftover temp directory must never change the verdict.
      }
    }
  }
}

/**
 * Replace every image block with locally OCR'd, masked text.
 * @param {object} deps - `{ config, redactor, readAttachment, runOcr }`.
 * @param {object[]} messages - the decision's messages (never mutated).
 * @returns {Promise<{ ok: true, messages: object[], converted: number, chars: number }
 *   | { ok: false, reason: string }>}
 */
export async function convertPromptImages(deps, messages) {
  const targets = collectImageBlocks(messages)
  if (targets.length === 0) return { ok: true, messages, converted: 0, chars: 0 }
  if (deps.config?.imageParts !== 'ocr') return { ok: false, reason: 'IMAGE_PARTS_BLOCKED' }
  if (deps.redactor === null || deps.redactor === undefined) return { ok: false, reason: 'REDACTOR_UNAVAILABLE' }
  if (typeof deps.readAttachment !== 'function' || typeof deps.runOcr !== 'function') return { ok: false, reason: 'OCR_UNAVAILABLE' }

  const out = messages.map((message) =>
    isPlainObject(message) && Array.isArray(message.content) ? { ...message, content: [...message.content] } : message,
  )
  let chars = 0

  for (const target of targets) {
    const { attachment } = target
    const id = typeof attachment?.attachmentId === 'string' ? attachment.attachmentId : ''
    if (id.length === 0) return { ok: false, reason: 'ATTACHMENT_UNREADABLE' }

    let stored
    try {
      stored = await deps.readAttachment(attachment)
    } catch {
      return { ok: false, reason: 'ATTACHMENT_UNREADABLE' }
    }
    const data = stored?.data ?? stored
    if (!(data instanceof Uint8Array) || data.length === 0) return { ok: false, reason: 'ATTACHMENT_UNREADABLE' }

    const ocr = await ocrBytes(deps, attachment, data)
    if (ocr.ok !== true) return { ok: false, reason: ocr.reason }

    let masked
    try {
      masked = redactText(deps.redactor, `${ocrHeader(attachment, ocr.engine)}\n\n${ocr.text}`)
    } catch {
      return { ok: false, reason: 'REDACTOR_UNAVAILABLE' }
    }
    if (masked.blocked) return { ok: false, reason: 'BLOB' }

    out[target.messageIndex].content[target.blockIndex] = { type: 'text', text: masked.text }
    chars += masked.chars
  }

  return { ok: true, messages: out, converted: targets.length, chars }
}
