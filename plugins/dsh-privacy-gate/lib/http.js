/**
 * Same-origin HTTP API for the Privacy gate settings page.
 *
 * Pattern copied from the working third-party plugins in this profile (`dsh-plugin` / Plugin Hub):
 * a third-party client page cannot reach a settings namespace (the host api-proxy only serves an
 * allowlist), so the page talks to its own host half over same-origin routes and the host persists
 * the values. The routes are registered through `ctx.inject(['webServer'], ...)`, which keeps the
 * plugin entry boot-safe — `webServer` is resolved in a child scope, not the entry's own inject.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Path the client page uses. */
export const SETTINGS_PATH = '/shypie-privacy/settings'

const BODY_LIMIT_BYTES = 64 * 1024
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

/** Normalise `host[:port]` to one identity for the three loopback aliases; null for anything else. */
function loopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority.length === 0) return null
  try {
    const parsed = new URL(`http://${authority}`)
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null
    return `loopback:${parsed.port === '' ? '80' : parsed.port}`
  } catch {
    return null
  }
}

/**
 * Same-origin check, which is the whole CSRF defence for these routes: the server binds loopback
 * only, so a non-loopback Host (LAN address or a rewritten domain, i.e. DNS rebinding) is refused,
 * and an Origin that is present must match.
 */
export function isSameOrigin(request) {
  const hostKey = loopbackAuthority(request.headers.host)
  if (hostKey === null) return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    // The desktop shell serves the renderer from its own scheme; anything else must be loopback.
    if (parsed.protocol === 'dsh-app:') return true
    return loopbackAuthority(parsed.host) === hostKey
  } catch {
    return false
  }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  return JSON.parse(text)
}

/** Fields the page may write; anything else in the body is ignored. */
export const WRITABLE_FIELDS = Object.freeze([
  'scope',
  'allowPaths',
  'extractCli',
  'detectors',
  'personWords',
  'blockNonTextResults',
  'auditEnabled',
  'auditPath',
  'egressAllowProviders',
  'egressAllowModels',
  'allowAgentDisable',
  'ocrEngine',
  'visionProvider',
  'visionModel',
])

/**
 * Load one settings record. A missing or unreadable file is an empty record, never an error.
 * @param {string} file
 * @returns {{ revision: number, value: object }}
 */
export function loadSettings(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.value === 'object' && parsed.value !== null) {
      return { revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : 0, value: parsed.value }
    }
  } catch {
    // Missing or corrupt: start empty; the row config remains the effective layer.
  }
  return { revision: 0, value: {} }
}

/**
 * Persist one settings record atomically.
 * @param {string} file
 * @param {{ revision: number, value: object }} record
 */
export function saveSettings(file, record) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, revision: record.revision, value: record.value }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tmp, file)
}

/**
 * Register the settings route on the host web server.
 * @param {object} webServer - the DSH web server service.
 * @param {{ file: string, apply: (value: object) => Promise<object>, describe: () => object, warn: (message: string) => void }} deps
 * @returns {() => void} disposer.
 */
export function registerSettingsRoute(webServer, deps) {
  return webServer.register({
    kind: 'exact',
    path: SETTINGS_PATH,
    // One handler per (kind, path): GET reads, POST writes.
    handler: async (request, response) => {
      if (request.method === 'GET') {
        sendJson(response, 200, deps.describe())
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      try {
        const body = await readJsonBody(request)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(response, 400, { error: 'body must be an object' })
          return
        }
        const patch = {}
        for (const key of WRITABLE_FIELDS) {
          if (Object.hasOwn(body, key)) patch[key] = body[key]
        }
        if (Object.keys(patch).length === 0) {
          sendJson(response, 400, { error: 'no writable fields in body' })
          return
        }
        const current = loadSettings(deps.file)
        const next = { ...current.value, ...patch }
        try {
          await deps.apply(next)
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const record = { revision: current.revision + 1, value: next }
        saveSettings(deps.file, record)
        sendJson(response, 200, deps.describe())
      } catch (error) {
        deps.warn(`settings write failed: ${error instanceof Error ? error.message : String(error)}`)
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
