import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionRegistry, listExistingSessionIds } from '../lib/sessions.js'

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-scope-'))
  const sessionsDir = join(dir, 'sessions')
  mkdirSync(join(sessionsDir, '--project--', 'session-old-1'), { recursive: true })
  mkdirSync(join(sessionsDir, '--project--', 'session-old-2'), { recursive: true })
  mkdirSync(join(sessionsDir, '--project--', 'not-a-session'), { recursive: true })
  return { dir, sessionsDir, file: join(dir, 'privacy', 'sessions.json') }
}

test('listExistingSessionIds reads only session-* directories', () => {
  const { dir, sessionsDir } = workspace()
  try {
    assert.deepEqual(listExistingSessionIds(sessionsDir).sort(), ['old-1', 'old-2'])
    assert.deepEqual(listExistingSessionIds(join(dir, 'missing')), [])
    assert.deepEqual(listExistingSessionIds(''), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('system scope gates every session, including calls without an id', () => {
  const { dir, sessionsDir, file } = workspace()
  try {
    const registry = createSessionRegistry({ file, scope: 'system', sessionsDir })
    assert.equal(registry.isEnabled('old-1'), true)
    assert.equal(registry.isEnabled('anything-new'), true)
    assert.equal(registry.isEnabled(undefined), true)
    assert.equal(registry.status('old-1').scope, 'system')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session scope leaves pre-activation sessions alone and protects new ones', () => {
  const { dir, sessionsDir, file } = workspace()
  try {
    const registry = createSessionRegistry({ file, scope: 'session', sessionsDir, now: () => 1234 })
    assert.equal(registry.isEnabled('old-1'), false)
    assert.equal(registry.isEnabled('old-2'), false)
    assert.equal(registry.isEnabled('brand-new'), true)
    assert.equal(registry.isEnabled(undefined), false)
    assert.equal(registry.status('old-1').explicit, true)
    assert.equal(registry.status('brand-new').explicit, false)

    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.initializedAt, 1234)
    assert.deepEqual(stored.sessions, { 'old-1': false, 'old-2': false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit decision wins over the snapshot and survives a restart', () => {
  const { dir, sessionsDir, file } = workspace()
  try {
    const first = createSessionRegistry({ file, scope: 'session', sessionsDir })
    assert.equal(first.setEnabled('old-1', true), true)
    assert.equal(first.setEnabled('brand-new', false), true)
    assert.equal(first.setEnabled('', true), false)

    const second = createSessionRegistry({ file, scope: 'session', sessionsDir })
    assert.equal(second.isEnabled('old-1'), true)
    assert.equal(second.isEnabled('brand-new'), false)
    assert.equal(second.status('old-1').explicit, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt record starts clean instead of throwing', () => {
  const { dir, sessionsDir, file } = workspace()
  try {
    mkdirSync(join(dir, 'privacy'), { recursive: true })
    writeFileSync(file, '{ not json', 'utf8')
    const registry = createSessionRegistry({ file, scope: 'session', sessionsDir })
    assert.equal(registry.isEnabled('old-1'), false)
    assert.equal(registry.isEnabled('new-one'), true)
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof stored.initializedAt, 'number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable sessions directory records no legacy ids', () => {
  const { dir, file } = workspace()
  try {
    const registry = createSessionRegistry({ file, scope: 'session', sessionsDir: join(dir, 'nope') })
    assert.equal(registry.isEnabled('old-1'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty path keeps decisions in memory without throwing', () => {
  const registry = createSessionRegistry({ file: '', scope: 'session' })
  assert.equal(registry.isEnabled('x'), true)
  assert.equal(registry.setEnabled('x', false), true)
  assert.equal(registry.isEnabled('x'), false)
})
