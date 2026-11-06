// @shypie_privacy/local-extract — local-only extraction primitives.
//
// Zero npm dependencies. No network I/O of any kind (invariant I1). Every external
// process is spawned with a timeout and a bounded output capture. Nothing here ever
// returns raw bytes to a caller: extraction results are text only, or a structured
// block. Temporary files (rendered page images, office scratch) are always deleted
// in a `finally` block so plaintext PII does not linger on disk.
//
// Calls out only to binaries that are already installed locally:
//   pdftotext / pdftoppm / pdfinfo   (poppler, on PATH)
//   powershell.exe                   (WinRT Windows.Media.Ocr adapter)
//   tesseract                        (optional; absent on this machine)
//   bundled python                   (docx/xlsx/pptx only)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.3.0';

export const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Exact blocked-reason strings from docs/interface-contract.md. Never invent others. */
export const REASONS = Object.freeze({
  NO_LOCAL_OCR: 'NO_LOCAL_OCR',
  NO_LOCAL_RENDERER: 'NO_LOCAL_RENDERER',
  NOT_A_DOCUMENT: 'NOT_A_DOCUMENT',
  UNSUPPORTED_BINARY: 'UNSUPPORTED_BINARY',
  ENCRYPTED_PDF: 'ENCRYPTED_PDF',
  PARSE_FAILED: 'PARSE_FAILED',
  OUTPUT_TOO_LARGE: 'OUTPUT_TOO_LARGE',
  TIMEOUT: 'TIMEOUT',
  // Amended during review: a path outside the optional `PRIVACY_EXTRACT_ALLOWED_ROOT`
  // pin is a policy block (exit 3), not a usage error. Exit 2 stays usage-only.
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
});

export const MODES = Object.freeze(['pdf', 'ocr', 'doc', 'image', 'auto']);

export const DEFAULTS = Object.freeze({
  timeouts: Object.freeze({
    pdfinfo: 20_000,
    pdftotext: 30_000,
    pdftoppm: 180_000,
    ocr: 240_000,
    python: 90_000,
    probe: 20_000,
  }),
  // Hard cap on captured subprocess output / extracted text. Exceeding it is a
  // policy block (OUTPUT_TOO_LARGE), not silent truncation.
  maxOutputBytes: 4 * 1024 * 1024,
  // 300 dpi is the usual sweet spot for both tesseract and WinRT OCR.
  renderDpi: 300,
  maxOcrImages: 500,
});

// ---------------------------------------------------------------------------
// Environment seams. Production never sets these; tests do (documented in
// docs/research/local-extract-env.md). They only narrow behaviour, never widen it.
// ---------------------------------------------------------------------------

export function envFlag(name) {
  const value = process.env[name];
  if (!value) return false;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function maxOutputBytes() {
  return envInt('PRIVACY_EXTRACT_MAX_OUTPUT_BYTES', DEFAULTS.maxOutputBytes);
}

export function timeoutFor(step) {
  return envInt('PRIVACY_EXTRACT_TIMEOUT_MS', DEFAULTS.timeouts[step] ?? 30_000);
}

/** True when the caller (Gate 2) pinned an allowed root. Unset = no path policy. */
export function allowedRoot() {
  const root = process.env.PRIVACY_EXTRACT_ALLOWED_ROOT;
  return root && root.trim() ? root.trim() : null;
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

/**
 * Spawn one local process. Resolves (never rejects) with:
 *   { code, signal, stdout, stderr, timedOut, overflow, spawnError }
 * stdout/stderr are UTF-8 strings. `spawnError` is the original Error for ENOENT etc.
 * On timeout the child is killed; on stdout overflow the child is killed too.
 */
export function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cap = options.maxBytes ?? maxOutputBytes();
  const { cwd, env } = options;

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const kill = () => {
      try {
        if (child && child.exitCode === null && !child.killed) child.kill();
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1, timeoutMs));

    try {
      child = spawn(command, args, {
        windowsHide: true,
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      clearTimeout(timer);
      settle({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, overflow: false, spawnError });
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > cap) {
        overflow = true;
        kill();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > cap) {
        // stderr is diagnostic only: drop the excess instead of blocking on it.
        stderrBytes = cap;
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (spawnError) => {
      clearTimeout(timer);
      settle({
        code: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        overflow,
        spawnError,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      settle({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        overflow,
        spawnError: null,
      });
    });
  });
}

export function isMissingBinary(result) {
  return Boolean(result?.spawnError && (result.spawnError.code === 'ENOENT' || result.spawnError.code === 'EACCES'));
}

/** Map a failed runProcess result to a frozen block reason. */
export function blockForRun(result, detailPrefix = '') {
  if (result.timedOut) {
    return { ok: false, blocked: true, reason: REASONS.TIMEOUT, detail: `${detailPrefix}timed out` };
  }
  if (result.overflow) {
    return {
      ok: false,
      blocked: true,
      reason: REASONS.OUTPUT_TOO_LARGE,
      detail: `${detailPrefix}output exceeded the configured cap`,
    };
  }
  if (result.spawnError) {
    return {
      ok: false,
      blocked: true,
      reason: REASONS.PARSE_FAILED,
      detail: `${detailPrefix}cannot run local tool (${result.spawnError.code ?? 'spawn error'})`,
    };
  }
  return {
    ok: false,
    blocked: true,
    reason: REASONS.PARSE_FAILED,
    detail: `${detailPrefix}local tool exited with code ${result.code}`,
  };
}

export function block(reason, detail) {
  return { ok: false, blocked: true, reason, detail };
}

// ---------------------------------------------------------------------------
// Paths, python resolution, file head reading
// ---------------------------------------------------------------------------

export function resolvePythonPath() {
  const candidates = [
    process.env.PRIVACY_EXTRACT_PYTHON,
    process.env.DSH_BUNDLED_PYTHON,
    path.join(
      os.homedir(),
      '.dsh',
      'dsh-runtimes',
      'dsh-primary-runtime',
      'dependencies',
      'python',
      'python.exe',
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return 'python';
}

export async function readHead(filePath, bytes = 1024) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function isInside(rootReal, fileReal) {
  const relative = path.relative(rootReal, fileReal);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------------------
// Content sniffing (magic bytes only — never a byte dump)
// ---------------------------------------------------------------------------

const IMAGE_MAGIC = [
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { format: 'tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { format: 'bmp', bytes: [0x42, 0x4d] },
];

function startsWithBytes(head, bytes) {
  if (head.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (head[i] !== bytes[i]) return false;
  return true;
}

function looksLikeText(head) {
  const text = head.toString('utf8');
  if (text.includes('\uFFFD')) return false;
  let controls = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) controls += 1;
  }
  return controls / Math.max(1, text.length) < 0.02;
}

/**
 * Classify a file from its first kilobyte. Returns
 * { kind: 'pdf'|'image'|'zip'|'ole'|'binary'|'text'|'empty', format? }.
 * Magic only; no content is ever copied into the result.
 */
export function sniffHead(head) {
  if (!head || head.length === 0) return { kind: 'empty' };
  const ascii = head.toString('latin1');
  const pdfIndex = ascii.indexOf('%PDF-');
  if (pdfIndex >= 0) return { kind: 'pdf' };

  for (const entry of IMAGE_MAGIC) if (startsWithBytes(head, entry.bytes)) return { kind: 'image', format: entry.format };
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return { kind: 'image', format: 'gif' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { kind: 'image', format: 'webp' };

  if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(head, [0x50, 0x4b, 0x05, 0x06])) {
    return { kind: 'zip' };
  }
  if (startsWithBytes(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: 'ole' };
  if (
    startsWithBytes(head, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWithBytes(head, [0x4d, 0x5a]) || // MZ / PE
    startsWithBytes(head, [0x52, 0x61, 0x72, 0x21]) || // RAR
    startsWithBytes(head, [0x1f, 0x8b]) || // gzip
    startsWithBytes(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) // 7z
  ) {
    return { kind: 'binary' };
  }
  return looksLikeText(head) ? { kind: 'text' } : { kind: 'binary' };
}

const OFFICE_BY_EXTENSION = new Map([
  ['.docx', 'docx'],
  ['.docm', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.xlsm', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.pptm', 'pptx'],
]);

const LEGACY_OFFICE_BY_EXTENSION = new Set(['.doc', '.xls', '.ppt', '.msg', '.vsd']);

export function officeKindFromExtension(filePath) {
  return OFFICE_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? null;
}

export function isLegacyOfficeExtension(filePath) {
  return LEGACY_OFFICE_BY_EXTENSION.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// PDF info, encryption detection, text extraction, rendering
// ---------------------------------------------------------------------------

/**
 * Run `pdfinfo`. Returns { status: 'ok'|'missing'|'failed'|'timeout'|'overflow',
 * pages?, encrypted?, stdout? }. Never throws.
 */
export async function getPdfInfo(filePath) {
  const result = await runProcess('pdfinfo', [filePath], { timeoutMs: timeoutFor('pdfinfo') });
  if (isMissingBinary(result)) return { status: 'missing' };
  if (result.timedOut) return { status: 'timeout' };
  if (result.overflow) return { status: 'overflow' };
  if (result.code !== 0) {
    // An encrypted PDF with an unusable/empty password makes pdfinfo exit
    // non-zero with "Incorrect password" instead of printing "Encrypted: yes".
    // Never echo stderr (it can contain a path): classify only.
    const encryptedHint = /incorrect password|password|encrypted/i.test(result.stderr);
    return { status: 'failed', code: result.code, encrypted: encryptedHint ? true : null };
  }
  const pagesMatch = /^Pages:\s+(\d+)/m.exec(result.stdout);
  const encryptedMatch = /^Encrypted:\s+(yes|no)/im.exec(result.stdout);
  const sizeMatch = /^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m.exec(result.stdout);
  return {
    status: 'ok',
    pages: pagesMatch ? Number.parseInt(pagesMatch[1], 10) : null,
    encrypted: encryptedMatch ? encryptedMatch[1].toLowerCase() === 'yes' : null,
    pageSizePts: sizeMatch
      ? { width: Number.parseFloat(sizeMatch[1]), height: Number.parseFloat(sizeMatch[2]) }
      : null,
    stdout: result.stdout,
  };
}

/** True/unknown encryption state. `null` means pdfinfo could not tell us. */
export async function pdfIsEncrypted(filePath) {
  const info = await getPdfInfo(filePath);
  if (info.encrypted === true) return true;
  if (info.status !== 'ok') return null;
  return info.encrypted;
}

const ENCRYPTION_STDERR = /incorrect password|encrypted|password|security handler/i;

/**
 * Run `pdftotext -layout -enc UTF-8 -q <file> -` (text to stdout, no temp file
 * holding plaintext). Returns { ok:true, text, pagesHint } or a block.
 */
export async function extractPdfText(filePath, { pageRange } = {}) {
  const args = ['-layout', '-enc', 'UTF-8', '-q'];
  if (pageRange) {
    args.push('-f', String(pageRange.first), '-l', String(pageRange.last));
  }
  args.push(filePath, '-');

  const result = await runProcess('pdftotext', args, { timeoutMs: timeoutFor('pdftotext') });

  if (isMissingBinary(result)) {
    // No text extractor: the caller may still be able to OCR the pages, so this
    // is not immediately a block. If OCR is unavailable too, the caller blocks
    // with NO_LOCAL_OCR.
    return { ok: false, missing: true };
  }
  if (result.timedOut) {
    return block(REASONS.TIMEOUT, `pdftotext timed out after ${timeoutFor('pdftotext')} ms`);
  }
  if (result.overflow) {
    return block(REASONS.OUTPUT_TOO_LARGE, 'pdftotext output exceeded the configured cap');
  }
  if (result.code !== 0) {
    if (ENCRYPTION_STDERR.test(result.stderr)) {
      return block(REASONS.ENCRYPTED_PDF, 'pdftotext reports an encrypted or password-protected PDF');
    }
    return block(REASONS.PARSE_FAILED, `pdftotext exited with code ${result.code}`);
  }

  const text = normalizeText(result.stdout);
  const formFeeds = text.split('\f').length;
  return { ok: true, text, pageBreaks: formFeeds };
}

function normalizeText(text) {
  // Keeps form feed (0x0c): pdftotext uses it as the page separator and
  // pagesFromText() counts pages from it.
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '');
}

/** Count pages in extracted pdftotext output (form feeds delimit pages). */
export function pagesFromText(text) {
  const trimmed = String(text ?? '').replace(/\s+$/, '');
  if (!trimmed) return 0;
  return trimmed.split('\f').length;
}

/**
 * Render PDF pages to PNGs in a private temp dir with `pdftoppm`.
 * Caller MUST delete `dir` (always in a finally block) — pages can contain PII.
 */
export async function renderPdfPages(filePath, { pageRange, dpi = DEFAULTS.renderDpi } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'privacy-extract-render-'));
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  if (envFlag('PRIVACY_EXTRACT_DISABLE_RENDERER')) {
    await cleanup();
    return block(REASONS.NO_LOCAL_RENDERER, 'PDF renderer disabled by PRIVACY_EXTRACT_DISABLE_RENDERER');
  }
  const args = ['-r', String(dpi), '-png'];
  if (pageRange) args.push('-f', String(pageRange.first), '-l', String(pageRange.last));
  args.push(filePath, path.join(dir, 'page'));

  const result = await runProcess('pdftoppm', args, { timeoutMs: timeoutFor('pdftoppm') });

  if (isMissingBinary(result)) {
    await cleanup();
    return block(REASONS.NO_LOCAL_RENDERER, 'pdftoppm not found on PATH (no local PDF renderer)');
  }
  if (result.timedOut) {
    await cleanup();
    return block(REASONS.TIMEOUT, `pdftoppm timed out after ${timeoutFor('pdftoppm')} ms`);
  }
  if (result.overflow) {
    await cleanup();
    return block(REASONS.OUTPUT_TOO_LARGE, 'pdftoppm produced too much output');
  }
  if (result.code !== 0) {
    await cleanup();
    return block(REASONS.PARSE_FAILED, `pdftoppm exited with code ${result.code}`);
  }

  const names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.png'));
  if (names.length === 0) {
    await cleanup();
    return block(REASONS.PARSE_FAILED, 'pdftoppm rendered no pages');
  }
  names.sort((a, b) => {
    const left = Number.parseInt(/(\d+)(?=\.png$)/.exec(a)?.[1] ?? '0', 10);
    const right = Number.parseInt(/(\d+)(?=\.png$)/.exec(b)?.[1] ?? '0', 10);
    return left - right;
  });
  return { ok: true, dir, images: names.map((name) => path.join(dir, name)) };
}

export async function removeTree(dir) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// OCR adapter discovery and execution
// ---------------------------------------------------------------------------

const PS_OCR_SCRIPT = path.join(PKG_DIR, 'ps', 'winrt-ocr.ps1');

/** Map tesseract-style language codes to BCP-47 tags WinRT understands. */
const WINRT_LANG_MAP = new Map([
  ['eng', 'en-US'],
  ['en', 'en-US'],
  ['en-us', 'en-US'],
  ['en-gb', 'en-GB'],
  ['deu', 'de-DE'],
  ['ger', 'de-DE'],
  ['de', 'de-DE'],
  ['de-de', 'de-DE'],
  ['fra', 'fr-FR'],
  ['fre', 'fr-FR'],
  ['fr', 'fr-FR'],
  ['spa', 'es-ES'],
  ['es', 'es-ES'],
  ['ita', 'it-IT'],
  ['it', 'it-IT'],
  ['nld', 'nl-NL'],
  ['dut', 'nl-NL'],
  ['nl', 'nl-NL'],
  ['pol', 'pl-PL'],
  ['pl', 'pl-PL'],
  ['por', 'pt-PT'],
  ['pt', 'pt-PT'],
  ['rus', 'ru-RU'],
  ['ru', 'ru-RU'],
  ['tur', 'tr-TR'],
  ['tr', 'tr-TR'],
  ['chi_sim', 'zh-Hans-CN'],
  ['zh', 'zh-Hans-CN'],
  ['zh-hans', 'zh-Hans-CN'],
  ['chi_tra', 'zh-Hant-TW'],
  ['zh-hant', 'zh-Hant-TW'],
  ['jpn', 'ja-JP'],
  ['ja', 'ja-JP'],
  ['kor', 'ko-KR'],
  ['ko', 'ko-KR'],
  ['ara', 'ar-SA'],
  ['ar', 'ar-SA'],
]);

const LANG_SPEC_SAFE = /^[A-Za-z_+-]{1,64}$/;

export function parseLangSpec(spec) {
  if (!spec) return [];
  if (!LANG_SPEC_SAFE.test(spec)) return [];
  return spec
    .split(/[+,]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Pick a WinRT recognizer language. Returns { tag, warnings }.
 * `available` is the list of RecognizerLanguage tags reported by the probe.
 */
export function pickWinrtLanguage(langSpec, available = []) {
  const availableLower = new Map(available.map((tag) => [tag.toLowerCase(), tag]));
  const requested = parseLangSpec(langSpec);
  const warnings = [];
  for (const code of requested) {
    const tag = WINRT_LANG_MAP.get(code);
    if (!tag) {
      warnings.push(`lang-unmapped:${code}`);
      continue;
    }
    if (availableLower.has(tag.toLowerCase())) return { tag: availableLower.get(tag.toLowerCase()), warnings };
    warnings.push(`lang-unavailable:${tag}`);
  }
  if (availableLower.has('en-us')) return { tag: availableLower.get('en-us'), warnings };
  const first = available[0] ?? null;
  if (first) warnings.push('lang-fallback-profile');
  return { tag: first, warnings };
}

let winrtProbeCache = null;

/** Probe the WinRT OCR adapter once per process. Never throws. */
export async function probeWinrtOcr({ force = false } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, detail: 'not running on Windows' };
  }
  if (winrtProbeCache && !force) return winrtProbeCache;

  const result = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_OCR_SCRIPT, '-Probe'],
    { timeoutMs: timeoutFor('probe') },
  );

  if (isMissingBinary(result) || result.spawnError) {
    winrtProbeCache = { ok: false, detail: 'powershell.exe unavailable' };
    return winrtProbeCache;
  }
  if (result.timedOut) {
    winrtProbeCache = { ok: false, detail: 'WinRT OCR probe timed out' };
    return winrtProbeCache;
  }
  if (result.code !== 0) {
    const line = /WINRT_PROBE_FAIL[^\n]*/i.exec(result.stdout + result.stderr)?.[0];
    winrtProbeCache = { ok: false, detail: line ? line.trim().slice(0, 200) : `probe exited ${result.code}` };
    return winrtProbeCache;
  }
  const okLine = /WINRT_PROBE_OK\s+langs=([^\s]*)\s*(?:maxdim=(\d+))?/i.exec(result.stdout);
  if (!okLine) {
    winrtProbeCache = { ok: false, detail: 'probe produced no recognizer languages' };
    return winrtProbeCache;
  }
  const languages = okLine[1].split(',').map((tag) => tag.trim()).filter(Boolean);
  if (languages.length === 0) {
    winrtProbeCache = { ok: false, detail: 'no Windows OCR language pack installed' };
    return winrtProbeCache;
  }
  const maxImageDimension = okLine[2] ? Number.parseInt(okLine[2], 10) : 10_000;
  winrtProbeCache = { ok: true, languages, maxImageDimension };
  return winrtProbeCache;
}

export async function probeTesseract() {
  const result = await runProcess('tesseract', ['--version'], { timeoutMs: timeoutFor('probe') });
  if (isMissingBinary(result) || result.spawnError) return { ok: false, detail: 'tesseract not on PATH' };
  if (result.timedOut) return { ok: false, detail: 'tesseract probe timed out' };
  if (result.code !== 0) return { ok: false, detail: `tesseract exited ${result.code}` };
  const firstLine = (result.stdout || result.stderr).split(/\r?\n/)[0]?.trim() ?? '';
  return { ok: true, version: firstLine.slice(0, 120) };
}

/**
 * Discover local OCR engines, in preference order:
 *   1. tesseract (if installed)  2. Windows WinRT OCR (powershell.exe)
 * Python easyocr/paddleocr are not installed in the bundled interpreter and are
 * intentionally not probed at runtime (a probe would cost seconds per call).
 */
export async function detectOcrEngines() {
  if (envFlag('PRIVACY_EXTRACT_DISABLE_OCR')) {
    return { engines: [], detail: 'OCR disabled by PRIVACY_EXTRACT_DISABLE_OCR' };
  }
  const engines = [];
  const notes = [];
  const tesseract = await probeTesseract();
  if (tesseract.ok) engines.push({ name: 'tesseract', version: tesseract.version });
  else notes.push(tesseract.detail);

  const winrt = await probeWinrtOcr();
  if (winrt.ok) {
    engines.push({ name: 'winrt-ocr', languages: winrt.languages, maxImageDimension: winrt.maxImageDimension });
  } else notes.push(`winrt-ocr: ${winrt.detail}`);

  if (!engines.length) notes.push('install tesseract or a Windows OCR language pack to enable OCR');
  return { engines, detail: notes.join('; ') };
}

async function ocrWithTesseract(images, langSpec) {
  const warnings = [];
  let lang = 'eng';
  const requested = parseLangSpec(langSpec);
  if (requested.length) lang = requested.join('+');
  const texts = [];
  for (const image of images) {
    const args = [image, 'stdout', '-l', lang, '--psm', '3'];
    let result = await runProcess('tesseract', args, { timeoutMs: timeoutFor('ocr') });
    if (result.code !== 0 && /failed loading language|couldn't load any languages/i.test(result.stderr)) {
      warnings.push(`lang-unavailable:${lang}`);
      result = await runProcess('tesseract', [image, 'stdout', '-l', 'eng', '--psm', '3'], {
        timeoutMs: timeoutFor('ocr'),
      });
    }
    if (result.timedOut) return { ok: false, detail: 'tesseract timed out' };
    if (result.overflow) return { ok: false, detail: 'tesseract output exceeded the cap' };
    if (result.spawnError) return { ok: false, detail: 'tesseract could not be started' };
    if (result.code !== 0) return { ok: false, detail: `tesseract exited ${result.code}` };
    texts.push(normalizeText(result.stdout));
  }
  return {
    ok: true,
    text: texts.join('\n\n'),
    engineLabel: 'tesseract',
    warnings,
  };
}

// ---------------------------------------------------------------------------
// OCR reading order
// ---------------------------------------------------------------------------

/**
 * Rebuild a human reading order from WinRT OCR line boxes.
 *
 * Why this exists: Windows.Media.Ocr returns OcrResult.Lines grouped by layout
 * block, not in visual row order. Measured on a synthetic 2-column invoice, the
 * native order came back column-major ("Rechnung Nr. 1001", "Kunde: ...",
 * "Position", items..., "Menge", ...) which breaks key:value pairing. Grouping
 * lines whose vertical centres overlap and sorting each row left-to-right
 * recovers row-major order (measured: "Rechnung Nr. 1001 | Datum: 01.02.2026").
 *
 * Pure function, no I/O. Returns "" for no lines.
 */
export function reconstructReadingOrder(lines) {
  const items = (lines ?? [])
    .filter((line) => line && typeof line.text === 'string' && line.text.trim())
    .map((line) => ({
      text: line.text.trim(),
      x: Number(line.x) || 0,
      y: Number(line.y) || 0,
      h: Number(line.h) || 0,
    }));
  if (items.length === 0) return '';

  const heights = items.map((item) => item.h).filter((height) => height > 0).sort((a, b) => a - b);
  const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 10;
  const tolerance = Math.max(4, medianHeight * 0.5);

  const rows = [];
  for (const item of items) {
    const center = item.y + item.h / 2;
    let row = rows.find((candidate) => Math.abs(candidate.center - center) <= tolerance);
    if (!row) {
      row = { center, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  rows.sort((a, b) => a.center - b.center);
  return rows
    .map((row) => {
      row.items.sort((a, b) => a.x - b.x);
      return row.items.map((item) => item.text).join(' | ');
    })
    .join('\n');
}

/** Join per-page OCR texts, preserving page boundaries. */
export function joinOcrPages(pageTexts) {
  return (pageTexts ?? [])
    .map((text) => String(text ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Image sizing (avoid WinRT's MaxImageDimension limit without losing text)
// ---------------------------------------------------------------------------

/** Best-effort image dimensions from a file header. Returns { width, height } or null. */
export function parseImageDimensions(head) {
  if (!head || head.length < 24) return null;
  // PNG: IHDR width/height at offsets 16..23 (big-endian).
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && head.length >= 24) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  // BMP: 40-byte info header, width/height little-endian at offsets 18/22.
  if (startsWithBytes(head, [0x42, 0x4d]) && head.length >= 26) {
    return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) };
  }
  // GIF: logical screen width/height at offsets 6/8 (little-endian).
  if ((head.toString('latin1').startsWith('GIF87a') || head.toString('latin1').startsWith('GIF89a')) && head.length >= 10) {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  // JPEG: walk segments until a SOFn marker carries height/width.
  if (startsWithBytes(head, [0xff, 0xd8, 0xff])) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = head[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = head.readUInt16BE(offset + 2);
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { width: head.readUInt16BE(offset + 7), height: head.readUInt16BE(offset + 5) };
      }
      if (segmentLength < 2) return null;
      offset += 2 + segmentLength;
    }
    return null;
  }
  return null;
}

/**
 * Choose a render DPI so a page fits the OCR engine's max bitmap dimension.
 * `pageSizePts` is from pdfinfo (1 pt = 1/72 inch). Falls back to the preferred
 * DPI when the size is unknown.
 */
export function chooseRenderDpi(pageSizePts, maxImageDimension, preferredDpi = DEFAULTS.renderDpi) {
  if (!pageSizePts || !maxImageDimension) return preferredDpi;
  const longestPt = Math.max(pageSizePts.width, pageSizePts.height);
  if (!Number.isFinite(longestPt) || longestPt <= 0) return preferredDpi;
  // Leave ~5% headroom below the hard bitmap limit.
  const limit = maxImageDimension * 0.95;
  const dpiThatFits = Math.floor((limit * 72) / longestPt);
  return Math.max(72, Math.min(preferredDpi, dpiThatFits));
}

const DOWNSCALE_SCRIPT = [
  'import sys',
  'from PIL import Image',
  'src, dst, maxdim = sys.argv[1], sys.argv[2], int(sys.argv[3])',
  'img = Image.open(src)',
  'img.thumbnail((maxdim, maxdim), Image.LANCZOS)',
  'if img.mode not in ("RGB", "L"):',
  '    img = img.convert("RGB")',
  'img.save(dst, "PNG")',
  'print("OK")',
].join('\n');

/**
 * Make sure an image fits the OCR engine's max dimension by downscaling it
 * locally with Pillow (bundled python). Returns { ok, path, cleanupDir?, warnings }
 * or a block. The caller must call removeTree(cleanupDir) when present.
 */
export async function ensureOcrSizedImage(imagePath, { maxImageDimension } = {}) {
  if (!maxImageDimension) return { ok: true, path: imagePath, warnings: [] };
  const head = await readHead(imagePath, 262_144);
  const dimensions = parseImageDimensions(head);
  if (!dimensions || !dimensions.width || !dimensions.height) {
    return { ok: true, path: imagePath, warnings: ['image-size-unknown'] };
  }
  if (Math.max(dimensions.width, dimensions.height) <= maxImageDimension) {
    return { ok: true, path: imagePath, warnings: [] };
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'privacy-extract-scale-'));
  const target = path.join(dir, 'scaled.png');
  try {
    const python = resolvePythonPath();
    const result = await runProcess(
      python,
      ['-c', DOWNSCALE_SCRIPT, imagePath, target, String(maxImageDimension)],
      { timeoutMs: timeoutFor('python') },
    );
    if (result.timedOut) {
      await removeTree(dir);
      return block(REASONS.TIMEOUT, 'downscaling a page for OCR timed out');
    }
    if (result.spawnError) {
      await removeTree(dir);
      return block(REASONS.PARSE_FAILED, 'cannot run the bundled python interpreter to downscale a page');
    }
    if (result.code !== 0) {
      await removeTree(dir);
      return block(REASONS.PARSE_FAILED, 'downscaling a page for OCR failed');
    }
    return { ok: true, path: target, cleanupDir: dir, warnings: ['image-downscaled'] };
  } catch {
    await removeTree(dir);
    return block(REASONS.PARSE_FAILED, 'downscaling a page for OCR failed');
  }
}

async function ocrWithWinrt(images, langSpec) {
  const probe = await probeWinrtOcr();
  if (!probe.ok) return { ok: false, detail: probe.detail };
  const { tag, warnings } = pickWinrtLanguage(langSpec, probe.languages);

  const outDir = await mkdtemp(path.join(os.tmpdir(), 'privacy-extract-ocr-'));
  try {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PS_OCR_SCRIPT,
      '-OutDir',
      outDir,
      '-Images',
      images.join('|'),
    ];
    if (tag) args.push('-LangTag', tag);

    const result = await runProcess('powershell.exe', args, { timeoutMs: timeoutFor('ocr') });
    if (result.timedOut) return { ok: false, detail: 'WinRT OCR timed out' };
    if (result.overflow) return { ok: false, detail: 'WinRT OCR produced too much output' };
    if (result.spawnError) return { ok: false, detail: 'powershell.exe could not be started' };
    if (result.code !== 0 || !/WINRT_OCR_DONE/i.test(result.stdout)) {
      // stdout carries only ASCII markers; never echo stderr here (it may
      // contain a document path).
      const failLine = /WINRT_OCR_FAIL[^\n]*/i.exec(result.stdout)?.[0];
      return { ok: false, detail: failLine ? failLine.trim().slice(0, 120) : `WinRT OCR exited ${result.code}` };
    }

    const pageTexts = [];
    for (const image of images) {
      const base = path.basename(image, path.extname(image));
      const jsonPath = path.join(outDir, `${base}.json`);
      let parsed;
      try {
        parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
      } catch {
        return { ok: false, detail: 'WinRT OCR produced no result for a page' };
      }
      const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
      pageTexts.push(reconstructReadingOrder(lines));
    }
    return {
      ok: true,
      text: joinOcrPages(pageTexts),
      engineLabel: 'winrt-ocr',
      warnings,
    };
  } finally {
    await removeTree(outDir);
  }
}

/**
 * OCR a list of image paths with the first engine that yields text.
 * Returns { ok:true, text, engineLabel, pages, warnings } or a block.
 * An empty recognition result is a block (PARSE_FAILED), never an empty success.
 */
export async function ocrImages(images, { langSpec, engines } = {}) {
  if (!images || images.length === 0) return block(REASONS.PARSE_FAILED, 'no images to OCR');
  if (images.length > DEFAULTS.maxOcrImages) {
    return block(REASONS.OUTPUT_TOO_LARGE, `too many pages to OCR (${images.length} > ${DEFAULTS.maxOcrImages})`);
  }
  const available = engines ?? (await detectOcrEngines()).engines;
  if (!available || available.length === 0) {
    const detection = await detectOcrEngines();
    return block(REASONS.NO_LOCAL_OCR, detection.detail || 'no local OCR engine available');
  }

  const errors = [];
  for (const engine of available) {
    let result;
    if (engine.name === 'tesseract') result = await ocrWithTesseract(images, langSpec);
    else if (engine.name === 'winrt-ocr') result = await ocrWithWinrt(images, langSpec);
    else continue;

    if (result.ok) {
      const text = result.text.trim();
      if (text) {
        return {
          ok: true,
          text,
          engineLabel: result.engineLabel,
          pages: images.length,
          warnings: result.warnings ?? [],
        };
      }
      errors.push(`${engine.name}: no text recognized`);
      continue;
    }
    errors.push(`${engine.name}: ${result.detail}`);
  }
  return block(REASONS.PARSE_FAILED, `OCR produced no text (${errors.join('; ')})`.slice(0, 500));
}

// ---------------------------------------------------------------------------
// OOXML extraction via the bundled python interpreter
// ---------------------------------------------------------------------------

const OFFICE_SCRIPT = path.join(PKG_DIR, 'py', 'extract_office.py');
const OFFICE_KINDS = new Set(['docx', 'xlsx', 'pptx']);

export async function readFileCapped(filePath, cap = maxOutputBytes()) {
  const info = await stat(filePath);
  if (!Number.isFinite(info.size)) return block(REASONS.PARSE_FAILED, 'cannot size extracted output');
  if (info.size > cap) return block(REASONS.OUTPUT_TOO_LARGE, `extracted text exceeds ${cap} bytes`);
  return { ok: true, data: await readFile(filePath) };
}

/** Extract text from docx/xlsx/pptx with python-docx / openpyxl / python-pptx. */
export async function extractOfficeText(filePath, kind) {
  if (!OFFICE_KINDS.has(kind)) return block(REASONS.NOT_A_DOCUMENT, `unsupported office kind: ${kind}`);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'privacy-extract-office-'));
  try {
    const outPath = path.join(dir, 'out.txt');
    const python = resolvePythonPath();
    const result = await runProcess(python, [OFFICE_SCRIPT, kind, filePath, outPath], {
      timeoutMs: timeoutFor('python'),
    });

    if (isMissingBinary(result)) {
      return block(REASONS.PARSE_FAILED, 'bundled python interpreter not found for local OOXML extraction');
    }
    if (result.timedOut) return block(REASONS.TIMEOUT, `local ${kind} extraction timed out`);
    if (result.overflow) return block(REASONS.OUTPUT_TOO_LARGE, `local ${kind} extraction produced too much output`);
    if (result.spawnError) return block(REASONS.PARSE_FAILED, 'cannot start the bundled python interpreter');
    if (result.code !== 0) {
      // Never echo stderr: it can contain the path or document content.
      return block(REASONS.PARSE_FAILED, `local ${kind} extraction failed (helper exited ${result.code})`);
    }

    const read = await readFileCapped(outPath);
    if (!read.ok) return read;
    const text = normalizeText(read.data.toString('utf8'));
    if (!text.trim()) return block(REASONS.PARSE_FAILED, `no text found in ${kind} document`);
    const engineLabel =
      kind === 'docx' ? 'python-docx' : kind === 'xlsx' ? 'openpyxl' : 'python-pptx';
    return { ok: true, text, engineLabel, pages: 1, warnings: [] };
  } finally {
    await removeTree(dir);
  }
}

// ---------------------------------------------------------------------------
// Page range parsing
// ---------------------------------------------------------------------------

/**
 * Parse `--pages A-B` (or a single `A`). Returns { ok:true, range|null } or
 * { ok:false, detail }. Never throws.
 */
export function parsePageRange(spec) {
  if (spec === undefined || spec === null || spec === '') return { ok: true, range: null };
  const match = /^(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?$/.exec(String(spec).trim());
  if (!match) return { ok: false, detail: 'expected --pages A-B with positive integers' };
  const first = Number.parseInt(match[1], 10);
  const last = match[2] ? Number.parseInt(match[2], 10) : first;
  if (first < 1 || last < 1) return { ok: false, detail: 'page numbers start at 1' };
  if (last < first) return { ok: false, detail: '--pages range must not be descending' };
  return { ok: true, range: { first, last } };
}

/** Number of pages in a range, clamped to a known total (when available). */
export function rangePageCount(range, totalPages) {
  if (!range) return totalPages ?? null;
  let last = range.last;
  if (Number.isFinite(totalPages) && totalPages > 0) last = Math.min(last, totalPages);
  const count = last - range.first + 1;
  return count > 0 ? count : 0;
}

/**
 * Guard for a successful extraction: text must contain something other than
 * whitespace. Empty text is never a success (contract: no empty success).
 */
export function requireText(text) {
  const normalized = normalizeText(text).trim();
  if (!normalized) return block(REASONS.PARSE_FAILED, 'extraction produced no text');
  return { ok: true, text: normalized };
}
