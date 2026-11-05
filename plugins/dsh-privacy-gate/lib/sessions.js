/**
 * Per-session activation for the DSH privacy gate.
 *
 * The gate used to apply to every session in the profile. That is the wrong default: history
 * written before the bundle existed cannot be masked, so a single old session turns every later
 * turn into `PRIVACY_EGRESS_BLOCKED`. Scope is now a property of the session:
 *
 *   scope: 'session' (default)  — sessions that existed before the gate was first activated are
 *                                 recorded as disabled and left alone; sessions that appear later
 *                                 are protected.
 *   scope: 'system'             — every session, the old behaviour.
 *
 * The record lives outside the repository next to the placeholder key. It holds session ids and
 * booleans only: no content, no path, no timestamps per session.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** On-disk format version; a mismatch starts a fresh record. */
export const STORE_VERSION = 1

/** Scopes a deployment may choose. */
export const SCOPES = Object.freeze(['session', 'system'])

const SESSION_PREFIX = 'session-'

/**
 * Read the ids of the sessions that already exist on disk.
 * Layout: `<sessionsDir>/<project>/session-<id>/session.v4.jsonl[.zstd]`.
 * Unreadable directories yield an empty list: a missing snapshot only means no session is
 * recorded as legacy, never that the gate is disabled.
 * @param {string} sessionsDir
 * @param {typeof import('node:fs')} [io]
 * @returns {string[]}
 */
export function listExistingSessionIds(sessionsDir, io = { readdirSync }) {
  if (typeof sessionsDir !== 'string' || sessionsDir.length === 0) return []
  const ids = []
  let projects
  try {
    projects = io.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return ids
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let entries
    try {
      entries = io.readdirSync(join(sessionsDir, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(SESSION_PREFIX)) ids.push(entry.name.slice(SESSION_PREFIX.length))
    }
  }
  return ids
}

const defaultIo = { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync }

/**
 * Build the registry the gates consult.
 * @param {object} options
 * @param {string} options.file - JSON record path; '' disables persistence (session scope then
 *   behaves like system scope, because nothing can be remembered).
 * @param {'session'|'system'} [options.scope]
 * @param {string} [options.sessionsDir] - the DSH sessions directory used once for the legacy snapshot.
 * @param {() => number} [options.now]
 * @param {object} [options.io] - injectable fs for the tests.
 */
export function createSessionRegistry({ file, scope = 'session', sessionsDir = '', now = Date.now, io = defaultIo }) {
  const effectiveScope = SCOPES.includes(scope) ? scope : 'session'
  let store = null
  let persistable = typeof file === 'string' && file.length > 0

  function freshStore() {
    return { version: STORE_VERSION, initializedAt: null, sessions: {} }
  }

  function read() {
    if (store !== null) return store
    store = freshStore()
    if (!persistable) return store
    try {
      const parsed = JSON.parse(io.readFileSync(file, 'utf8'))
      if (parsed && parsed.version === STORE_VERSION && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
        store = {
          version: STORE_VERSION,
          initializedAt: typeof parsed.initializedAt === 'number' ? parsed.initializedAt : null,
          sessions: Object.fromEntries(
            Object.entries(parsed.sessions).filter(([, value]) => typeof value === 'boolean'),
          ),
        }
      }
    } catch {
      // Missing or unreadable record: start clean. Losing the record re-snapshots the legacy
      // sessions, which can only widen the ungated set — never narrow it silently.
    }
    return store
  }

  function write(next) {
    store = next
    if (!persistable) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      // Persistence is best effort: a read-only home must not stop the gate from working.
      persistable = false
    }
  }

  /** Record the sessions that predate first activation, once. */
  function initialize() {
    if (effectiveScope !== 'session') return
    const current = read()
    if (current.initializedAt !== null) return
    const next = { ...current, initializedAt: now(), sessions: { ...current.sessions } }
    for (const id of listExistingSessionIds(sessionsDir, io)) {
      if (!(id in next.sessions)) next.sessions[id] = false
    }
    write(next)
  }

  return {
    scope: effectiveScope,
    /** @param {string|undefined} sessionId */
    isEnabled(sessionId) {
      if (effectiveScope === 'system') return true
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      initialize()
      const current = read()
      if (Object.hasOwn(current.sessions, sessionId)) return current.sessions[sessionId] === true
      // A session first seen after activation is protected.
      return current.initializedAt !== null
    },
    /** @param {string} sessionId @param {boolean} enabled */
    setEnabled(sessionId, enabled) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      initialize()
      const current = read()
      write({ ...current, sessions: { ...current.sessions, [sessionId]: enabled === true } })
      return true
    },
    /** @param {string|undefined} sessionId */
    status(sessionId) {
      const current = read()
      return {
        scope: effectiveScope,
        initializedAt: current.initializedAt,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        enabled: this.isEnabled(sessionId),
        explicit: typeof sessionId === 'string' && Object.hasOwn(current.sessions, sessionId),
      }
    },
  }
}
