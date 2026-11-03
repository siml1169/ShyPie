#!/usr/bin/env node
// @privacy/local-extract — fail-closed CLI for local document extraction.
//
//   node cli.js --json <pdf|ocr|doc|image|auto> <path> [--max-chars N]
//               [--pages A-B] [--lang deu+eng] [--no-ocr]
//
// Exit 0 + success JSON, exit 3 + block JSON (policy block, no content),
// exit 2 + usage JSON. Never emits raw bytes, never silently succeeds with
// empty text, never uses the network (invariant I1). All subprocesses run
// with timeouts and capped output; temp files are deleted before returning.
//
// `--json` is accepted for contract compatibility; stdout is always one JSON
// object (the contract only defines the JSON form). `--no-ocr` is a documented
// test seam: OCR adapters are skipped entirely (fail-closed branch proof).

import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import {
  REASONS,
  MODES,
  VERSION,
  DEFAULTS,
  allowedRoot,
  isInside,
  readHead,
  sniffHead,
  officeKindFromExtension,
  isLegacyOfficeExtension,
  getPdfInfo,
  extractPdfText,
  pagesFromText,
  renderPdfPages,
  removeTree,
  detectOcrEngines,
  ocrImages,
  ensureOcrSizedImage,
  chooseRenderDpi,
  extractOfficeText,
  parsePageRange,
  rangePageCount,
  requireText,
  block,
} from './engines.js';

const USAGE =
  `usage: node cli.js --json <${MODES.join('|')}> <path> ` +
  '[--max-chars N] [--pages A-B] [--lang deu+eng] [--no-ocr]';

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function parseArgs(argv) {
  const parsed = {
    json: false,
    mode: null,
    file: null,
    maxChars: null,
    pages: null,
    lang: null,
    noOcr: false,
    help: false,
    error: null,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      parsed.json = true;
    } else if (argument === '--no-ocr') {
      parsed.noOcr = true;
    } else if (argument === '--help' || argument === '-h') {
      parsed.help = true;
    } else if (argument === '--max-chars') {
      const value = argv[index + 1];
      index += 1;
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) {
        parsed.error = '--max-chars expects a positive integer';
        return parsed;
      }
      parsed.maxChars = number;
    } else if (argument === '--pages') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) {
        parsed.error = '--pages expects A-B';
        return parsed;
      }
      parsed.pages = value;
    } else if (argument === '--lang') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined) {
        parsed.error = '--lang expects a language spec like deu+eng';
        return parsed;
      }
      parsed.lang = value;
    } else if (argument.startsWith('--')) {
      parsed.error = `unknown option: ${argument}`;
      return parsed;
    } else {
      positional.push(argument);
    }
  }

  if (parsed.help) return parsed;
  if (positional.length !== 2) {
    parsed.error = 'expected exactly one mode and one input path';
    return parsed;
  }
  parsed.mode = positional[0];
  parsed.file = positional[1];
  if (!MODES.includes(parsed.mode)) {
    parsed.error = `unknown mode "${parsed.mode}"; expected one of ${MODES.join(', ')}`;
  }
  return parsed;
}

function usageError(detail) {
  emit({ ok: false, error: 'USAGE', detail, usage: USAGE });
  return 2;
}

function notADocument(sniffed, expected) {
  if (sniffed.kind === 'binary' || sniffed.kind === 'ole') {
    return block(REASONS.UNSUPPORTED_BINARY, `input is a binary file, not a ${expected} document`);
  }
  if (sniffed.kind === 'zip') {
    return block(REASONS.UNSUPPORTED_BINARY, `input is a zip container, not a ${expected} document`);
  }
  return block(REASONS.NOT_A_DOCUMENT, `input is not a ${expected} document`);
}

// ---------------------------------------------------------------------------
// OCR pipelines
// ---------------------------------------------------------------------------

async function ocrDetectedImages(images, { lang, warnings, engines }) {
  const prepared = [];
  const cleanupDirs = [];
  const winrt = engines.find((engine) => engine.name === 'winrt-ocr');
  const maxImageDimension = winrt?.maxImageDimension ?? 10_000;
  try {
    for (const image of images) {
      const sized = await ensureOcrSizedImage(image, { maxImageDimension });
      if (!sized.ok) return sized;
      prepared.push(sized.path);
      if (sized.cleanupDir) cleanupDirs.push(sized.cleanupDir);
      for (const warning of sized.warnings ?? []) {
        if (!warnings.includes(warning)) warnings.push(warning);
      }
    }
    const result = await ocrImages(prepared, { langSpec: lang, engines });
    if (!result.ok) return result;
    return { ok: true, ocr: result, warnings };
  } finally {
    for (const dir of cleanupDirs) await removeTree(dir);
  }
}

async function runPdfOcr(filePath, info, options, warnings, mode) {
  // Bound the work before rendering: a 5000-page scan must not fill the disk.
  const totalPages = info.status === 'ok' && Number.isFinite(info.pages) ? info.pages : null;
  const firstPage = options.pageRange?.first ?? 1;
  const lastPage = options.pageRange?.last ?? totalPages;
  if (lastPage !== null && lastPage - firstPage + 1 > DEFAULTS.maxOcrImages) {
    return block(
      REASONS.OUTPUT_TOO_LARGE,
      `OCR page limit is ${DEFAULTS.maxOcrImages} pages; use --pages to extract a range`,
    );
  }

  const detection = await detectOcrEngines();
  if (!detection.engines.length) {
    return block(REASONS.NO_LOCAL_OCR, detection.detail || 'no local OCR engine available');
  }
  const winrt = detection.engines.find((engine) => engine.name === 'winrt-ocr');
  const maxImageDimension = winrt?.maxImageDimension ?? 10_000;
  const dpi = chooseRenderDpi(info.pageSizePts, maxImageDimension);

  const rendered = await renderPdfPages(filePath, { pageRange: options.pageRange, dpi });
  if (!rendered.ok) return rendered;

  try {
    const combinedWarnings = [...warnings, ...(dpi < 300 ? ['render-dpi-reduced'] : [])];
    const prepared = await ocrDetectedImages(rendered.images, {
      lang: options.lang,
      warnings: combinedWarnings,
      engines: detection.engines,
    });
    if (!prepared.ok) return prepared;
    return {
      ok: true,
      mode,
      engine: prepared.ocr.engineLabel,
      text: prepared.ocr.text,
      pages: prepared.ocr.pages,
      warnings: prepared.warnings,
    };
  } finally {
    await removeTree(rendered.dir);
  }
}

async function runImageOcr(filePath, options, warnings, mode) {
  const detection = await detectOcrEngines();
  if (!detection.engines.length) {
    return block(REASONS.NO_LOCAL_OCR, detection.detail || 'no local OCR engine available');
  }
  const combinedWarnings = [...warnings];
  const prepared = await ocrDetectedImages([filePath], {
    lang: options.lang,
    warnings: combinedWarnings,
    engines: detection.engines,
  });
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    mode,
    engine: prepared.ocr.engineLabel,
    text: prepared.ocr.text,
    pages: prepared.ocr.pages,
    warnings: prepared.warnings,
  };
}

// ---------------------------------------------------------------------------
// PDF pipeline (text layer first, local OCR fallback)
// ---------------------------------------------------------------------------

function pdfPageCount(info, pageRange, extractedText) {
  if (info.status === 'ok' && Number.isFinite(info.pages)) {
    return rangePageCount(pageRange, info.pages);
  }
  return pageRange ? null : pagesFromText(extractedText);
}

async function runPdf(filePath, head, options) {
  const sniffed = sniffHead(head);
  if (sniffed.kind !== 'pdf') return notADocument(sniffed, 'PDF');

  const info = await getPdfInfo(filePath);
  if (info.encrypted === true) {
    return block(REASONS.ENCRYPTED_PDF, 'pdfinfo reports an encrypted or password-protected PDF');
  }

  const extracted = await extractPdfText(filePath, { pageRange: options.pageRange });
  const warnings = [];

  if (extracted.ok) {
    if (extracted.text.trim()) {
      return {
        ok: true,
        mode: 'pdf',
        engine: 'pdftotext',
        text: extracted.text,
        pages: pdfPageCount(info, options.pageRange, extracted.text),
        warnings,
      };
    }
    warnings.push('no-text-layer');
  } else if (extracted.missing) {
    // No pdftotext on PATH: still try the local renderer + OCR.
    warnings.push('pdftotext-unavailable');
  } else {
    return extracted;
  }

  return runPdfOcr(filePath, info, options, warnings, 'pdf');
}

// ---------------------------------------------------------------------------
// OOXML pipeline (bundled python only)
// ---------------------------------------------------------------------------

async function runDocExtract(filePath, kind) {
  const result = await extractOfficeText(filePath, kind);
  if (!result.ok) return result;
  return {
    ok: true,
    mode: 'doc',
    engine: result.engineLabel,
    text: result.text,
    pages: result.pages,
    warnings: result.warnings ?? [],
  };
}

async function runDocMode(filePath, head) {
  const sniffed = sniffHead(head);
  const kind = officeKindFromExtension(filePath);
  if (kind && sniffed.kind === 'zip') return runDocExtract(filePath, kind);
  if (sniffed.kind === 'pdf') return block(REASONS.NOT_A_DOCUMENT, 'PDF is not an OOXML document; use pdf mode');
  if (isLegacyOfficeExtension(filePath) || sniffed.kind === 'ole') {
    return block(REASONS.UNSUPPORTED_BINARY, 'legacy OLE Office binary; convert to docx/xlsx/pptx locally first');
  }
  if (sniffed.kind === 'image') return block(REASONS.NOT_A_DOCUMENT, 'image is not an OOXML document; use image mode');
  if (sniffed.kind === 'text') return block(REASONS.NOT_A_DOCUMENT, 'plain text input is not an OOXML document');
  if (sniffed.kind === 'zip') return block(REASONS.UNSUPPORTED_BINARY, 'zip container is not docx/xlsx/pptx');
  return notADocument(sniffed, 'OOXML');
}

// ---------------------------------------------------------------------------
// Mode dispatch
// ---------------------------------------------------------------------------

async function runOcrMode(filePath, head, options) {
  const sniffed = sniffHead(head);
  if (sniffed.kind === 'pdf') {
    const info = await getPdfInfo(filePath);
    if (info.encrypted === true) {
      return block(REASONS.ENCRYPTED_PDF, 'pdfinfo reports an encrypted or password-protected PDF');
    }
    return runPdfOcr(filePath, info, options, [], 'ocr');
  }
  if (sniffed.kind === 'image') return runImageOcr(filePath, options, [], 'ocr');
  return notADocument(sniffed, 'PDF or image');
}

async function runImageMode(filePath, head, options) {
  const sniffed = sniffHead(head);
  if (sniffed.kind === 'image') return runImageOcr(filePath, options, [], 'image');
  if (sniffed.kind === 'pdf') {
    return block(REASONS.NOT_A_DOCUMENT, 'PDF input requires ocr or pdf mode, not image mode');
  }
  return notADocument(sniffed, 'image');
}

async function runAuto(filePath, head, options) {
  const sniffed = sniffHead(head);
  switch (sniffed.kind) {
    case 'pdf':
      return runPdf(filePath, head, options);
    case 'image':
      return runImageOcr(filePath, options, [], 'image');
    case 'zip': {
      const kind = officeKindFromExtension(filePath);
      if (kind) return runDocExtract(filePath, kind);
      return block(REASONS.UNSUPPORTED_BINARY, 'zip container is not docx/xlsx/pptx (extension cannot identify it)');
    }
    case 'ole':
      return block(REASONS.UNSUPPORTED_BINARY, 'legacy OLE Office binary; convert to docx/xlsx/pptx locally first');
    case 'binary':
      return block(REASONS.UNSUPPORTED_BINARY, 'binary file is not a supported document');
    case 'text':
      return block(REASONS.NOT_A_DOCUMENT, 'plain text input; use text redaction, not document extraction');
    default:
      return block(REASONS.NOT_A_DOCUMENT, 'empty or unreadable input');
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.error) return usageError(args.error);

  const pageRangeResult = parsePageRange(args.pages);
  if (!pageRangeResult.ok) return usageError(pageRangeResult.detail);

  // Documented test seam: skip every OCR adapter (fail-closed branch proof).
  if (args.noOcr) process.env.PRIVACY_EXTRACT_DISABLE_OCR = '1';

  let filePath;
  try {
    filePath = await realpath(args.file);
  } catch {
    return usageError('input path does not exist or is not readable');
  }
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    return usageError('input path cannot be inspected');
  }
  if (!fileInfo.isFile()) return usageError('input path is not a regular file');

  const rootPin = allowedRoot();
  if (rootPin) {
    let rootReal = null;
    try {
      rootReal = await realpath(rootPin);
    } catch {
      rootReal = null;
    }
    if (!rootReal || !isInside(rootReal, filePath)) {
      emit({
        ok: false,
        blocked: true,
        reason: REASONS.PATH_NOT_ALLOWED,
        detail: 'input path is outside PRIVACY_EXTRACT_ALLOWED_ROOT',
      });
      return 3;
    }
  }

  const options = { pageRange: pageRangeResult.range, lang: args.lang };
  let head;
  try {
    head = await readHead(filePath);
  } catch {
    emit({ ok: false, blocked: true, reason: REASONS.NOT_A_DOCUMENT, detail: 'cannot read input header' });
    return 3;
  }

  let result;
  try {
    if (args.mode === 'pdf') result = await runPdf(filePath, head, options);
    else if (args.mode === 'ocr') result = await runOcrMode(filePath, head, options);
    else if (args.mode === 'doc') result = await runDocMode(filePath, head);
    else if (args.mode === 'image') result = await runImageMode(filePath, head, options);
    else result = await runAuto(filePath, head, options);
  } catch {
    // Fail closed: an unexpected failure must never produce content.
    emit({ ok: false, blocked: true, reason: REASONS.PARSE_FAILED, detail: 'internal extraction error' });
    return 3;
  }

  if (!result.ok) {
    emit({ ok: false, blocked: true, reason: result.reason, detail: result.detail });
    return 3;
  }

  const checked = requireText(result.text);
  if (!checked.ok) {
    emit({ ok: false, blocked: true, reason: checked.reason, detail: checked.detail });
    return 3;
  }

  let text = checked.text;
  const warnings = [...(result.warnings ?? [])];
  if (args.maxChars && text.length > args.maxChars) {
    text = text.slice(0, args.maxChars);
    warnings.push('truncated');
  }

  emit({
    ok: true,
    mode: result.mode,
    engine: result.engine,
    text,
    pages: result.pages,
    chars: text.length,
    warnings,
    elapsedMs: Date.now() - started,
  });
  return 0;
}

// Only run when executed directly (tests import parseArgs without side effects).
const invokedDirectly =
  process.argv[1] !== undefined &&
  /(^|[\\/])cli\.js$/i.test(path.resolve(process.argv[1]));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}

export { main };
