/**
 * Final, fail-closed egress guard for DSH's LLM requests.
 *
 * Why this seam: DSH's `llm/stream` waterfall wraps adapter dispatch. A listener
 * that returns a terminal error stream before calling `next()` prevents the
 * adapter (and therefore Magpie) from ever seeing the request; the agent loop
 * turns that stream into its own `LlmError` with a stable code. Unlike Magpie's
 * 250 ms middleware hook, this is in-process DSH code: its verdict cannot be
 * dropped by an engine timeout.
 *
 * The guard does not mask or rewrite (the request is frozen); it asserts that the
 * ingestion gates left nothing un-maskable in the exact request:
 *   - image/file/audio/video content blocks are rejected;
 *   - text, reasoning, tool-call arguments and tool-result content are scanned;
 *   - any surviving PII hit or BLOB hit is a rejection;
 *   - unknown block types and over-budget requests are rejections.
 *
 * Tool declarations (`request.tools`, `request.toolHistory`) are skipped: they are
 * schemas, not conversation content.
 *
 * PII policy (decided): any surviving PII is a rejection, even though Magpie's
 * Privacy masking can mask text. DSH can target providers other than Magpie, and a
 * PII hit at the final request means the DSH ingestion layer left something behind;
 * relying on a downstream masker would silently weaken this boundary. Deployments
 * that force every DSH request through Magpie with masking enabled get an
 * intentionally redundant, stricter check.
 */

import { hasBlob } from './redact.js'

/** Stable error code carried by an egress rejection. */
export const EGRESS_BLOCKED_CODE = 'PRIVACY_EGRESS_BLOCKED'

const MEDIA_TYPES = Object.freeze(['image', 'file', 'audio', 'video'])
const KNOWN_TYPES = Object.freeze(['text', 'reasoning', 'tool-call', 'tool-result'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blocked(reason, stats) {
  return {
    ok: false,
    reason,
    length: stats?.chars ?? 0,
    count: stats?.strings ?? 0,
  }
}

function egressFailure(reason) {
  return Object.freeze({
    message: `privacy-gate: egress blocked (${reason})`,
    code: EGRESS_BLOCKED_CODE,
  })
}

/**
 * Return the terminal stream shape DSH's agent loop understands. The loop turns
 * `finish.reason.kind === "error"` into its own `LlmError`, so the turn carries
 * the stable code without this plugin importing the host's error class. No
 * provider adapter is called.
 * @param {string} reason
 * @returns {AsyncGenerator<object>}
 */
export function egressBlockedStream(reason) {
  const failure = egressFailure(reason)
  return (async function* blocked() {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure },
    }
  })()
}

/** Match an exact value, a `*` wildcard, or a `prefix/*` pattern. */
function matchesAny(patterns, value) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    if (pattern === value) return true
    if (pattern === '*') return true
    if (pattern.endsWith('/*') && value.startsWith(pattern.slice(0, -1))) return true
    if (pattern.includes('*')) {
      const source = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      if (new RegExp(`^${source}$`).test(value)) return true
    }
  }
  return false
}

/**
 * Inspect one final LLM request.
 * @param {object} request - `{ provider, model, messages, tools?, sessionId, signal }`.
 * @param {{ config: object, redactor: object|null, state?: { broken?: Error|null } }} deps
 * @param {WeakSet<object>|null} cache - messages already inspected in this session
 * @returns {{ ok: true } | { ok: false, reason: string, length: number, count: number }}
 */
export function inspectEgress(request, deps, cache = null) {
  const config = deps?.config ?? {}
  const redactor = deps?.redactor ?? null
  if (deps?.state?.broken) return blocked('REDACTOR_UNAVAILABLE')
  if (redactor === null || typeof redactor.scan !== 'function') return blocked('REDACTOR_UNAVAILABLE')

  const maxChars = Number.isSafeInteger(config.egressMaxChars) ? config.egressMaxChars : 2_000_000
  const maxNodes = Number.isSafeInteger(config.egressMaxNodes) ? config.egressMaxNodes : 200_000
  const stats = { chars: 0, nodes: 0, strings: 0 }

  try {
    if (!isPlainObject(request)) return blocked('MALFORMED_REQUEST', stats)
    if (!matchesAny(config.egressAllowProviders, String(request.provider ?? ''))) return blocked('PROVIDER', stats)
    if (!matchesAny(config.egressAllowModels, String(request.model ?? ''))) return blocked('MODEL', stats)
    if (!Array.isArray(request.messages)) return blocked('MALFORMED_MESSAGES', stats)

    const scanString = (text, where) => {
      if (typeof text !== 'string') throw Object.assign(new Error('non-string'), { egressReason: `MALFORMED_${where}` })
      stats.strings += 1
      stats.chars += text.length
      if (stats.chars > maxChars) throw Object.assign(new Error('chars'), { egressReason: 'LIMIT_CHARS' })
      const hits = redactor.scan(text)
      if (!Array.isArray(hits)) throw Object.assign(new Error('scan'), { egressReason: 'SCAN_FAILED' })
      if (hasBlob(hits)) throw Object.assign(new Error('blob'), { egressReason: 'BLOB' })
      if (hits.length > 0) throw Object.assign(new Error('pii'), { egressReason: 'PII' })
    }

    const scanContent = (content, where) => {
      stats.nodes += 1
      if (stats.nodes > maxNodes) throw Object.assign(new Error('nodes'), { egressReason: 'LIMIT_NODES' })
      if (typeof content === 'string') {
        scanString(content, where)
        return
      }
      if (!Array.isArray(content)) {
        throw Object.assign(new Error('content'), { egressReason: `MALFORMED_${where}` })
      }
      for (const block of content) {
        stats.nodes += 1
        if (stats.nodes > maxNodes) throw Object.assign(new Error('nodes'), { egressReason: 'LIMIT_NODES' })
        if (!isPlainObject(block)) throw Object.assign(new Error('block'), { egressReason: 'MALFORMED_BLOCK' })
        const type = block.type
        if (MEDIA_TYPES.includes(type)) throw Object.assign(new Error('media'), { egressReason: `MEDIA_${String(type).toUpperCase()}` })
        if (!KNOWN_TYPES.includes(type)) throw Object.assign(new Error('unknown'), { egressReason: 'UNKNOWN_BLOCK' })
        if (type === 'text' || type === 'reasoning') {
          scanString(block.text, type.toUpperCase())
        } else if (type === 'tool-call') {
          scanString(block.arguments, 'TOOL_CALL_ARGUMENTS')
        } else if (type === 'tool-result') {
          scanContent(block.content, 'TOOL_RESULT')
        }
      }
    }

    for (const message of request.messages) {
      // DSH request messages are frozen and reused across steps. Scanning a
      // message again cannot change the verdict, so skip it after the first
      // successful inspection. New messages still pay the full cost.
      if (cache !== null && cache.has(message)) continue
      stats.nodes += 1
      if (stats.nodes > maxNodes) throw Object.assign(new Error('nodes'), { egressReason: 'LIMIT_NODES' })
      if (!isPlainObject(message)) throw Object.assign(new Error('message'), { egressReason: 'MALFORMED_MESSAGE' })
      scanContent(message.content, 'MESSAGE_CONTENT')
      if (cache !== null) cache.add(message)
    }
    return { ok: true }
  } catch (error) {
    if (error && typeof error.egressReason === 'string') return blocked(error.egressReason, stats)
    return blocked('INTERNAL', stats)
  }
}

/**
 * Build the `llm/stream` listener. It must be registered prepended and global.
 * @param {{ config: object, redactor: object|null, state: object, audit: object }} deps
 * @returns {(request: object, next: () => any) => any}
 */
export function createEgressGuard(deps) {
  const inspectedMessages = new WeakSet()
  return (request, next) => {
    const verdict = inspectEgress(request, deps, inspectedMessages)
    if (verdict.ok !== true) {
      try {
        deps.audit?.record({
          kind: 'egress-blocked',
          length: verdict.length,
          count: verdict.count,
          path_hash: '',
        })
      } catch {
        // Audit must never change the security verdict.
      }
      return egressBlockedStream(verdict.reason)
    }
    return next()
  }
}
