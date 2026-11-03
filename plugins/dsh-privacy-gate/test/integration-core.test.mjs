/**
 * Integration test against the REAL vendored `pii-core` (`vendor/pii-core.js`,
 * generated from `packages/pii-core/index.js` by `scripts/vendor-core.mjs`).
 *
 * This is the test that proves the gate is wired to the actual redactor API
 * rather than to the fake used by the unit tests. All values are synthetic
 * (docs/interface-contract.md I9) — the IBAN below is the public test IBAN.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../vendor/pii-core.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { shapePostExecute, shapePreStep } from '../lib/gate.js'
import { makeGateDeps } from './helpers.mjs'

const KEY = 'integration-fixture-key-not-a-secret'
const PII = Object.freeze({
  iban: 'DE89370400440532013000',
  email: 'max.mustermann@example.test',
})
const INVOICE = [
  'Rechnung Nr. 2026-0042',
  `IBAN ${PII.iban}`,
  `E-Mail ${PII.email}`,
  'Betrag 1.234,56 EUR',
].join('\n')

function realDeps(overrides = {}) {
  const deps = makeGateDeps(overrides)
  deps.redactor = core.createRedactor({ key: KEY })
  return deps
}

function realTools() {
  const written = []
  const config = { ...makeGateDeps().config, artifactDir: 'C:/workflow/artifacts' }
  const redactor = core.createRedactor({ key: KEY })
  const tools = buildToolDefinitions({
    config,
    redactor,
    pii: core,
    runExtract: async () => ({ ok: true, mode: 'pdf', engine: 'pdftotext', text: INVOICE, pages: 1, warnings: [] }),
    writeArtifact: (path, content) => written.push({ path, content }),
    audit: { record() { return true } },
    hashPath: (path) => `hash:${String(path).length}`,
  })
  return { byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])), written }
}

test('the vendored core exports the contract API', () => {
  assert.equal(typeof core.createRedactor, 'function')
  assert.equal(typeof core.tokenFor, 'function')
  assert.equal(typeof core.findPlaceholders, 'function')
  assert.equal(typeof core.isPlaceholderShaped, 'function')
  assert.ok(Array.isArray(core.KINDS) && core.KINDS.includes('BLOB'))
  const redactor = core.createRedactor({ key: KEY })
  for (const method of ['scan', 'redact', 'restore', 'resolve', 'hasPlaceholders', 'stats']) {
    assert.equal(typeof redactor[method], 'function', `redactor.${method} must exist`)
  }
})

test('extraction → masking: the real core keeps the invoice identifiers local', async () => {
  const { byName } = realTools()
  const value = await byName.privacy_extract.execute({ path: 'C:/workflow/fixtures/invoice.pdf', mode: 'pdf' })
  assert.equal(value.redacted, true)
  assert.ok(!value.text.includes(PII.iban), 'IBAN plaintext must not leave the tool')
  assert.ok(!value.text.includes(PII.email), 'email plaintext must not leave the tool')
  assert.match(value.text, /\{\{IBAN_[A-Z0-9]{8}\}\}/)
  assert.match(value.text, /\{\{EMAIL_[A-Z0-9]{8}\}\}/)
  assert.ok(value.tokens.length >= 2)
  assert.ok(!JSON.stringify(value.tokens).includes(PII.iban))
})

test('masking is idempotent with the real core', () => {
  const redactor = core.createRedactor({ key: KEY })
  const once = redactor.redact(INVOICE).text
  assert.equal(redactor.redact(once).text, once)
})

test('rehydrate round-trips through the real core without returning the value', async () => {
  const redactor = core.createRedactor({ key: KEY })
  const masked = redactor.redact(INVOICE).text
  const written = []
  const tools = buildToolDefinitions({
    config: { ...makeGateDeps().config, artifactDir: 'C:/workflow/artifacts' },
    redactor,
    pii: core,
    runExtract: async () => ({ ok: true, text: INVOICE }),
    writeArtifact: (path, content) => written.push({ path, content }),
    audit: { record() { return true } },
    hashPath: () => '',
  })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  const value = await byName.privacy_rehydrate.execute({ text: `Bitte prüfe ${masked}`, artifact_path: 'out/invoice.txt' })
  assert.equal(written.length, 1)
  assert.ok(written[0].content.includes(PII.iban), 'the local artifact holds the restored value')
  assert.equal(value.replaced, 2)
  assert.deepEqual(value.kinds, ['EMAIL', 'IBAN'])
  assert.ok(!JSON.stringify(value).includes(PII.iban))
})

test('rehydrate refuses placeholders it cannot resolve in this session', async () => {
  const { byName } = realTools()
  // A well-formed token for a fresh key that this redactor never masked.
  const token = core.tokenFor(KEY, 'IBAN', 'DE89370400440532013001')
  assert.equal(core.isPlaceholderShaped(token), true)
  await assert.rejects(
    () => byName.privacy_rehydrate.execute({ text: token, artifact_path: 'a.txt' }),
    /none of the placeholders resolve/,
  )
})

test('a base64 payload is blocked by the tool, not masked and returned', async () => {
  const { byName } = realTools()
  await assert.rejects(
    () => byName.privacy_scan.execute({ text: `data: ${'A'.repeat(3000)}` }),
    /binary payload \(BLOB\)/,
  )
})

test('gate 1 masks a read result with the real core, content and value', () => {
  const deps = realDeps()
  const result = {
    isError: false,
    value: { path: 'C:/workflow/x.txt', offset: 1, lines: [{ number: 1, text: `IBAN ${PII.iban}` }], totalLines: 1 },
    content: [{ type: 'text', text: `1\tIBAN ${PII.iban}` }],
  }
  const decision = shapePostExecute(deps, { name: 'read' }, result, { kind: 'accept' })
  assert.equal(decision.kind, 'accept')
  assert.ok(!JSON.stringify(decision).includes(PII.iban))
})

test('gate 3 masks a user message with the real core', () => {
  const deps = realDeps()
  const decision = { kind: 'enter', messages: [{ id: 'm', content: [{ type: 'text', text: `My IBAN is ${PII.iban}` }] }] }
  const shaped = shapePreStep(deps, {}, decision)
  assert.equal(shaped.kind, 'enter')
  assert.ok(!JSON.stringify(shaped).includes(PII.iban))
})

test('gate 3 still rejects an image attachment with the real core', () => {
  const deps = realDeps()
  const decision = { kind: 'enter', messages: [{ id: 'm', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }] }
  assert.deepEqual(shapePreStep(deps, {}, decision), { kind: 'reject' })
})
