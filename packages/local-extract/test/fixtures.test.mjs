// Tests for the public fixture API used by the end-to-end tests.
// These prove the named exports are stable, deterministic, image-only scans have
// no text layer, and text PDFs do — without any network or real documents (I9).

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeScanPdf, makeTextPdf, ensureFixtures, FIXTURE_VERSION } from './make-fixtures.mjs';
import { assertBlock, assertSuccess, runCli, FIXTURES, fixture } from './helpers.mjs';

test('fixtures are versioned and complete', async () => {
  await ensureFixtures(FIXTURES);
  assert.equal(Number.isInteger(FIXTURE_VERSION), true);
  await access(fixture('text.pdf'));
  await access(fixture('scanned.pdf'));
});

test('makeTextPdf returns a PDF buffer with a real text layer', async () => {
  const buffer = makeTextPdf(['Synthetic line alpha', 'IBAN: DE89370400440532013000']);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(buffer.toString('latin1'), /\/Type \/Page/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'privacy-fixtures-test-'));
  try {
    const file = path.join(dir, 'text.pdf');
    await writeFile(file, buffer);
    // --no-ocr: the text must come from the text layer, not from OCR.
    const result = await runCli(['--json', 'pdf', file, '--no-ocr']);
    assertSuccess(result, { mode: 'pdf', engine: 'pdftotext' });
    assert.match(result.json.text, /IBAN: DE89370400440532013000/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('makeScanPdf returns an image-only PDF that blocks without OCR', async () => {
  const buffer = await makeScanPdf(['Synthetic scan line', 'IBAN: DE89370400440532013000']);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(buffer.toString('latin1'), /\/DCTDecode/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'privacy-fixtures-test-'));
  try {
    const file = path.join(dir, 'scan.pdf');
    await writeFile(file, buffer);
    // No text layer + OCR disabled => must block, never return empty bytes/text.
    const result = await runCli(['--json', 'pdf', file, '--no-ocr']);
    assertBlock(result, 'NO_LOCAL_OCR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('makeScanPdf output is deterministic for the same input', async () => {
  const lines = ['Deterministic synthetic line', 'Gesamt: 44,98 EUR'];
  const first = await makeScanPdf(lines);
  const second = await makeScanPdf(lines);
  assert.equal(first.equals(second), true);
});
