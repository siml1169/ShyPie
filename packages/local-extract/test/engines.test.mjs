// Unit tests for the pure/limited-I/O helpers in engines.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseRenderDpi,
  isInside,
  isMissingBinary,
  joinOcrPages,
  parseImageDimensions,
  parsePageRange,
  pickWinrtLanguage,
  rangePageCount,
  reconstructReadingOrder,
  requireText,
  runProcess,
  sniffHead,
} from '../engines.js';

// ---------------------------------------------------------------------------
// Page ranges
// ---------------------------------------------------------------------------

test('parsePageRange accepts ranges, single pages and absence', () => {
  assert.deepEqual(parsePageRange(undefined), { ok: true, range: null });
  assert.deepEqual(parsePageRange('2-5'), { ok: true, range: { first: 2, last: 5 } });
  assert.deepEqual(parsePageRange('3'), { ok: true, range: { first: 3, last: 3 } });
  assert.deepEqual(parsePageRange(' 4 - 6 '), { ok: true, range: { first: 4, last: 6 } });
});

test('parsePageRange rejects invalid ranges', () => {
  for (const spec of ['0-2', '5-2', 'a-b', '1-2-3', '-3', '1-']) {
    const result = parsePageRange(spec);
    assert.equal(result.ok, false, `expected rejection for ${spec}`);
    assert.equal(typeof result.detail, 'string');
  }
});

test('rangePageCount clamps to the known total', () => {
  assert.equal(rangePageCount(null, 5), 5);
  assert.equal(rangePageCount({ first: 2, last: 4 }, 5), 3);
  assert.equal(rangePageCount({ first: 4, last: 9 }, 5), 2);
  assert.equal(rangePageCount({ first: 9, last: 12 }, 5), 0);
});

// ---------------------------------------------------------------------------
// Magic sniffing
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('sniffHead recognises PDF, images, zip, OLE, text and binary', () => {
  assert.equal(sniffHead(Buffer.from('%PDF-1.7\n...')).kind, 'pdf');
  assert.equal(sniffHead(Buffer.from('junk'.repeat(3) + '%PDF-1.4')).kind, 'pdf');
  assert.deepEqual(sniffHead(Buffer.from(PNG_SIGNATURE)), { kind: 'image', format: 'png' });
  assert.deepEqual(sniffHead(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), { kind: 'image', format: 'jpeg' });
  assert.equal(sniffHead(Buffer.from([0x50, 0x4b, 0x03, 0x04])).kind, 'zip');
  assert.equal(sniffHead(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])).kind, 'ole');
  assert.equal(sniffHead(Buffer.from('Synthetic notes only.\n')).kind, 'text');
  assert.equal(sniffHead(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff])).kind, 'binary');
  assert.equal(sniffHead(Buffer.alloc(0)).kind, 'empty');
  assert.equal(sniffHead(Buffer.from('MZ\x90\x00')).kind, 'binary');
});

test('sniffHead keeps German umlauts as text', () => {
  assert.equal(sniffHead(Buffer.from('Rechnung für Müller\n')).kind, 'text');
});

// ---------------------------------------------------------------------------
// OCR reading order (measured WinRT boxes from a synthetic 2-column invoice)
// ---------------------------------------------------------------------------

const MEASURED_BOXES = [
  { text: 'Rechnung Nr. 1001', x: 116, y: 126, w: 798, h: 91 },
  { text: 'Kunde: Max Mustermann', x: 115, y: 376, w: 1040, h: 72 },
  { text: 'Position', x: 115, y: 651, w: 246, h: 55 },
  { text: 'Synthetic item A', x: 112, y: 846, w: 514, h: 68 },
  { text: 'Synthetic item B', x: 112, y: 1040, w: 510, h: 69 },
  { text: 'Menge', x: 1170, y: 651, w: 212, h: 68 },
  { text: '2', x: 1167, y: 846, w: 36, h: 54 },
  { text: '1', x: 1173, y: 1040, w: 22, h: 55 },
  { text: 'Preis', x: 1948, y: 651, w: 158, h: 55 },
  { text: '19,99 EUR', x: 1951, y: 846, w: 338, h: 65 },
  { text: '5,00 EUR', x: 1946, y: 1040, w: 306, h: 66 },
  { text: 'Datum: 01.02.2026', x: 2922, y: 126, w: 790, h: 72 },
  { text: 'IBAN: DE89370400440532013000', x: 2924, y: 376, w: 1449, h: 72 },
  { text: 'Summe', x: 2918, y: 651, w: 245, h: 55 },
  { text: '39,98 EUR', x: 2918, y: 846, w: 344, h: 65 },
  { text: '5,00 EUR', x: 2918, y: 1040, w: 305, h: 66 },
  { text: 'Gesamt: 44,98 EUR', x: 2921, y: 1460, w: 835, h: 85 },
];

test('reconstructReadingOrder restores row-major order for a 2-column layout', () => {
  const rows = reconstructReadingOrder(MEASURED_BOXES).split('\n');
  assert.equal(rows[0], 'Rechnung Nr. 1001 | Datum: 01.02.2026');
  assert.equal(rows[1], 'Kunde: Max Mustermann | IBAN: DE89370400440532013000');
  assert.equal(rows[2], 'Position | Menge | Preis | Summe');
  assert.equal(rows[3], 'Synthetic item A | 2 | 19,99 EUR | 39,98 EUR');
  assert.equal(rows[5], 'Gesamt: 44,98 EUR');
});

test('reconstructReadingOrder preserves single-column order and drops blanks', () => {
  const single = [
    { text: 'Line one', x: 100, y: 100, w: 400, h: 40 },
    { text: '   ', x: 100, y: 160, w: 10, h: 10 },
    { text: 'Line two', x: 100, y: 220, w: 400, h: 40 },
  ];
  assert.equal(reconstructReadingOrder(single), 'Line one\nLine two');
  assert.equal(reconstructReadingOrder([]), '');
  assert.equal(reconstructReadingOrder(null), '');
});

test('joinOcrPages keeps page boundaries and skips empty pages', () => {
  assert.equal(joinOcrPages(['one', ' ', 'two']), 'one\n\ntwo');
  assert.equal(joinOcrPages([]), '');
});

// ---------------------------------------------------------------------------
// Language and image sizing
// ---------------------------------------------------------------------------

test('pickWinrtLanguage maps tesseract codes to measured BCP-47 tags', () => {
  const available = ['de-DE', 'en-GB', 'en-US', 'zh-Hans-CN'];
  assert.deepEqual(pickWinrtLanguage('deu+eng', available), { tag: 'de-DE', warnings: [] });
  assert.deepEqual(pickWinrtLanguage('eng', available), { tag: 'en-US', warnings: [] });
  const unavailable = pickWinrtLanguage('fra', available);
  assert.equal(unavailable.tag, 'en-US');
  assert.ok(unavailable.warnings.some((warning) => warning.startsWith('lang-unavailable:')));
  const unmapped = pickWinrtLanguage('klingon', available);
  assert.ok(unmapped.warnings.some((warning) => warning.startsWith('lang-unmapped:')));
  assert.equal(pickWinrtLanguage('deu', []).tag, null);
  assert.deepEqual(pickWinrtLanguage('bad lang!', available).warnings, []);
});

test('parseImageDimensions reads PNG, BMP and JPEG headers', () => {
  const png = Buffer.alloc(24);
  Buffer.from(PNG_SIGNATURE).copy(png, 0);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(parseImageDimensions(png), { width: 1200, height: 800 });

  const bmp = Buffer.alloc(26);
  bmp.write('BM', 0, 'latin1');
  bmp.writeInt32LE(640, 18);
  bmp.writeInt32LE(-480, 22);
  assert.deepEqual(parseImageDimensions(bmp), { width: 640, height: 480 });

  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8]),
    Buffer.alloc(3),
  ]);
  assert.deepEqual(parseImageDimensions(jpeg), { width: 200, height: 100 });
  assert.equal(parseImageDimensions(Buffer.from('nope')), null);
});

test('chooseRenderDpi fits the page into the OCR bitmap limit', () => {
  assert.equal(chooseRenderDpi({ width: 595, height: 842 }, 10_000), 300);
  assert.equal(chooseRenderDpi(null, 10_000), 300);
  assert.equal(chooseRenderDpi({ width: 2384, height: 3370 }, 10_000), 202);
  assert.equal(chooseRenderDpi({ width: 100, height: 20_000 }, 4096), 72);
  assert.equal(chooseRenderDpi({ width: 100, height: 200 }, undefined), 300);
});

// ---------------------------------------------------------------------------
// runProcess: timeout / cap / missing binary / exit codes
// ---------------------------------------------------------------------------

test('runProcess reports ENOENT for a missing binary', async () => {
  const result = await runProcess('privacy-extract-definitely-not-a-binary-xyz', [], { timeoutMs: 5_000 });
  assert.equal(result.spawnError?.code, 'ENOENT');
  assert.equal(isMissingBinary(result), true);
  assert.equal(result.timedOut, false);
});

test('runProcess kills a child that exceeds its timeout', async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    timeoutMs: 150,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8_000, 'timeout must not wait for the child');
});

test('runProcess caps captured stdout and reports overflow', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], {
    timeoutMs: 10_000,
    maxBytes: 100,
  });
  assert.equal(result.overflow, true);
});

test('runProcess passes through exit codes and stdout', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("hello"); process.exit(7)'], {
    timeoutMs: 10_000,
  });
  assert.equal(result.code, 7);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.overflow, false);
});

// ---------------------------------------------------------------------------
// Misc guards
// ---------------------------------------------------------------------------

test('requireText refuses whitespace-only output', () => {
  assert.equal(requireText('   \n\f ').ok, false);
  assert.equal(requireText('   \n\f ').reason, 'PARSE_FAILED');
  assert.equal(requireText('has text').text, 'has text');
});

test('isInside is a strict directory-prefix test', () => {
  const root = process.platform === 'win32' ? 'C:\\work\\root' : '/work/root';
  const inside = process.platform === 'win32' ? 'C:\\work\\root\\a.pdf' : '/work/root/a.pdf';
  const sibling = process.platform === 'win32' ? 'C:\\work\\root2\\a.pdf' : '/work/root2/a.pdf';
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, inside), true);
  assert.equal(isInside(root, sibling), false);
});
