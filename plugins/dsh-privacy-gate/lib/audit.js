/**
 * Bounded audit journal for the privacy gate.
 *
 * Every record carries exactly `kind`, `length`, `count`, `path_hash`, `ts`
 * (docs/interface-contract.md I10) — never a value, never a token, never a first character.
 * `path_hash` is a SHA-256 of the normalized path, so the journal can correlate
 * a path without storing it.
 *
 * Node-only (fs/crypto); the gate never uses it when `audit.enabled` is false,
 * which is the default.
 */
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** SHA-256 (hex) of a normalized path, or `''` when there is nothing to hash. */
export function hashPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return ''
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

const ALLOWED_FIELDS = Object.freeze(['kind', 'length', 'count', 'path_hash', 'ts'])

/**
 * Create one audit sink.
 * @param {{ enabled?: boolean, path?: string }} config - `audit` config block.
 * @param {{ now?: () => number, append?: (path: string, line: string) => void }} [deps]
 *   injected for tests; the defaults write one JSON line per record.
 */
export function createAudit(config = {}, deps = {}) {
  const enabled = config.enabled === true && typeof config.path === 'string' && config.path.length > 0
  const now = deps.now ?? (() => Date.now())
  const append = deps.append ?? ((file, line) => appendFileSync(file, line, { encoding: 'utf8' }))

  return {
    enabled,
    path: enabled ? config.path : '',
    /**
     * Append one bounded record. A record whose extra fields are not in the
     * allowlist is rejected rather than written, so no caller can leak a value.
     */
    record(entry = {}) {
      if (!enabled) return false
      for (const field of Object.keys(entry)) {
        if (!ALLOWED_FIELDS.includes(field)) throw new Error(`privacy-gate audit: field "${field}" is not allowed in a journal record`)
      }
      const record = {
        kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
        length: Number.isSafeInteger(entry.length) ? entry.length : 0,
        count: Number.isSafeInteger(entry.count) ? entry.count : 0,
        path_hash: typeof entry.path_hash === 'string' ? entry.path_hash : '',
        ts: Number.isSafeInteger(entry.ts) ? entry.ts : now(),
      }
      try {
        append(config.path, `${JSON.stringify(record)}\n`)
        return true
      } catch {
        // A failing journal must never fail the gate: the record is best-effort.
        return false
      }
    },
  }
}
