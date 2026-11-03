// CLI integration tests for @shypie_privacy/local-extract.
//
// Fixtures are synthetic and generated locally by make-fixtures.mjs (I9).
// Every assertion checks the frozen docs/interface-contract.md JSON shape / exit codes /
// blocked-reason strings. OCR-dependent assertions branch honestly on whether
// a local OCR engine exists on the current machine.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { ensureFixtures } from './make-fixtures.mjs';
import { detectOcrEngines } from '../engines.js';
import { CLI, FIXTURES, fixture, runCli, assertBlock, assertSuccess } from './helpers.mjs';

let ocrEngines = [];
let firstOcrEngine = null;

before(async () => {
  await ensureFixtures(FIXTURES);
  ocrEngines = (await detectOcrEngines()).engines;
  firstOcrEngine = ocrEngines[0]?.name ?? null;
});

test('text PDF extracts a real text layer with pdftotext', async () => {
  const result = await runCli(['--json', 'pdf', fixture('text.pdf')]);
  assertSuccess(result, { mode: 'pdf', engine: 'pdftotext' });
  assert.match(result.json.text, /IBAN: DE89370400440532013000/);
  assert.equal(result.json.pages, 1);
  assert.deepEqual(result.json.warnings, []);
  // Success JSON carries exactly the contract fields.
  assert.deepEqual(Object.keys(result.json).sort(), [
    'chars',
    'elapsedMs',
    'engine',
    'mode',
    'ok',
    'pages',
    'text',
    'warnings',
  ]);
});

test('--pages limits extraction to the requested range', async () => {
  const result = await runCli(['--json', 'pdf', fixture('multipage.pdf'), '--pages', '2-2']);
  assertSuccess(result, { mode: 'pdf', engine: 'pdftotext' });
  assert.match(result.json.text, /Page two synthetic line/);
  assert.doesNotMatch(result.json.text, /Page one synthetic line/);
  assert.doesNotMatch(result.json.text, /Page three synthetic line/);
  assert.equal(result.json.pages, 1);
});

test('--max-chars truncates deterministically and warns', async () => {
  const result = await runCli(['--json', 'pdf', fixture('text.pdf'), '--max-chars', '20']);
  assertSuccess(result, { mode: 'pdf' });
  assert.equal(result.json.chars, 20);
  assert.equal(result.json.text.length, 20);
  assert.ok(result.json.warnings.includes('truncated'));
});

test('image-only PDF: local OCR extracts, or blocks NO_LOCAL_OCR without an engine', async () => {
  const result = await runCli(['--json', 'pdf', fixture('scanned.pdf')]);
  if (ocrEngines.length === 0) {
    assertBlock(result, 'NO_LOCAL_OCR');
    return;
  }
  assertSuccess(result, { mode: 'pdf', engine: firstOcrEngine });
  assert.match(result.json.text, /DE89370400440532013000/);
  assert.ok(result.json.warnings.includes('no-text-layer'));
  assert.equal(result.json.pages, 2);
});

test('--no-ocr forces the fail-closed NO_LOCAL_OCR block on a scanned PDF', async () => {
  const result = await runCli(['--json', 'pdf', fixture('scanned.pdf'), '--no-ocr']);
  assertBlock(result, 'NO_LOCAL_OCR');
});

test('scanned PDF with the renderer disabled blocks NO_LOCAL_RENDERER', async () => {
  const result = await runCli(['--json', 'pdf', fixture('scanned.pdf')], {
    env: { PRIVACY_EXTRACT_DISABLE_RENDERER: '1' },
  });
  if (ocrEngines.length === 0) {
    // No OCR engine at all: NO_LOCAL_OCR is the correct first block.
    assertBlock(result, 'NO_LOCAL_OCR');
    return;
  }
  assertBlock(result, 'NO_LOCAL_RENDERER');
});

test('image mode OCRs a synthetic PNG and never returns bytes', async () => {
  const result = await runCli(['--json', 'image', fixture('scan-page.png')]);
  if (ocrEngines.length === 0) {
    assertBlock(result, 'NO_LOCAL_OCR');
    return;
  }
  assertSuccess(result, { mode: 'image', engine: firstOcrEngine });
  assert.match(result.json.text, /DE89370400440532013000/);
});

test('ocr mode on a PDF renders and OCRs every page', async () => {
  const result = await runCli(['--json', 'ocr', fixture('scanned.pdf')]);
  if (ocrEngines.length === 0) {
    assertBlock(result, 'NO_LOCAL_OCR');
    return;
  }
  assertSuccess(result, { mode: 'ocr', engine: firstOcrEngine });
  assert.equal(result.json.pages, 2);
  assert.match(result.json.text, /Rechnung Nr\.: 1001/);
});

test('two-column invoice: OCR reading order pairs label and value per row', async () => {
  const result = await runCli(['--json', 'pdf', fixture('two-column-invoice.pdf')]);
  if (firstOcrEngine !== 'winrt-ocr') {
    // The coordinate-based reading-order reconstruction is WinRT-specific.
    if (ocrEngines.length === 0) assertBlock(result, 'NO_LOCAL_OCR');
    return;
  }
  assertSuccess(result, { mode: 'pdf', engine: 'winrt-ocr' });
  const lines = result.json.text.split('\n');
  assert.ok(
    lines.some((line) => /Rechnung Nr\. 1001/.test(line) && /Datum: 01\.02\.2026/.test(line)),
    `expected "Rechnung Nr. 1001" and "Datum: 01.02.2026" on one row, got: ${result.json.text}`,
  );
  assert.ok(
    lines.some((line) => /DE89370400440532013000/.test(line) && /Max Mustermann/.test(line)),
    `expected the IBAN row to keep its label, got: ${result.json.text}`,
  );
});

test('blank scanned page blocks instead of succeeding with empty text', async () => {
  const result = await runCli(['--json', 'pdf', fixture('blank.pdf')]);
  assertBlock(result, ocrEngines.length === 0 ? 'NO_LOCAL_OCR' : 'PARSE_FAILED');
});

test('encrypted PDF blocks ENCRYPTED_PDF', async () => {
  const result = await runCli(['--json', 'pdf', fixture('encrypted.pdf')]);
  assertBlock(result, 'ENCRYPTED_PDF');
});

test('structurally corrupt PDF blocks PARSE_FAILED', async () => {
  const result = await runCli(['--json', 'pdf', fixture('corrupt.pdf')]);
  assertBlock(result, 'PARSE_FAILED');
});

test('docx extracts with the bundled python-docx', async () => {
  const result = await runCli(['--json', 'doc', fixture('sample.docx')]);
  assertSuccess(result, { mode: 'doc', engine: 'python-docx' });
  assert.match(result.json.text, /Synthetic invoice/);
  assert.match(result.json.text, /IBAN: DE89370400440532013000/);
});

test('xlsx extracts with the bundled openpyxl', async () => {
  const result = await runCli(['--json', 'doc', fixture('sample.xlsx')]);
  assertSuccess(result, { mode: 'doc', engine: 'openpyxl' });
  assert.match(result.json.text, /# Sheet: Invoices/);
  assert.match(result.json.text, /1234\.56/);
});

test('pptx extracts with the bundled python-pptx', async () => {
  const result = await runCli(['--json', 'doc', fixture('sample.pptx')]);
  assertSuccess(result, { mode: 'doc', engine: 'python-pptx' });
  assert.match(result.json.text, /Synthetic deck/);
  assert.match(result.json.text, /Max Mustermann/);
});

test('corrupt OOXML blocks PARSE_FAILED', async () => {
  const result = await runCli(['--json', 'doc', fixture('corrupt.docx')]);
  assertBlock(result, 'PARSE_FAILED');
});

test('OOXML document with no text blocks instead of empty success', async () => {
  const result = await runCli(['--json', 'doc', fixture('empty.docx')]);
  assertBlock(result, 'PARSE_FAILED');
});

test('legacy OLE .doc blocks UNSUPPORTED_BINARY', async () => {
  const result = await runCli(['--json', 'doc', fixture('legacy.doc')]);
  assertBlock(result, 'UNSUPPORTED_BINARY');
});

test('auto mode dispatches a PDF, an image and a docx', async () => {
  const pdf = await runCli(['--json', 'auto', fixture('text.pdf')]);
  assertSuccess(pdf, { mode: 'pdf', engine: 'pdftotext' });

  const docx = await runCli(['--json', 'auto', fixture('sample.docx')]);
  assertSuccess(docx, { mode: 'doc', engine: 'python-docx' });

  const image = await runCli(['--json', 'auto', fixture('scan-page.png')]);
  if (ocrEngines.length === 0) assertBlock(image, 'NO_LOCAL_OCR');
  else assertSuccess(image, { mode: 'image', engine: firstOcrEngine });
});

test('unknown binary blocks UNSUPPORTED_BINARY in auto mode', async () => {
  const result = await runCli(['--json', 'auto', fixture('unsupported.bin')]);
  assertBlock(result, 'UNSUPPORTED_BINARY');
});

test('plain text blocks NOT_A_DOCUMENT in auto mode', async () => {
  const result = await runCli(['--json', 'auto', fixture('not-a-document.txt')]);
  assertBlock(result, 'NOT_A_DOCUMENT');
});

test('image input to pdf mode blocks NOT_A_DOCUMENT', async () => {
  const result = await runCli(['--json', 'pdf', fixture('scan-page.png')]);
  assertBlock(result, 'NOT_A_DOCUMENT');
});

test('timeout seam blocks TIMEOUT', async () => {
  const result = await runCli(['--json', 'pdf', fixture('text.pdf')], {
    env: { PRIVACY_EXTRACT_TIMEOUT_MS: '1' },
  });
  assertBlock(result, 'TIMEOUT');
});

test('output cap seam blocks OUTPUT_TOO_LARGE', async () => {
  const result = await runCli(['--json', 'pdf', fixture('text.pdf')], {
    env: { PRIVACY_EXTRACT_MAX_OUTPUT_BYTES: '50' },
  });
  assertBlock(result, 'OUTPUT_TOO_LARGE');
});

test('path outside PRIVACY_EXTRACT_ALLOWED_ROOT is a policy block', async () => {
  const result = await runCli(['--json', 'doc', CLI], {
    env: { PRIVACY_EXTRACT_ALLOWED_ROOT: FIXTURES },
  });
  assertBlock(result, 'PATH_NOT_ALLOWED');
});

test('path inside PRIVACY_EXTRACT_ALLOWED_ROOT is allowed', async () => {
  const result = await runCli(['--json', 'pdf', fixture('text.pdf')], {
    env: { PRIVACY_EXTRACT_ALLOWED_ROOT: FIXTURES },
  });
  assertSuccess(result, { mode: 'pdf' });
});

test('usage errors exit 2 and carry no content', async () => {
  const noArgs = await runCli([]);
  assert.equal(noArgs.code, 2);
  assert.equal(noArgs.json.ok, false);
  assert.equal(noArgs.json.error, 'USAGE');

  const badMode = await runCli(['--json', 'bogus', fixture('text.pdf')]);
  assert.equal(badMode.code, 2);
  assert.equal(badMode.json.error, 'USAGE');

  const missing = await runCli(['--json', 'pdf', fixture('nope.pdf')]);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.error, 'USAGE');
});

test('success stdout is exactly one JSON line and stderr stays empty', async () => {
  const result = await runCli(['--json', 'pdf', fixture('text.pdf')]);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  assert.equal(result.stderr.trim(), '');
});
