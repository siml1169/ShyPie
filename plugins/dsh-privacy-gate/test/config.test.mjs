import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, CONFIG_KEYS, resolveConfig } from '../lib/config.js'

const BASE = Object.freeze({
  extractCli: 'C:/workflow/packages/local-extract/cli.js',
  artifactDir: 'C:/workflow/artifacts',
  keyFile: 'C:/workflow/keys/placeholder.key',
})

test('empty config resolves to the documented fail-closed defaults', () => {
  const resolved = resolveConfig({}, BASE)
  assert.deepEqual(resolved.allowPaths, [])
  assert.deepEqual(resolved.detectors, [])
  assert.deepEqual(resolved.audit, { enabled: false, path: '' })
  assert.equal(resolved.extractCli, BASE.extractCli)
  assert.equal(resolved.artifactDir, BASE.artifactDir)
  assert.equal(resolved.placeholderKey.file, BASE.keyFile)
  assert.equal(resolved.blockNonTextResults, true)
  assert.equal('failClosed' in resolved, false, 'failing closed is not a switch')
})

test('the resolved config is frozen so a later row mutation cannot change the gate', () => {
  const resolved = resolveConfig({ allowPaths: ['C:/fixtures'] }, BASE)
  assert.ok(Object.isFrozen(resolved))
  assert.ok(Object.isFrozen(resolved.allowPaths))
  assert.throws(() => {
    resolved.allowPaths.push('C:/elsewhere')
  })
})

test('an unknown key is a startup error, not a silent ignore', () => {
  assert.throws(() => resolveConfig({ allowPath: [] }, BASE), /unknown key "allowPath"/)
  // The removed switch must not silently come back.
  assert.throws(() => resolveConfig({ failClosed: false }, BASE), /unknown key "failClosed"/)
  for (const key of ['allowPaths', 'detectors', 'extractCli', 'audit', 'placeholderKey']) {
    assert.ok(CONFIG_KEYS.includes(key), `documented config key ${key} must be accepted`)
  }
})

test('a configured extractCli overrides the deployment default', () => {
  const resolved = resolveConfig({ extractCli: 'C:/custom/cli.js' }, BASE)
  assert.equal(resolved.extractCli, 'C:/custom/cli.js')
})

test('audit.enabled requires a path', () => {
  assert.throws(() => resolveConfig({ audit: { enabled: true } }, BASE), /audit\.path is required/)
  const resolved = resolveConfig({ audit: { enabled: true, path: 'C:/workflow/audit.jsonl' } }, BASE)
  assert.equal(resolved.audit.enabled, true)
})

test('wrong types are rejected instead of coerced', () => {
  assert.throws(() => resolveConfig({ allowPaths: 'C:/x' }, BASE), /allowPaths must be an array/)
  assert.throws(() => resolveConfig({ allowPaths: [''] }, BASE), /non-empty strings/)
  assert.throws(() => resolveConfig({ toolTimeoutMs: 0 }, BASE), /toolTimeoutMs must be a positive integer/)
  assert.throws(() => resolveConfig({ maxExtractChars: 1.5 }, BASE), /maxExtractChars must be a positive integer/)
})

test('a deployment without a default path fails loudly', () => {
  assert.throws(() => resolveConfig({}, { artifactDir: BASE.artifactDir, keyFile: BASE.keyFile }), /extractCli has no default/)
  assert.throws(() => resolveConfig({}, { extractCli: BASE.extractCli, keyFile: BASE.keyFile }), /artifactDir has no default/)
  assert.throws(() => resolveConfig({}, { extractCli: BASE.extractCli, artifactDir: BASE.artifactDir }), /placeholderKey\.file has no default/)
})

test('null and undefined config behave like an empty object', () => {
  assert.deepEqual(resolveConfig(undefined, BASE).allowPaths, [])
  assert.deepEqual(resolveConfig(null, BASE).allowPaths, [])
})
