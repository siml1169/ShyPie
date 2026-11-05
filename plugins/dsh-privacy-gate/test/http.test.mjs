import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isSameOrigin,
  loadSettings,
  registerSettingsRoute,
  saveSettings,
  SETTINGS_PATH,
  WRITABLE_FIELDS,
} from '../lib/http.js'

function request(overrides = {}) {
  return { method: 'GET', headers: { host: '127.0.0.1:3425' }, ...overrides }
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

test('the route path is the one the page fetches', () => {
  assert.equal(SETTINGS_PATH, '/shypie-privacy/settings')
  assert.ok(WRITABLE_FIELDS.includes('scope'))
  assert.ok(WRITABLE_FIELDS.includes('allowPaths'))
  assert.equal(WRITABLE_FIELDS.includes('sessionsPath'), false)
})

test('same-origin check accepts loopback and rejects everything else', () => {
  assert.equal(isSameOrigin(request()), true)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://127.0.0.1:3425' } })), true)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://localhost:3425' } })), true)
  assert.equal(isSameOrigin(request({ headers: { host: '192.168.0.5:3425' } })), false)
  assert.equal(isSameOrigin(request({ headers: { host: 'evil.example' } })), false)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://evil.example' } })), false)
  assert.equal(isSameOrigin(request({ headers: { host: '127.0.0.1:3425', origin: 'http://127.0.0.1:9999' } })), false)
})

test('the record round-trips and a missing or corrupt file reads empty', () => {
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
  const deps = {
    file,
    warn: () => {},
    apply: async (value) => {
      applied.push(value)
      if (value.scope === 'nope') throw new Error('scope must be "session" or "system"')
    },
    describe: () => ({ value: { scope: 'session' }, revision: 0, defaults: { scope: 'session' } }),
    ...overrides,
  }
  let handler
  const webServer = {
    register(route) {
      handler = route.handler
      return () => {}
    },
  }
  registerSettingsRoute(webServer, deps)
  return { handler, file, applied, dir }
}

test('GET returns the described value', async () => {
  const { handler, dir } = mount()
  try {
    const res = response()
    await handler(request(), res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.value, { scope: 'session' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST persists only writable fields and bumps the revision', async () => {
  const { handler, file, applied, dir } = mount()
  try {
    const res = response()
    const req = request({
      method: 'POST',
      headers: { host: '127.0.0.1:3425', origin: 'http://127.0.0.1:3425' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ scope: 'system', sessionsPath: 'C:/evil.json' }))
      },
    })
    await handler(req, res)
    assert.equal(res.status, 200)
    assert.deepEqual(applied, [{ scope: 'system' }])
    assert.deepEqual(loadSettings(file), { revision: 1, value: { scope: 'system' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST from an untrusted origin is refused before it reaches the store', async () => {
  const { handler, file, applied, dir } = mount()
  try {
    const res = response()
    const req = request({
      method: 'POST',
      headers: { host: '127.0.0.1:3425', origin: 'http://evil.example' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ scope: 'system' }))
      },
    })
    await handler(req, res)
    assert.equal(res.status, 403)
    assert.deepEqual(applied, [])
    assert.deepEqual(loadSettings(file), { revision: 0, value: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejected value answers 400 and is not stored', async () => {
  const { handler, file, dir } = mount()
  try {
    const res = response()
    const req = request({
      method: 'POST',
      headers: { host: '127.0.0.1:3425' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ scope: 'nope' }))
      },
    })
    await handler(req, res)
    assert.equal(res.status, 400)
    assert.match(res.body.error, /scope must be/)
    assert.deepEqual(loadSettings(file), { revision: 0, value: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty or unknown body is refused', async () => {
  const { handler, dir } = mount()
  try {
    for (const body of [{}, { sessionsPath: 'x' }]) {
      const res = response()
      const req = request({
        method: 'POST',
        headers: { host: '127.0.0.1:3425' },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify(body))
        },
      })
      await handler(req, res)
      assert.equal(res.status, 400)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
