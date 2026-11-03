// Regression tests for the bypasses found in the security review (docs/research/security-review.md).
// Every fixture is synthetic and generated here; nothing is read from disk.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRedactor } from '../index.js'

const KEY = 'hardening-session-key'

/** Build a tiny, valid one-page PDF with a real text layer (same shape as the e2e fixture). */
function pdfBytes(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const stream = ['BT', '/F1 11 Tf', '72 780 Td', '14 TL', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const INVOICE = pdfBytes([
  'Rechnung Nr. 2026-0042',
  'IBAN DE89370400440532013000',
  'E-Mail erika.mustermann@example.com',
  'Betrag 1.234,56 EUR',
])

test('base64 of a small one-page invoice is a BLOB (contiguous)', () => {
  const b64 = INVOICE.toString('base64')
  assert.ok(b64.length >= 400 && b64.length < 2048, 'fixture must exercise the sub-2k case: ' + b64.length)
  const r = createRedactor({ key: KEY })
  const hits = r.scan('Hier die Datei: ' + b64)
  const blob = hits.filter((h) => h.kind === 'BLOB')
  assert.equal(blob.length, 1, 'small document must not slip under the old 2048 threshold')
  assert.equal(blob[0].source, 'blob:base64')
  const out = r.redact('Hier die Datei: ' + b64)
  assert.ok(!out.text.includes(b64.slice(0, 64)), 'the encoded document must be masked')
})

test('line-wrapped base64 of the same invoice is a BLOB', () => {
  const b64 = INVOICE.toString('base64')
  const wrapped = (b64.match(/.{1,64}/g) || []).join('\n')
  const r = createRedactor({ key: KEY })
  const hits = r.scan(wrapped).filter((h) => h.kind === 'BLOB')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].source, 'blob:base64-wrapped')
  assert.ok(r.redact(wrapped).tokens.some((t) => t.kind === 'BLOB'))
})

test('Format-Hex style spaced hex dump of the invoice is a BLOB', () => {
  const bytes = INVOICE
  const lines = []
  for (let off = 0; off < bytes.length; off += 16) {
    const slice = bytes.subarray(off, off + 16)
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, '0')).join(' ')
    lines.push(off.toString(16).padStart(8, '0') + '  ' + hex)
  }
  const dump = lines.join('\n')
  const r = createRedactor({ key: KEY })
  const hits = r.scan(dump).filter((h) => h.kind === 'BLOB')
  assert.ok(hits.length >= 1, 'a spaced hex dump must be caught')
  assert.ok(hits.some((h) => h.source === 'blob:hex-dump'))
})

test('a data: URI carrying a document is a BLOB regardless of size', () => {
  const small = 'data:application/pdf;base64,' + INVOICE.toString('base64').slice(0, 120)
  const hits = createRedactor({ key: KEY }).scan(small).filter((h) => h.kind === 'BLOB')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].source, 'blob:data-uri')
})

test('decimal tables are not mistaken for hex dumps', () => {
  const rows = []
  for (let i = 0; i < 200; i++) rows.push(`2026-${String(i % 12 + 1).padStart(2, '0')} 12 34 56 78 90 11 22 33`)
  const hits = createRedactor({ key: KEY }).scan(rows.join('\n')).filter((h) => h.kind === 'BLOB')
  assert.deepEqual(hits, [], 'digit-only tables must not trip the hex-dump rule')
})

test('a value split by zero-width characters is still detected and masked', () => {
  const r = createRedactor({ key: KEY })
  const iban = 'DE89370400440532013000'
  const broken = 'IBAN DE89\u200B3704\u200B0044\u200B0532\u200B0130\u200B00'
  const hits = r.scan(broken).filter((h) => h.kind === 'IBAN')
  assert.equal(hits.length, 1, 'zero-width characters must not hide the value')
  const out = r.redact(broken)
  assert.ok(!out.text.replace(/\s/g, '').includes(iban))
  assert.ok(out.tokens.some((t) => t.kind === 'IBAN'))
})

test('a soft hyphen / NBSP does not hide an e-mail', () => {
  const r = createRedactor({ key: KEY })
  const text = 'Mail: erika.mustermann@example\u00AD.com ist gueltig'
  assert.ok(r.scan(text).some((h) => h.kind === 'EMAIL'))
})

test('a value wrapped in a placeholder-shaped brace is not suppressed', () => {
  const r = createRedactor({ key: KEY })
  // Public BMF documentation example, valid ISO 7064 MOD 11,10; not customer data.
  const hidden = 'USt-IdNr {{DE136695976ABCDEFGH}} sowie {{DE136695976}}'
  const hits = r.scan(hidden).filter((h) => h.kind === 'VATID')
  assert.equal(hits.length, 2, 'placeholder-shaped text must not shield a real value')
})

test('a character that lowercases to two code units does not disable context detectors', () => {
  const r = createRedactor({ key: KEY })
  const plain = r.scan('Konto 1234567890').filter((h) => h.kind === 'ACCOUNT')
  const withU0130 = r.scan('\u0130 Konto 1234567890').filter((h) => h.kind === 'ACCOUNT')
  assert.equal(plain.length, 1)
  assert.equal(withU0130.length, 1, 'toLowerCase index desync must not disable ACCOUNT')
})

test('a very long digit run stays linear and is never passed through', async () => {
  const { performance } = await import('node:perf_hooks')
  const r = createRedactor({ key: KEY })
  const doc = '7'.repeat(300000)
  r.redact(doc) // warm
  const started = performance.now()
  const out = r.redact(doc)
  const ms = performance.now() - started
  assert.ok(ms < 250, `300k-digit run must not stall redaction, took ${ms.toFixed(1)} ms`)
  assert.ok(!out.text.includes('7777777777777777'), 'the digit run must be masked, not returned')
  assert.ok(out.tokens.some((t) => t.kind === 'BLOB'), 'a 300k digit run is a block signal')
})

test('redaction stays idempotent when a non-restorable kind was emitted', () => {
  const r = createRedactor({ key: KEY })
  const once = r.redact('PASSWORD=sup3rs3cret-value-1234567890 und IBAN DE89370400440532013000')
  assert.ok(once.tokens.some((t) => t.kind === 'SECRET'))
  const twice = r.redact(once.text)
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.tokens, [])
})
