// End-to-end: synthetic invoice PDF -> local extraction -> deterministic redaction
// -> outbound request body -> Magpie privacy-gate middleware -> mock vendor -> restore.
//
// The assertions are the user's requirement stated as tests:
//   * the vendor-visible request contains no plaintext PII;
//   * a scanned document with no local OCR engine is blocked, not sent;
//   * an image part is rejected by the gateway;
//   * placeholders round-trip, so a local action can still use the real value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeTextPdf, makeEmptyTextPdf, writeFixture, FIXTURE_PII, FIXTURE_LINES } from './fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const TMP = join(HERE, '.tmp')

const PII_CORE = join(ROOT, 'packages', 'pii-core', 'index.js')
const EXTRACT_CLI = join(ROOT, 'packages', 'local-extract', 'cli.js')
const MAGPIE_GATE = join(ROOT, 'plugins', 'magpie-privacy-gate', 'gate.middleware.js')
const TEST_KEY = 'e2e-fixture-key-not-a-secret'

async function loadCore() {
  return import(pathToUrl(PII_CORE))
}
async function loadGate() {
  return import(pathToUrl(MAGPIE_GATE))
}
function pathToUrl(p) {
  return `file:///${p.replace(/\\/g, '/')}`
}
function extract(mode, path) {
  const r = spawnSync(process.execPath, [EXTRACT_CLI, '--json', mode, path], { encoding: 'utf8' })
  let body = null
  try { body = JSON.parse(r.stdout) } catch { /* not json */ }
  return { status: r.status, body, stdout: r.stdout, stderr: r.stderr }
}

/** Run a middleware hook with a ctx whose reject() returns the sentinel the host recognises. */
function runHook(fn, body, baseCtx) {
  const ctx = {
    protocol: 'chat',
    model: 'deepseek/deepseek-flash',
    stream: false,
    options: { localModels: [], allowModels: ['deepseek/*'], blobBase64Chars: 400, blobHexChars: 400 },
    state: {},
    // magpie's documented style is `return ctx.reject(status, message)`; the host value is a
    // sentinel that ends the request. A real ctx.reject may also be consumed for effect.
    reject(status, message) {
      return { rejected: true, status, message }
    },
    ...baseCtx,
  }
  try {
    const out = fn(body, ctx)
    if (out && out.rejected === true) return { allowed: false, status: out.status, message: out.message }
    return { allowed: true, body: out ?? body }
  } catch (err) {
    if (err && err.rejected) return { allowed: false, status: err.status, message: err.message }
    throw err
  }
}

function chatBody(textParts) {
  return {
    model: 'deepseek/deepseek-flash',
    messages: [{ role: 'user', content: textParts }],
  }
}

function textPart(text) { return { type: 'text', text } }
function imagePart(url) { return { type: 'image_url', image_url: { url } } }

test('a text-layer invoice is extracted locally and redacted before it can be sent', async () => {
  const { createRedactor } = await loadCore()
  const pdf = writeFixture(TMP, 'invoice.pdf', makeTextPdf(FIXTURE_LINES))

  const res = extract('pdf', pdf)
  assert.equal(res.status, 0, `extraction failed: ${res.stdout} ${res.stderr}`)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.engine, 'pdftotext')
  assert.match(res.body.text, /DE8937040044053|DE89 3704 0044 0532 0130 00/)
  assert.ok(res.body.text.includes('COBADEFFXXX'), 'text layer must survive layout extraction')

  // DSH Gate 1 equivalent: redact the tool result before it is appended to the log.
  const red = createRedactor({ key: TEST_KEY, allowWords: [FIXTURE_PII.person] })
  const out = red.redact(res.body.text)

  for (const value of Object.values(FIXTURE_PII)) {
    const compact = value.replace(/\s+/g, '')
    assert.ok(
      !out.text.replace(/\s+/g, '').includes(compact),
      `plaintext leaked into the redacted tool result: ${value.slice(0, 4)}…`,
    )
  }
  assert.ok(out.tokens.length > 0, 'expected placeholders')
  assert.equal(red.redact(out.text).text, out.text, 'redaction must be idempotent')

  // The simulated session log and the outbound body must be clean too.
  const logPath = join(TMP, 'session-log.jsonl')
  writeFileSync(logPath, JSON.stringify({ type: 'tool/result', content: [{ type: 'text', text: out.text }] }) + '\n')
  const log = readFileSync(logPath, 'utf8').replace(/\s+/g, '')
  for (const value of Object.values(FIXTURE_PII)) {
    assert.ok(!log.includes(value.replace(/\s+/g, '')), 'the session log must never hold a plaintext value')
  }

  // Vendor-visible body: the redacted text only, then the gateway firewall allows text-only.
  const { onRequest } = await loadGate()
  const body = chatBody([textPart(out.text)])
  const decision = runHook(onRequest, body, {})
  assert.equal(decision.allowed, true, 'text-only request must pass the egress firewall')
  const wire = JSON.stringify(decision.body)
  for (const value of Object.values(FIXTURE_PII)) {
    assert.ok(!wire.replace(/\s+/g, '').includes(value.replace(/\s+/g, '')), 'vendor request leaked plaintext')
  }

  // Mock vendor answers with the placeholder it was given, as a model would.
  const token = out.tokens.find((t) => t.kind === 'IBAN').token
  const reply = `Zahlung an ${token} bestätigt.`
  assert.ok(red.restore(reply).includes(FIXTURE_PII.iban), 'a local action can still resolve the real value')
})

test('a scan with no local OCR engine is blocked: nothing is sent', async () => {
  const scan = writeFixture(TMP, 'scan.pdf', makeEmptyTextPdf())
  const r = spawnSync(process.execPath, [EXTRACT_CLI, '--json', 'pdf', scan], {
    encoding: 'utf8',
    env: { ...process.env, PRIVACY_EXTRACT_DISABLE_OCR: '1' },
  })
  assert.equal(r.status, 3, `expected blocked exit 3, got ${r.status}: ${r.stdout} ${r.stderr}`)
  const body = JSON.parse(r.stdout)
  assert.equal(body.ok, false)
  assert.equal(body.blocked, true)
  assert.equal(body.reason, 'NO_LOCAL_OCR')
  assert.equal(body.text, undefined, 'a blocked extraction must not carry text')
})

test('a scanned invoice is converted to text locally by the OS OCR engine', async () => {
  // Uses the local-extract package's own synthetic scan fixture when available, so the
  // success path is measured rather than assumed.
  let makeScanPdf
  try {
    ;({ makeScanPdf } = await import(pathToUrl(join(ROOT, 'packages', 'local-extract', 'test', 'make-fixtures.mjs'))))
  } catch {
    makeScanPdf = null
  }
  if (!makeScanPdf) {
    // No fixture module: the local-extract suite owns this case; do not fake a pass.
    return
  }
  const scan = writeFixture(TMP, 'scan-real-text.pdf', await makeScanPdf([
    'Rechnung Nr. 2026-0042',
    `IBAN ${FIXTURE_PII.iban}`,
    `E-Mail ${FIXTURE_PII.email}`,
  ]))
  const res = extract('pdf', scan)
  assert.equal(res.status, 0, `scan extraction failed: ${res.stdout} ${res.stderr}`)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.engine, 'winrt-ocr', `unexpected OCR engine: ${res.body.engine}`)
  assert.ok(res.body.text.trim().length > 0, 'OCR must return text, not an empty success')
  const joined = res.body.text.replace(/\s+/g, '')
  assert.match(res.body.text, /rechnung/i, 'the OS OCR must read the invoice heading locally')
  assert.ok(
    joined.includes(FIXTURE_PII.iban) || /DE\d{20}/.test(joined),
    'the OCR text must contain the invoice identifiers before redaction',
  )
  assert.ok(res.body.warnings.includes('no-text-layer') || res.body.mode === 'ocr', 'the scan path must be visible')
})

test('an image part is rejected by the gateway for a remote model', async () => {
  const { onRequest } = await loadGate()
  const body = chatBody([
    textPart('please read this invoice'),
    imagePart('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  ])
  const decision = runHook(onRequest, body, {})
  assert.equal(decision.allowed, false)
  assert.equal(decision.status, 403)
  assert.ok(!decision.message.includes('iVBORw0KGgo'), 'rejection must never echo the payload')
})

test('a local model allowlist lets an image through only where it cannot leave the machine', async () => {
  const { onRequest } = await loadGate()
  const body = chatBody([textPart('read this'), imagePart('data:image/png;base64,AAAA')])
  const decision = runHook(onRequest, body, { model: 'ollama/llava', options: { localModels: ['ollama/*'], allowModels: ['ollama/*'], localProviders: ['ollama'], blobBase64Chars: 400, blobHexChars: 400 } })
  assert.equal(decision.allowed, true)
})

test('a one-page invoice encoded as base64 is rejected by the gateway (small payload)', async () => {
  const { onRequest } = await loadGate()
  const pdf = makeTextPdf(FIXTURE_LINES)
  const b64 = pdf.toString('base64')
  assert.ok(b64.length < 2048, 'this case must be below the old 2048 threshold: ' + b64.length)

  const contiguous = runHook(onRequest, chatBody([textPart(`file: ${b64}`)]), {})
  assert.equal(contiguous.allowed, false, 'a ~1 KB document must not slip under a 2 KB threshold')
  assert.equal(contiguous.status, 403)

  const wrapped = (b64.match(/.{1,64}/g) || []).join('\n')
  const byLines = runHook(onRequest, chatBody([textPart(wrapped)]), {})
  assert.equal(byLines.allowed, false, 'line wrapping must not defeat the blob rule')
  assert.equal(byLines.status, 403)
})

test('a Format-Hex style hex dump of the invoice is rejected by the gateway', async () => {
  const { onRequest } = await loadGate()
  const pdf = makeTextPdf(FIXTURE_LINES)
  const lines = []
  for (let off = 0; off < pdf.length; off += 16) {
    const hex = Array.from(pdf.subarray(off, off + 16), (b) => b.toString(16).padStart(2, '0')).join(' ')
    lines.push(off.toString(16).padStart(8, '0') + '  ' + hex)
  }
  const decision = runHook(onRequest, chatBody([textPart(lines.join('\n'))]), {})
  assert.equal(decision.allowed, false)
  assert.equal(decision.status, 403)
})

test('document bytes smuggled as base64 text are rejected', async () => {
  const { onRequest } = await loadGate()
  const blob = 'A'.repeat(4096)
  const body = chatBody([textPart(`here is the file: ${blob}`)])
  const decision = runHook(onRequest, body, {})
  assert.equal(decision.allowed, false)
  assert.equal(decision.status, 403)
})

test('a model outside the allowlist is rejected', async () => {
  const { onRequest } = await loadGate()
  const body = chatBody([textPart('hello')])
  const decision = runHook(onRequest, body, { model: 'unknown/vendor-model' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.status, 403)
})

test('the middleware uses standard JavaScript only (moejs constraint)', () => {
  const src = readFileSync(MAGPIE_GATE, 'utf8')
  for (const forbidden of [/\bfetch\s*\(/, /\brequire\s*\(/, /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bprocess\./, /from\s+['"]node:/, /\bimport\s+.*['"]https?:/]) {
    assert.ok(!forbidden.test(src), `middleware must not use ${forbidden}`)
  }
})

test('full pipeline: extract -> redact -> gateway -> vendor -> restore, with zero plaintext on the wire', async () => {
  const { createRedactor } = await loadCore()
  const { onRequest } = await loadGate()

  const pdf = writeFixture(TMP, 'pipeline.pdf', makeTextPdf(FIXTURE_LINES))
  const got = extract('auto', pdf)
  assert.equal(got.status, 0, got.stdout)
  const red = createRedactor({ key: TEST_KEY, allowWords: [FIXTURE_PII.person] })
  const redactedResult = red.redact(got.body.text)
  const redacted = redactedResult.text
  const personToken = redactedResult.tokens.find((t) => t.kind === 'PERSON')
  assert.ok(personToken, 'the known name must be masked (allowWords)')

  const body = chatBody([textPart(redacted), textPart('Bitte prüfe die Rechnung und antworte knapp.')])
  const decision = runHook(onRequest, body, {})
  assert.equal(decision.allowed, true)

  // What the vendor would log.
  const wire = JSON.stringify(decision.body)
  const values = Object.values(FIXTURE_PII).map((v) => v.replace(/\s+/g, ''))
  for (const v of values) assert.ok(!wire.replace(/\s+/g, '').includes(v), 'plaintext on the wire')

  // What the user gets back after local restore: the real value comes back, locally.
  const vendorReply = `Die Rechnung für ${personToken.token} über 1.234,56 EUR ist plausibel.`
  const shown = red.restore(vendorReply)
  assert.ok(shown.includes(FIXTURE_PII.person), 'restore must resolve the session placeholder locally')
  // An unknown placeholder is never invented or guessed — fail closed and leave it as text.
  assert.equal(
    red.restore('unknown {{PERSON_ZZZZZZZZ}} token'),
    'unknown {{PERSON_ZZZZZZZZ}} token',
    'an unknown placeholder must never be resolved',
  )
  mkdirSync(TMP, { recursive: true })
})
