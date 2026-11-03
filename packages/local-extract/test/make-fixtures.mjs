// Synthetic fixture generator for @shypie/local-extract.
//
// Everything here is generated locally and deterministically: hand-built minimal
// PDFs, JPEG/PNG pages rendered with the bundled Pillow, and OOXML files written
// with the bundled python-docx / openpyxl / python-pptx. No network, no npm deps,
// and never a real document (invariant I9).
//
// Public API (stable: the end-to-end tests import these):
//   makeTextPdf(lines | string[][])   -> Buffer  (one page per string[], text layer)
//   makeScanPdf(lines | string[][])   -> Promise<Buffer>  (image-only PDF, DCTDecode JPEG)
//   makeScanImage(lines | string[][]) -> Promise<Buffer[]> (PNG pages, same renderer)
//   generateFixtures(dir)             -> Promise<void>   (full fixture set)
//   ensureFixtures(dir)               -> Promise<void>   (generate only if stale)
//   FIXTURE_VERSION
//
// The scan renderer uses Arial at 44 px on a 2400 px wide page, embedded so a
// 300 dpi pdftoppm render is 1:1 with the source pixels. This combination was
// measured to OCR correctly with the WinRT adapter on this machine.

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePythonPath, runProcess, timeoutFor } from '../engines.js';

export const FIXTURE_VERSION = 4;

const SCAN_PAGE_WIDTH = 2400;
const SCAN_FONT_SIZE = 44;
const SCAN_LINE_HEIGHT = 110;
const SCAN_MARGIN = 100;
const SCAN_DPI = 300;

const SCAN_SCRIPT = `
import sys, os, json
from PIL import Image, ImageDraw, ImageFont
outdir = sys.argv[1]
pages = json.loads(sys.argv[2])
extension = sys.argv[3] if len(sys.argv) > 3 else "jpg"
candidates = [r"C:\\Windows\\Fonts\\arial.ttf", r"C:\\Windows\\Fonts\\segoeui.ttf", r"C:\\Windows\\Fonts\\DejaVuSans.ttf"]
font = None
for candidate in candidates:
    try:
        font = ImageFont.truetype(candidate, ${SCAN_FONT_SIZE})
        break
    except Exception:
        font = None
if font is None:
    font = ImageFont.load_default()
for index, lines in enumerate(pages, 1):
    height = 200 + ${SCAN_LINE_HEIGHT} * max(1, len(lines))
    image = Image.new("RGB", (${SCAN_PAGE_WIDTH}, height), "white")
    draw = ImageDraw.Draw(image)
    y = ${SCAN_MARGIN}
    for row in lines:
        if isinstance(row, list) and row and isinstance(row[0], list):
            for pair in row:
                draw.text((int(pair[0]), y), str(pair[1]), fill="black", font=font)
        else:
            draw.text((${SCAN_MARGIN}, y), str(row), fill="black", font=font)
        y += ${SCAN_LINE_HEIGHT}
    target = os.path.join(outdir, "page-%d.%s" % (index, extension))
    if extension == "png":
        image.save(target, "PNG")
    else:
        image.save(target, "JPEG", quality=90)
print("SCAN_OK %d" % len(pages))
`.trim();

const OFFICE_SCRIPT = [
  'import sys, os, zipfile',
  'out = sys.argv[1]',
  'from docx import Document',
  'document = Document()',
  'document.add_heading("Synthetic invoice", level=1)',
  'document.add_paragraph("Customer: Max Mustermann")',
  'document.add_paragraph("IBAN: DE89370400440532013000")',
  'table = document.add_table(rows=2, cols=2)',
  'table.cell(0, 0).text = "Item"',
  'table.cell(0, 1).text = "Amount"',
  'table.cell(1, 0).text = "Synthetic item A"',
  'table.cell(1, 1).text = "19,99 EUR"',
  'document.save(os.path.join(out, "sample.docx"))',
  'Document().save(os.path.join(out, "empty.docx"))',
  'from openpyxl import Workbook',
  'workbook = Workbook()',
  'sheet = workbook.active',
  'sheet.title = "Invoices"',
  'sheet.append(["Invoice", "Amount"])',
  'sheet.append(["1001", 1234.56])',
  'second = workbook.create_sheet("Notes")',
  'second.append(["Synthetic data only"])',
  'workbook.save(os.path.join(out, "sample.xlsx"))',
  'from pptx import Presentation',
  'from pptx.util import Inches',
  'presentation = Presentation()',
  'slide = presentation.slides.add_slide(presentation.slide_layouts[5])',
  'slide.shapes.title.text = "Synthetic deck"',
  'textbox = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(6), Inches(2))',
  'textbox.text_frame.text = "Customer: Max Mustermann"',
  'textbox.text_frame.add_paragraph().text = "IBAN DE89370400440532013000"',
  'presentation.save(os.path.join(out, "sample.pptx"))',
  'with zipfile.ZipFile(os.path.join(out, "corrupt.docx"), "w") as archive:',
  '    archive.writestr("[Content_Types].xml", "<Types/>")',
  '    archive.writestr("word/document.xml", "<not-xml")',
  'print("OFFICE_OK")',
].join('\n');

// ---------------------------------------------------------------------------
// Minimal PDF assembly
// ---------------------------------------------------------------------------

const PDF_HEADER = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');

function escapePdfText(text) {
  // Keep the fixture byte-oriented: WinAnsi/Latin-1 only.
  const latin1 = String(text)
    .normalize('NFC')
    .replace(/[^\u0000-\u00ff]/g, '?')
    .replace(/\r\n?/g, ' ');
  return latin1.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdf(objects, { trailerExtra = '' } = {}) {
  // objects[0] is unused so object numbers match array indices.
  const chunks = [PDF_HEADER];
  const offsets = [];
  let position = PDF_HEADER.length;
  for (let number = 1; number < objects.length; number += 1) {
    const body = objects[number];
    if (body === undefined || body === null) throw new Error(`fixture PDF object ${number} is missing`);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const head = Buffer.from(`${number} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets[number] = position;
    chunks.push(head, buffer, tail);
    position += head.length + buffer.length + tail.length;
  }

  const xrefPosition = position;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let number = 1; number < objects.length; number += 1) {
    xref += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${objects.length} /Root 1 0 R ${trailerExtra}>>\n` +
    `startxref\n${xrefPosition}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

function toPages(linesOrPages) {
  if (!Array.isArray(linesOrPages)) throw new TypeError('expected an array of lines or an array of pages');
  if (linesOrPages.length === 0) return [[]];
  const first = linesOrPages[0];
  if (Array.isArray(first)) return linesOrPages.map((page) => [...page]);
  return [[...linesOrPages]];
}

function textPageContent(lines, { fontSize = 12, left = 72, top = 780, leading = 20 } = {}) {
  const commands = ['BT', `/F1 ${fontSize} Tf`, `${left} ${top} Td`];
  lines.forEach((line, index) => {
    if (index > 0) commands.push(`0 -${leading} Td`);
    commands.push(`(${escapePdfText(line)}) Tj`);
  });
  commands.push('ET');
  return commands.join('\n');
}

function streamObject(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< /Length ${buffer.length} >>\nstream\n`, 'latin1'),
    buffer,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

function textPdfBuffer(linesOrPages, options = {}) {
  const pages = toPages(linesOrPages);
  const pageCount = pages.length;
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  const kids = [];
  for (let index = 0; index < pageCount; index += 1) {
    const contentNumber = 4 + index * 2;
    const pageNumber = 5 + index * 2;
    kids.push(`${pageNumber} 0 R`);
    objects[contentNumber] = streamObject(textPageContent(pages[index]));
    objects[pageNumber] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;

  let nextNumber = 4 + pageCount * 2;
  for (const extra of options.extraObjects ?? []) {
    objects[nextNumber] = extra;
    nextNumber += 1;
  }
  return buildPdf(objects, { trailerExtra: options.trailerExtra ?? '' });
}

/** One page of real text per string[] passed; a flat string[] is a single page. */
export function makeTextPdf(linesOrPages) {
  return textPdfBuffer(linesOrPages);
}

function imagePdfBuffer(jpegPages) {
  const pageCount = jpegPages.length;
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const PageOffset = 3 + pageCount * 2;
  const kids = [];
  for (let index = 0; index < pageCount; index += 1) {
    const { jpeg, width, height } = jpegPages[index];
    const imageNumber = 3 + index * 2;
    const contentNumber = 4 + index * 2;
    const pageNumber = PageOffset + index;
    kids.push(`${pageNumber} 0 R`);

    objects[imageNumber] = Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'latin1',
      ),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]);
    // 1 image pixel == 1/300 inch, so a 300 dpi render is lossless-ish 1:1.
    const pageWidth = ((width * 72) / SCAN_DPI).toFixed(3);
    const pageHeight = ((height * 72) / SCAN_DPI).toFixed(3);
    objects[contentNumber] = streamObject(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`);
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /XObject << /Im0 ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  return buildPdf(objects);
}

// ---------------------------------------------------------------------------
// Synthetic scan rendering (Pillow, bundled python)
// ---------------------------------------------------------------------------

function pythonPathOrThrow() {
  const python = resolvePythonPath();
  if (!existsSync(python)) throw new Error('bundled python interpreter not found for fixture rendering');
  return python;
}

async function renderScanPages(linesOrPages, extension = 'jpg') {
  const pages = toPages(linesOrPages);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'privacy-fixtures-scan-'));
  try {
    const result = await runProcess(
      pythonPathOrThrow(),
      ['-c', SCAN_SCRIPT, dir, JSON.stringify(pages), extension],
      { timeoutMs: timeoutFor('python') },
    );
    if (result.code !== 0 || !/SCAN_OK/.test(result.stdout)) {
      throw new Error(`fixture renderer failed: ${(result.stderr || result.stdout || '').slice(0, 400)}`);
    }
    const names = (await readdir(dir)).filter((name) => name.startsWith('page-')).sort();
    const pagesOut = [];
    for (const name of names) {
      pagesOut.push(await readFile(path.join(dir, name)));
    }
    if (pagesOut.length === 0) throw new Error('fixture renderer produced no pages');
    return pagesOut;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Image-only PDF (DCTDecode JPEG pages). Never has a text layer. */
export async function makeScanPdf(linesOrPages) {
  const pages = toPages(linesOrPages);
  const jpegs = await renderScanPages(pages, 'jpg');
  return imagePdfBuffer(
    jpegs.map((jpeg, index) => ({
      jpeg,
      width: SCAN_PAGE_WIDTH,
      height: scanPageHeight(pages[index] ?? []),
    })),
  );
}

/** PNG pages rendered by the same deterministic renderer (for image-mode tests). */
export async function makeScanImage(linesOrPages) {
  return renderScanPages(linesOrPages, 'png');
}

function scanPageHeight(lines) {
  return 200 + SCAN_LINE_HEIGHT * Math.max(1, lines.length);
}

// ---------------------------------------------------------------------------
// Encrypted PDF (Standard security handler, empty user password)
// ---------------------------------------------------------------------------

function makeEncryptedPdf(linesOrPages) {
  // A real Standard-security-handler dictionary. The file is genuinely
  // encrypted by poppler's bookkeeping (pdfinfo reports "Encrypted: yes"), which
  // is all the CLI's pre-flight encryption guard needs to block on.
  const objectHex = (seed) => (seed + 'A'.repeat(64)).slice(0, 64).toUpperCase();
  const encryptObject = (index) =>
    `<< /Filter /Standard /V 1 /R 2 /O <${objectHex('1F')}> /U <${objectHex('2E')}> /P -3904 >>`;
  const pageCount = toPages(linesOrPages).length;
  const encryptNumber = 4 + pageCount * 2;
  return textPdfBuffer(linesOrPages, {
    extraObjects: [encryptObject(encryptNumber)],
    trailerExtra: `/Encrypt ${encryptNumber} 0 R /ID [<${objectHex('3D').slice(0, 32)}><${objectHex('4C').slice(0, 32)}>] `,
  });
}

// ---------------------------------------------------------------------------
// Full fixture set
// ---------------------------------------------------------------------------

const INVOICE_LINES = [
  'Rechnung Nr.: 1001',
  'Kunde: Max Mustermann',
  'IBAN: DE89370400440532013000',
  'Gesamt: 44,98 EUR',
];
// Two-column invoice rows: [[x, text], ...] all drawn at the same visual row.
const TWO_COLUMN_ROWS = [
  [
    [40, 'Rechnung Nr. 1001'],
    [1180, 'Datum: 01.02.2026'],
  ],
  [
    [40, 'Kunde: Max Mustermann'],
    [1180, 'IBAN: DE89370400440532013000'],
  ],
  [
    [40, 'Position'],
    [520, 'Menge'],
    [860, 'Preis'],
    [1560, 'Summe'],
  ],
  [
    [40, 'Synthetic item A'],
    [520, '2'],
    [860, '19,99 EUR'],
    [1560, '39,98 EUR'],
  ],
  [
    [40, 'Synthetic item B'],
    [520, '1'],
    [860, '5,00 EUR'],
    [1560, '5,00 EUR'],
  ],
  [[1560, 'Gesamt: 44,98 EUR']],
];

async function renderOfficeFixtures(dir) {
  const result = await runProcess(pythonPathOrThrow(), ['-c', OFFICE_SCRIPT, dir], {
    timeoutMs: timeoutFor('python'),
  });
  if (result.code !== 0 || !/OFFICE_OK/.test(result.stdout)) {
    throw new Error(`office fixture generator failed: ${(result.stderr || result.stdout || '').slice(0, 400)}`);
  }
}

/**
 * Write the complete fixture set into `dir`. Returns the file names written.
 */
export async function generateFixtures(dir) {
  await mkdir(dir, { recursive: true });

  const writes = [];
  const fixture = (name) => path.join(dir, name);

  writes.push(writeFile(fixture('text.pdf'), makeTextPdf(INVOICE_LINES)));
  writes.push(
    writeFile(
      fixture('multipage.pdf'),
      makeTextPdf([
        ['Page one synthetic line'],
        ['Page two synthetic line'],
        ['Page three synthetic line'],
      ]),
    ),
  );
  writes.push(writeFile(fixture('encrypted.pdf'), makeEncryptedPdf(INVOICE_LINES)));
  writes.push(
    writeFile(
      fixture('corrupt.pdf'),
      Buffer.concat([
        Buffer.from('%PDF-1.4\n', 'latin1'),
        Buffer.from('this is not a valid pdf body '.repeat(40), 'latin1'),
      ]),
    ),
  );
  writes.push(
    writeFile(fixture('not-a-document.txt'), Buffer.from('Synthetic notes only.\nNo document here.\n')),
  );
  writes.push(
    writeFile(
      fixture('unsupported.bin'),
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not an OOXML document\n')]),
    ),
  );
  writes.push(
    writeFile(
      fixture('legacy.doc'),
      Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]),
    ),
  );
  await Promise.all(writes);

  // Scan fixtures (image-only, no text layer).
  const scanPages = await renderScanPages([INVOICE_LINES, INVOICE_LINES], 'jpg');
  await writeFile(
    fixture('scanned.pdf'),
    imagePdfBuffer(
      scanPages.map((jpeg) => ({ jpeg, width: SCAN_PAGE_WIDTH, height: scanPageHeight(INVOICE_LINES) })),
    ),
  );
  const blankPages = await renderScanPages([[]], 'jpg');
  await writeFile(
    fixture('blank.pdf'),
    imagePdfBuffer(
      blankPages.map((jpeg) => ({ jpeg, width: SCAN_PAGE_WIDTH, height: scanPageHeight([]) })),
    ),
  );
  const twocolPages = await renderScanPages([TWO_COLUMN_ROWS], 'jpg');
  await writeFile(
    fixture('two-column-invoice.pdf'),
    imagePdfBuffer(
      twocolPages.map((jpeg) => ({ jpeg, width: SCAN_PAGE_WIDTH, height: scanPageHeight(TWO_COLUMN_ROWS) })),
    ),
  );
  const pngPages = await renderScanPages([INVOICE_LINES], 'png');
  await writeFile(fixture('scan-page.png'), pngPages[0]);

  await renderOfficeFixtures(dir);
  await writeFile(fixture('.fixtures-version'), String(FIXTURE_VERSION));
  return readdir(dir);
}

/** Generate fixtures only when the version marker is missing or stale. */
export async function ensureFixtures(dir) {
  const marker = path.join(dir, '.fixtures-version');
  if (existsSync(marker)) {
    try {
      const version = Number.parseInt((await readFile(marker, 'utf8')).trim(), 10);
      if (version === FIXTURE_VERSION) return;
    } catch {
      /* regenerate */
    }
  }
  await generateFixtures(dir);
}

// CLI entry point: node test/make-fixtures.mjs [outDir]
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath && import.meta.url === invokedPath) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const target = process.argv[2] ?? path.join(here, 'fixtures');
  await generateFixtures(target);
  process.stdout.write(`fixtures written to ${target}\n`);
}
