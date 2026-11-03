import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXTRACT_MODES, buildExtractCommand, parseExtractOutput } from '../lib/extract.js'

const CLI = 'C:/workflow/packages/local-extract/cli.js'
const PDF = 'C:/workflow/fixtures/invoice.pdf'

test('buildExtractCommand produces the contract argv', () => {
  assert.deepEqual(buildExtractCommand({ cliPath: CLI, mode: 'pdf', filePath: PDF }), {
    command: process.execPath,
    args: [CLI, '--json', 'pdf', PDF],
  })
  assert.deepEqual(
    buildExtractCommand({ cliPath: CLI, mode: 'ocr', filePath: PDF, maxChars: 5000, pages: '1-2', lang: 'deu+eng' }).args,
    [CLI, '--json', 'ocr', PDF, '--max-chars', '5000', '--pages', '1-2', '--lang', 'deu+eng'],
  )
  assert.deepEqual(EXTRACT_MODES, ['pdf', 'ocr', 'doc', 'image', 'auto'])
})

test('buildExtractCommand rejects an unknown mode or a missing path', () => {
  assert.throws(() => buildExtractCommand({ cliPath: CLI, mode: 'magic', filePath: PDF }), /unknown extraction mode/)
  assert.throws(() => buildExtractCommand({ cliPath: CLI, mode: 'pdf', filePath: '' }), /path is required/)
  assert.throws(() => buildExtractCommand({ cliPath: '', mode: 'pdf', filePath: PDF }), /extractCli is not configured/)
})

test('a successful extraction normalizes mode, engine, text, pages and warnings', () => {
  const out = parseExtractOutput({
    status: 0,
    stdout: JSON.stringify({ ok: true, mode: 'pdf', engine: 'pdftotext', text: 'hello', pages: 3, chars: 5, warnings: ['no-text-layer', 7] }),
    stderr: '',
  })
  assert.equal(out.ok, true)
  assert.equal(out.engine, 'pdftotext')
  assert.equal(out.text, 'hello')
  assert.equal(out.pages, 3)
  assert.deepEqual(out.warnings, ['no-text-layer'])
})

test('a blocked extraction keeps the CLI reason', () => {
  const out = parseExtractOutput({
    status: 3,
    stdout: JSON.stringify({ ok: false, blocked: true, reason: 'NO_LOCAL_OCR', detail: 'no engine' }),
    stderr: '',
  })
  assert.equal(out.ok, false)
  assert.equal(out.blocked, true)
  assert.equal(out.reason, 'NO_LOCAL_OCR')
})

test('empty text is never a success (I3: fail closed)', () => {
  const out = parseExtractOutput({ status: 0, stdout: JSON.stringify({ ok: true, mode: 'pdf', text: '   \n', engine: 'x' }), stderr: '' })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'PARSE_FAILED')
})

test('malformed or non-JSON output fails closed', () => {
  assert.deepEqual(parseExtractOutput({ status: 0, stdout: 'not json', stderr: '' }), { ok: false, blocked: true, reason: 'PARSE_FAILED' })
  assert.deepEqual(parseExtractOutput({ status: 2, stdout: '', stderr: 'usage' }), { ok: false, blocked: true, reason: 'EXIT_2' })
  assert.equal(parseExtractOutput({ status: 1, stdout: JSON.stringify({ ok: true, text: 'x' }), stderr: '' }).reason, 'EXIT_1')
  assert.deepEqual(parseExtractOutput({ status: null, timedOut: true, stdout: '', stderr: '' }), { ok: false, blocked: true, reason: 'TIMEOUT' })
})

test('the parse step never invents text for an unexpected payload', () => {
  const out = parseExtractOutput({ status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' })
  assert.equal(out.ok, false)
  assert.equal(out.text, undefined)
})
