/**
 * Pure redaction helpers over a `pii-core`-shaped redactor.
 *
 * The redactor interface is exactly the docs/interface-contract.md API:
 *   redact(text) -> { text, tokens: [{ token, kind, length, count }], hits: [{ kind, ... }], changed }
 *   scan(text)   -> hits
 * Tokens never carry a value (I7/I10), so everything in this module is safe to
 * log or return to a model.
 *
 * No imports: unit-tested directly with a fake redactor.
 */

/** Hit kind that means "binary payload", not "mask me". */
export const BLOB_KIND = 'BLOB'

/** Content block types this gate can never mask. */
export const MEDIA_BLOCK_TYPES = Object.freeze(['image', 'file', 'audio', 'video'])

/** Hard caps so a hostile value cannot stall the pipeline. */
const MAX_TREE_NODES = 50_000
const MAX_TREE_DEPTH = 32

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRedaction(result, where) {
  if (!isPlainObject(result) || typeof result.text !== 'string' || !Array.isArray(result.tokens) || !Array.isArray(result.hits)) {
    throw new Error(`privacy-gate: redactor returned an invalid ${where} result`)
  }
  return result
}

/** Whether any hit is a binary-payload signal. */
export function hasBlob(hits) {
  return Array.isArray(hits) && hits.some((hit) => hit !== null && typeof hit === 'object' && hit.kind === BLOB_KIND)
}

/** Aggregate hits to `{kind, count, length}` records — never a value (I10). */
export function hitSummary(hits) {
  const byKind = new Map()
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (hit === null || typeof hit !== 'object' || typeof hit.kind !== 'string') continue
    const entry = byKind.get(hit.kind) ?? { kind: hit.kind, count: 0, length: 0 }
    entry.count += 1
    entry.length += Number.isSafeInteger(hit.length) ? hit.length : 0
    byKind.set(hit.kind, entry)
  }
  return [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind))
}

/** Aggregate tokens to `{kind, count, length}` records — never the token's value. */
export function tokenSummary(tokens) {
  return hitSummary(tokens)
}

/**
 * Redact one text string.
 * @returns {{ text: string, tokens: object[], hits: object[], changed: boolean, blocked: boolean, chars: number, reason?: string }}
 */
export function redactText(redactor, text) {
  if (typeof text !== 'string') throw new Error('privacy-gate: redactText requires a string')
  const result = assertRedaction(redactor.redact(text), 'text')
  const blocked = hasBlob(result.hits) || hasBlob(result.tokens)
  return {
    text: result.text,
    tokens: result.tokens,
    hits: result.hits,
    changed: result.changed === true || result.text !== text,
    blocked,
    chars: text.length,
    ...(blocked ? { reason: 'BLOB' } : {}),
  }
}

/**
 * Redact every maskable block of one content-block array.
 * @param {object} redactor - redactor interface.
 * @param {object[]} blocks - content blocks (never mutated).
 * @param {{ blockNonText?: boolean }} options
 * @returns {{ blocks: object[], changed: boolean, blocked: boolean, reason?: string, tokens: object[], maskable: number, chars: number }}
 */
export function redactBlocks(redactor, blocks, options = {}) {
  const blockNonText = options.blockNonText !== false
  if (!Array.isArray(blocks)) throw new Error('privacy-gate: redactBlocks requires an array')
  const out = []
  const tokens = []
  let changed = false
  let maskable = 0
  let chars = 0
  for (const block of blocks) {
    if (!isPlainObject(block)) {
      out.push(block)
      continue
    }
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      maskable += 1
      const redacted = redactText(redactor, block.text)
      chars += redacted.chars
      if (redacted.blocked) {
        return { blocks: out, changed, blocked: true, reason: redacted.reason, tokens, maskable, chars }
      }
      tokens.push(...redacted.tokens)
      if (redacted.changed) {
        changed = true
        out.push({ ...block, text: redacted.text })
      } else {
        out.push(block)
      }
      continue
    }
    if (MEDIA_BLOCK_TYPES.includes(block.type) && blockNonText) {
      return { blocks: out, changed, blocked: true, reason: `UNMASKABLE_${String(block.type).toUpperCase()}`, tokens, maskable, chars }
    }
    out.push(block)
  }
  return { blocks: changed ? out : blocks, changed, blocked: false, tokens, maskable, chars }
}

/**
 * Redact every string inside a JSON value (a tool result's `value`).
 * Replacing `value` is the only supported way to re-derive a tool result's
 * `meta` (post-execute `accept` re-renders both through the tool definition).
 * @returns {{ value: unknown, changed: boolean, blocked: boolean, reason?: string, tokens: object[], strings: number, chars: number }}
 */
export function redactStringTree(redactor, value) {
  const tokens = []
  let changed = false
  let strings = 0
  let nodes = 0
  let chars = 0

  const walk = (node, depth) => {
    if (depth > MAX_TREE_DEPTH) throw new Error('privacy-gate: tool result value is nested too deeply')
    nodes += 1
    if (nodes > MAX_TREE_NODES) throw new Error('privacy-gate: tool result value is too large to redact')
    if (typeof node === 'string') {
      strings += 1
      const redacted = redactText(redactor, node)
      chars += redacted.chars
      if (redacted.blocked) throw blockedSignal(redacted.reason)
      tokens.push(...redacted.tokens)
      if (redacted.changed) changed = true
      return redacted.text
    }
    if (Array.isArray(node)) {
      const items = node.map((item) => walk(item, depth + 1))
      const arrayChanged = items.some((item, index) => item !== node[index])
      if (arrayChanged) changed = true
      return arrayChanged ? items : node
    }
    if (isPlainObject(node)) {
      let objectChanged = false
      const copy = {}
      for (const [key, child] of Object.entries(node)) {
        const next = walk(child, depth + 1)
        if (next !== child) objectChanged = true
        copy[key] = next
      }
      if (objectChanged) changed = true
      return objectChanged ? copy : node
    }
    return node
  }

  try {
    const next = walk(value, 0)
    return { value: next, changed, blocked: false, tokens, strings, chars }
  } catch (error) {
    if (error instanceof BlobSignal) {
      return { value, changed, blocked: true, reason: error.reason, tokens, strings, chars }
    }
    throw error
  }
}

class BlobSignal extends Error {
  constructor(reason) {
    super('privacy-gate: binary payload detected')
    this.reason = reason
  }
}

function blockedSignal(reason) {
  return new BlobSignal(reason ?? 'BLOB')
}

/**
 * Redact one user message (the `agent/pre-step` payload).
 * @returns {{ message: object, changed: boolean, blocked: boolean, reason?: string, attachments: string[], tokens: object[], chars: number }}
 */
export function redactMessage(redactor, message, options = {}) {
  if (!isPlainObject(message)) throw new Error('privacy-gate: redactMessage requires a message object')
  const content = Array.isArray(message.content) ? message.content : undefined
  if (content === undefined) return { message, changed: false, blocked: false, attachments: [], tokens: [], chars: 0 }
  const attachments = content
    .filter((block) => isPlainObject(block) && MEDIA_BLOCK_TYPES.includes(block.type))
    .map((block) => block.type)
  const out = redactBlocks(redactor, content, options)
  return {
    message: out.changed ? { ...message, content: out.blocks } : message,
    changed: out.changed,
    blocked: out.blocked,
    ...(out.reason === undefined ? {} : { reason: out.reason }),
    attachments,
    tokens: out.tokens,
    chars: out.chars,
  }
}

/**
 * Redact a batch of proposed step messages.
 * @returns {{ messages: object[], changed: boolean, blocked: boolean, reason?: string, attachments: string[], tokens: object[], chars: number }}
 */
export function redactMessages(redactor, messages, options = {}) {
  if (!Array.isArray(messages)) throw new Error('privacy-gate: redactMessages requires an array')
  const out = []
  const tokens = []
  const attachments = []
  let changed = false
  let chars = 0
  for (const message of messages) {
    const redacted = redactMessage(redactor, message, options)
    attachments.push(...redacted.attachments)
    tokens.push(...redacted.tokens)
    chars += redacted.chars
    if (redacted.blocked) {
      return { messages: out, changed, blocked: true, reason: redacted.reason, attachments, tokens, chars }
    }
    if (redacted.changed) changed = true
    out.push(redacted.message)
  }
  return { messages: changed ? out : messages, changed, blocked: false, attachments, tokens, chars }
}
