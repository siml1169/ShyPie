import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildLiveRowConfig, liveFromConfig, SETTINGS_NAMESPACE } from '../lib/settings.js'
import { resolveConfig } from '../lib/config.js'

function base(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-live-'))
  return {
    dir,
    row: {
      allowPaths: ['C:/work'],
      placeholderKey: { file: join(dir, 'placeholder.key') },
      artifactDir: join(dir, 'artifacts'),
      sessionsPath: join(dir, 'sessions.json'),
      extractCli: 'C:/tools/local-extract/cli.js',
      audit: { enabled: false, path: '' },
      ...overrides,
    },
  }
}

test('the namespace is the kebab-case row id', () => {
  assert.equal(SETTINGS_NAMESPACE, 'privacy-gate')
})

test('liveFromConfig projects the resolved row config onto the live schema', () => {
  const { dir, row } = base({ scope: 'system', ocrEngine: 'vision', visionProvider: 'magpie', visionModel: 'qwen-vl' })
  try {
    const live = liveFromConfig(resolveConfig(row, {}))
    assert.equal(live.scope, 'system')
    assert.deepEqual(live.allowPaths, ['C:/work'])
    assert.equal(live.extractCli, 'C:/tools/local-extract/cli.js')
    assert.equal(live.ocrEngine, 'vision')
    assert.equal(live.visionProvider, 'magpie')
    assert.equal(live.visionModel, 'qwen-vl')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a live value layers over the row config without dropping row-only keys', () => {
  const { dir, row } = base()
  try {
    const live = {
      ...liveFromConfig(resolveConfig(row, {})),
      scope: 'system',
      allowPaths: ['C:/other'],
      ocrEngine: 'auto',
    }
    const merged = resolveConfig(buildLiveRowConfig(row, live), {})
    assert.equal(merged.scope, 'system')
    assert.deepEqual(merged.allowPaths, ['C:/other'])
    assert.equal(merged.ocrEngine, 'auto')
    // Row-only keys survive the merge.
    assert.equal(merged.sessionsPath, row.sessionsPath)
    assert.equal(merged.artifactDir, row.artifactDir)
    assert.equal(merged.extractCli, row.extractCli)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an invalid live value is refused instead of stored', () => {
  const { dir, row } = base()
  try {
    const live = { ...liveFromConfig(resolveConfig(row, {})), scope: 'everywhere' }
    assert.throws(() => resolveConfig(buildLiveRowConfig(row, live), {}), /scope must be "session" or "system"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
