/**
 * Placeholder HMAC key file handling.
 *
 * The key makes placeholders non-reversible (docs/interface-contract.md I7): the token is an
 * HMAC of the value, so a leaked token reveals nothing without the key. The
 * file is created with mode 0600 when missing (I5).
 *
 * Node-only. The gate treats *any* failure here as fail-closed: without a key
 * there is no redaction, and without redaction nothing may pass.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/** Minimum accepted key length (hex characters) — 32 bytes → 64 hex chars. */
const MIN_KEY_LENGTH = 32
const KEY_BYTES = 32

/**
 * Read the placeholder key, creating it on first use.
 * @param {string} file - absolute key file path.
 * @param {{ create?: boolean }} [options] - `create: false` makes a missing file an error.
 * @returns {{ key: string, path: string, created: boolean }}
 */
export function loadOrCreateKey(file, options = {}) {
  if (typeof file !== 'string' || file.trim().length === 0) throw new Error('privacy-gate: placeholderKey.file is empty')
  const create = options.create !== false

  if (!existsSync(file)) {
    if (!create) throw new Error(`privacy-gate: placeholder key file is missing: ${file}`)
    mkdirSync(dirname(file), { recursive: true })
    const key = randomBytes(KEY_BYTES).toString('hex')
    writeFileSync(file, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows ACLs do not map to POSIX modes; the file is still user-scoped.
    }
    return { key, path: file, created: true }
  }

  const raw = readFileSync(file, 'utf8').trim()
  if (raw.length < MIN_KEY_LENGTH) {
    throw new Error(`privacy-gate: placeholder key file is too short (${raw.length} chars, need ${MIN_KEY_LENGTH}): ${file}`)
  }
  return { key: raw, path: file, created: false }
}
