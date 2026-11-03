// Manual measurement harness for docs/research/local-extract-env.md.
//
// Not part of `npm test`. Run with the bundled node:
//   node test/measure-engines.mjs
//
// It prints a reproducible matrix (command -> output/exit code, timing) for the
// local extraction engines on THIS machine: poppler tools, tesseract presence,
// the WinRT OCR adapter, the bundled python libs, OCR reading order, temp-file
// cleanup and the absence of network APIs in this package.

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PKG_DIR,
  detectOcrEngines,
  parseImageDimensions,
  probeTesseract,
  probeWinrtOcr,
  renderPdfPages,
  removeTree,
  reconstructReadingOrder,
  resolvePythonPath,
  runProcess,
  readHead,
} from '../engines.js';
import { ensureFixtures, makeScanPdf } from './make-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

function line(label, value) {
  process.stdout.write(`- ${label}: ${value}\n`);
}

async function version(output) {
  const result = await runProcess(output.command, output.args, { timeoutMs: 20_000 });
  const first = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() ?? '';
  return `exit=${result.code} output=${JSON.stringify(first)}`;
}

const NETWORK_PATTERN =
  /fetch\s*\(|from ['"]node:(http|https|net|dns|tls)['"]|require\(['"]node:(http|https|net|dns|tls)['"]\)|Invoke-WebRequest|Invoke-RestMethod|urllib\.request|requests\.(get|post)/;

async function networkAudit() {
  const offenders = [];
  const roots = [
    path.join(PKG_DIR, 'cli.js'),
    path.join(PKG_DIR, 'engines.js'),
    path.join(PKG_DIR, 'ps', 'winrt-ocr.ps1'),
    path.join(PKG_DIR, 'py', 'extract_office.py'),
  ];
  for (const file of roots) {
    const content = await readFile(file, 'utf8');
    if (NETWORK_PATTERN.test(content)) offenders.push(path.basename(file));
  }
  return offenders.length === 0 ? 'no network API found in cli.js/engines.js/ps/py' : `NETWORK API IN: ${offenders.join(', ')}`;
}

async function leftoverTempDirs() {
  const names = await readdir(os.tmpdir());
  return names.filter((name) => name.startsWith('privacy-extract-') || name.startsWith('privacy-fixtures-'));
}

async function main() {
  await ensureFixtures(FIXTURES);
  process.stdout.write('# Measured on this machine\n\n');
  line('node', process.version);
  line('python', (await version({ command: resolvePythonPath(), args: ['--version'] })));
  line('pdftotext', await version({ command: 'pdftotext', args: ['-v'] }));
  line('pdftoppm', await version({ command: 'pdftoppm', args: ['-v'] }));
  line('pdfinfo', await version({ command: 'pdfinfo', args: ['-v'] }));
  line('tesseract', JSON.stringify(await probeTesseract()));
  const winrt = await probeWinrtOcr();
  line('winrt probe', JSON.stringify(winrt));
  line('detectOcrEngines', JSON.stringify((await detectOcrEngines()).engines));

  const pythonLibs = [
    'import PIL, numpy, docx, pptx, openpyxl',
    'print("PIL", PIL.__version__, "numpy", numpy.__version__, "openpyxl", openpyxl.__version__)',
    'for m in ("pytesseract", "easyocr", "paddleocr"):',
    '    try:',
    '        __import__(m); print(m, "PRESENT")',
    '    except Exception:',
    '        print(m, "ABSENT")',
  ].join('\n');
  const libs = await runProcess(resolvePythonPath(), ['-c', pythonLibs], { timeoutMs: 60_000 });
  line('python libs', JSON.stringify(libs.stdout.trim().split('\n')));

  // PDF text layer vs image-only.
  const textPdf = path.join(FIXTURES, 'text.pdf');
  const scannedPdf = path.join(FIXTURES, 'scanned.pdf');
  const textExtract = await runProcess('pdftotext', ['-layout', '-enc', 'UTF-8', '-q', textPdf, '-'], {
    timeoutMs: 20_000,
  });
  line('pdftotext text.pdf', `exit=${textExtract.code} chars=${textExtract.stdout.length}`);
  const scanExtract = await runProcess('pdftotext', ['-layout', '-enc', 'UTF-8', '-q', scannedPdf, '-'], {
    timeoutMs: 20_000,
  });
  line(
    'pdftotext scanned.pdf',
    `exit=${scanExtract.code} raw=${JSON.stringify(scanExtract.stdout)} (whitespace only = no text layer)`,
  );
  const corrupt = await runProcess('pdftotext', ['-layout', '-enc', 'UTF-8', '-q', path.join(FIXTURES, 'corrupt.pdf'), '-'], {
    timeoutMs: 20_000,
  });
  line('pdftotext corrupt.pdf', `exit=${corrupt.code} stderr=${JSON.stringify(corrupt.stderr.slice(0, 80))}`);
  const encrypted = await runProcess('pdfinfo', [path.join(FIXTURES, 'encrypted.pdf')], { timeoutMs: 20_000 });
  line('pdfinfo encrypted.pdf', `exit=${encrypted.code} stderr=${JSON.stringify(encrypted.stderr.slice(0, 80))}`);

  // 300 dpi render.
  const renderStarted = Date.now();
  const rendered = await renderPdfPages(scannedPdf);
  const renderMs = Date.now() - renderStarted;
  if (!rendered.ok) {
    line('pdftoppm render', JSON.stringify(rendered));
    return;
  }
  const dims = [];
  for (const image of rendered.images) {
    dims.push(JSON.stringify(parseImageDimensions(await readHead(image))));
  }
  line('pdftoppm scanned.pdf 2 pages', `elapsedMs=${renderMs} images=${rendered.images.length} dims=${dims.join(',')}`);
  const leftoverAfterRender = await leftoverTempDirs();
  line('temp dirs during render', JSON.stringify(leftoverAfterRender));

  // WinRT OCR on the rendered pages, plus native vs reconstructed reading order.
  async function runWinrt(images, outDir) {
    const started = Date.now();
    const result = await runProcess(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(PKG_DIR, 'ps', 'winrt-ocr.ps1'),
        '-OutDir',
        outDir,
        '-Images',
        images.join('|'),
        '-LangTag',
        'en-US',
      ],
      { timeoutMs: 240_000 },
    );
    return { result, elapsedMs: Date.now() - started };
  }

  const ocr = await runWinrt(rendered.images, rendered.dir);
  line(
    'winrt-ocr 2 pages',
    `exit=${ocr.result.code} elapsedMs=${ocr.elapsedMs} marker=${JSON.stringify(ocr.result.stdout.trim().split('\n').pop())}`,
  );

  const boxedLines = JSON.parse(await readFile(path.join(rendered.dir, 'page-1.json'), 'utf8')).lines;
  line('winrt native line order (page 1)', JSON.stringify(boxedLines.map((entry) => entry.text)));
  line('reconstructed row order (page 1)', JSON.stringify(reconstructReadingOrder(boxedLines)));

  // Two-column invoice: prove the native order is layout-grouped and that the
  // coordinate reconstruction restores row-major order.
  const columnsRender = await renderPdfPages(path.join(FIXTURES, 'two-column-invoice.pdf'));
  if (columnsRender.ok) {
    const columnOcr = await runWinrt([columnsRender.images[0]], columnsRender.dir);
    const columnLines = JSON.parse(
      await readFile(path.join(columnsRender.dir, 'page-1.json'), 'utf8'),
    ).lines;
    line(
      'winrt two-column elapsedMs',
      `${columnOcr.elapsedMs} exit=${columnOcr.result.code}`,
    );
    line('winrt two-column native order', JSON.stringify(columnLines.map((entry) => entry.text)));
    line('winrt two-column reconstructed order', JSON.stringify(reconstructReadingOrder(columnLines)));
    await removeTree(columnsRender.dir);
  }

  await removeTree(rendered.dir);
  line('temp dirs after cleanup', JSON.stringify(await leftoverTempDirs()));
  line('network audit', await networkAudit());
  line('scan fixture generator', `deterministic JPEG size=${(await makeScanPdf(['x'])).length} bytes`);
}

await main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
