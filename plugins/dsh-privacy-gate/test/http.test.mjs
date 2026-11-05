import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ENGINES_PATH,
  isSameOrigin,
  loadSettings,
  registerRoutes,
  saveSettings,
  SESSION_PATH,
  SETTINGS_PATH,
  WRITABLE_FIELDS,
} from '../lib/http.js'

function request(overrides = {}) {
  return { method: 'GET', url: '/', headers: { host: '127.0.0.1:3425' }, ...overrides }
}

function response() {
  return {
    status: 0,
    body: undefined,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = JSON.parse(text)
    },
  }
}

function body(value) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(value))
    },
  }
}

test('the route paths are the ones the client uses', () => {
  assert.equal(SETTINGS_PATH, '/shypie-privacy/settings')
  assert.equal(SESSION_PATH, '/shypie-privacy/session')
  assert.equal(ENGINES_PATH, '/shypie-privacy/engines')
  assert.ok(WRITABLE_FIELDS.includes('scope'))
  assert.equal(WRITABLE_FIELDS.includes('sessionsPath'), false)
})

test('same-origin check accepts loopback and rejects everything else', () => {
  assert.equal(isSameOrigin(request()), true)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://127.0.0.1:3425' } })), true)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://localhost:3425' } })), true)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'dsh-app://app' } })), true)
  assert.equal(isSameOrigin(request({ headers: { host: '192.168.0.5:3425' } })), false)
  assert.equal(isSameOrigin(request({ headers: { host: 'evil.example' } })), false)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://evil.example' } })), false)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://127.0.0.1:9999' } })), false)
})

test('the record round-trips and a missing file reads empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-http-'))
  try {
    const file = join(dir, 'nested', 'settings.json')
    assert.deepEqual(loadSettings(file), { revision: 0, value: {} })
    saveSettings(file, { revision: 3, value: { scope: 'system' } })
    assert.deepEqual(loadSettings(file), { revision: 3, value: { scope: 'system' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function mount(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-route-'))
  const file = join(dir, 'settings.json')
  const applied = []
  const sessions = { enabled: {}, scope: 'session' }
  const deps = {
    file,
    warn: () => {},
    apply: async (value) => {
      applied.push(value)
      if (value.scope === 'nope') throw new Error('scope must be "session" or "system"')
    },
    describe: () => ({ value: { scope: 'session' }, revision: 0, defaults: { scope: 'session' } }),
    session: {
      get: (id) => ({ scope: sessions.scope, sessionId: id, enabled: sessions.enabled[id] === true, explicit: id in sessions.enabled }),
      set: (id, enabled) => {
        sessions.enabled[id] = enabled
        return deps.session.get(id)
      },
    },
    probeEngines: async () => ({ engines: [{ name: 'winrt-ocr', available: true, detail: 'max image 10000px', languages: ['de-DE', 'en-GB'] }], note: 'tesseract not on PATH' }),
    ...overrides,
  }
  const handlers = new Map()
  const webServer = {
    register(route) {
      handlers.set(route.path, route.handler)
      return () => {}
    },
  }
  registerRoutes(webServer, deps)
  return { handlers, file, applied, dir, sessions }
}

test('GET settings returns the described value', async () => {
  const { handlers, dir } = mount()
  try {
    const res = response()
    await handlers.get(SETTINGS_PATH)(request(), res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.value, { scope: 'session' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST settings persists only writable fields and bumps the revision', async () => {
  const { handlers, file, applied, dir } = mount()
  try {
    const res = response()
    await handlers.get(SETTINGS_PATH)(
      request({
        method: 'POST',
        headers: { host: '127.0.0.1:3425', origin: 'http://127.0.0.1:3425' },
        ...body({ scope: 'system', sessionsPath: 'C:/evil.json' }),
      }),
      res,
    )
    assert.equal(res.status, 200)
    assert.deepEqual(applied, [{ scope: 'system' }])
    assert.deepEqual(loadSettings(file), { revision: 1, value: { scope: 'system' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST settings from an untrusted origin is refused before it reaches the store', async () => {
  const { handlers, file, applied, dir } = mount()
  try {
    const res = response()
    await handlers.get(SETTINGS_PATH)(
      request({ method: 'POST', headers: { host: '127.0.0.1:3425', origin: 'http://evil.example' }, ...body({ scope: 'system' }) }),
      res,
    )
    assert.equal(res.status, 403)
    assert.deepEqual(applied, [])
    assert.deepEqual(loadSettings(file), { revision: 0, value: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejected value answers 400 and is not stored', async () => {
  const { handlers, file, dir } = mount()
  try {
    const res = response()
    await handlers.get(SETTINGS_PATH)(request({ method: 'POST', headers: { host: '127.0.0.1:3425' }, ...body({ scope: 'nope' }) }), res)
    assert.equal(res.status, 400)
    assert.match(res.body.error, /scope must be/)
    assert.deepEqual(loadSettings(file), { revision: 0, value: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty or unknown settings body is refused', async () => {
  const { handlers, dir } = mount()
  try {
    for (const value of [{}, { sessionsPath: 'x' }]) {
      const res = response()
      await handlers.get(SETTINGS_PATH)(request({ method: 'POST', headers: { host: '127.0.0.1:3425' }, ...body(value) }), res)
      assert.equal(res.status, 400)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET session reports the gate state for the session id', async () => {
  const { handlers, dir } = mount()
  try {
    const res = response()
    await handlers.get(SESSION_PATH)(request({ url: '/shypie-privacy/session?session=s-1' }), res)
    assert.equal(res.status, 200)
    assert.equal(res.body.sessionId, 's-1')
    assert.equal(res.body.enabled, false)
    assert.equal(res.body.scope, 'session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST session toggles it, and a missing id or foreign origin is refused', async () => {
  const { handlers, sessions, dir } = mount()
  try {
    const ok = response()
    await handlers.get(SESSION_PATH)(
      request({ method: 'POST', headers: { host: '127.0.0.1:3425', origin: 'http://127.0.0.1:3425' }, ...body({ session: 's-1', enabled: true }) }),
      ok,
    )
    assert.equal(ok.status, 200)
    assert.equal(ok.body.enabled, true)
    assert.deepEqual(sessions.enabled, { 's-1': true })

    const bad = response()
    await handlers.get(SESSION_PATH)(request({ method: 'POST', headers: { host: '127.0.0.1:3425' }, ...body({ enabled: true }) }), bad)
    assert.equal(bad.status, 400)

    const untrusted = response()
    await handlers.get(SESSION_PATH)(
      request({ method: 'POST', headers: { host: '127.0.0.1:3425', origin: 'http://evil.example' }, ...body({ session: 's-1', enabled: false }) }),
      untrusted,
    )
    assert.equal(untrusted.status, 403)
    assert.deepEqual(sessions.enabled, { 's-1': true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GET engines answers the probe result', async () => {
  const { handlers, dir } = mount()
  try {
    const res = response()
    await handlers.get(ENGINES_PATH)(request(), res)
    assert.equal(res.status, 200)
    assert.equal(res.body.engines[0].name, 'winrt-ocr')
    assert.equal(res.body.engines[0].available, true)
    assert.match(res.body.note, /tesseract/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
