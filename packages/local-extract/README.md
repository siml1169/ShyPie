# @shypie/local-extract

Local-only document → text extraction for the privacy-first workflow. Zero npm
dependencies, no network I/O, no cloud fallback (invariant I1). When local
conversion is impossible the CLI **blocks** with a structured reason instead of
returning bytes or empty text.

```
node cli.js --json <pdf|ocr|doc|image|auto> <path> [--max-chars N]
            [--pages A-B] [--lang deu+eng] [--no-ocr]
```

Exit codes: `0` success + JSON, `3` policy block + JSON, `2` usage error + JSON.
stdout is always exactly one JSON object (the `--json` flag is accepted for
contract compatibility).

## Success JSON

```json
{ "ok": true, "mode": "pdf", "engine": "pdftotext", "text": "…", "pages": 1,
  "chars": 4210, "warnings": ["no-text-layer"], "elapsedMs": 120 }
```

## Block JSON (fail closed, never content)

```json
{ "ok": false, "blocked": true, "reason": "NO_LOCAL_OCR", "detail": "…" }
```

Reasons: `NO_LOCAL_OCR`, `NO_LOCAL_RENDERER`, `NOT_A_DOCUMENT`, `UNSUPPORTED_BINARY`,
`ENCRYPTED_PDF`, `PARSE_FAILED`, `OUTPUT_TOO_LARGE`, `TIMEOUT`, `PATH_NOT_ALLOWED`.

## Modes

| mode | what it does |
|---|---|
| `pdf` | `pdftotext -layout -enc UTF-8 -q`; if the text layer is empty it renders pages locally and OCRs them; no OCR engine → `NO_LOCAL_OCR` |
| `ocr` | PDF (render first) or image → local OCR |
| `image` | image → local OCR; never returns bytes |
| `doc` | `.docx`/`.xlsx`/`.pptx` via the bundled python-docx / openpyxl / python-pptx |
| `auto` | sniffs magic bytes and dispatches; unknown binaries block `UNSUPPORTED_BINARY` |

OCR adapter order: `tesseract` (if installed; **not verified** on the reference
machine) → Windows `Windows.Media.Ocr` through `powershell.exe` (`winrt-ocr`,
verified working, see [the environment note](../../docs/research/local-extract-env.md)). Nothing is sent over the
network; no cloud converter exists in this package.

## Environment seams (test-only, documented)

Production callers never set these; they only narrow behaviour.

| seam | effect |
|---|---|
| `--no-ocr`, `PRIVACY_EXTRACT_DISABLE_OCR=1` | skip all OCR adapters → `NO_LOCAL_OCR` |
| `PRIVACY_EXTRACT_DISABLE_RENDERER=1` | skip `pdftoppm` → `NO_LOCAL_RENDERER` |
| `PRIVACY_EXTRACT_TIMEOUT_MS=N` | override per-step timeouts → `TIMEOUT` |
| `PRIVACY_EXTRACT_MAX_OUTPUT_BYTES=N` | override the 4 MiB cap → `OUTPUT_TOO_LARGE` |
| `PRIVACY_EXTRACT_ALLOWED_ROOT=path` | opt-in path pin; outside → `PATH_NOT_ALLOWED` (exit 3) |
| `PRIVACY_EXTRACT_PYTHON=path` | alternate bundled python (portability only) |

## Safety properties

- Every subprocess is spawned with a timeout; on expiry it is killed (`TIMEOUT`).
- Captured stdout/stderr and extracted text are capped at 4 MiB (`OUTPUT_TOO_LARGE`);
  the OCR page count is capped at 500 pages before rendering.
- No empty success: whitespace-only/empty extraction blocks `PARSE_FAILED`.
- Temporary rendered pages and OCR scratch are created in a fresh
  `%TEMP%\privacy-extract-*` directory and deleted in `finally` blocks.
- Blocked `detail` strings never echo document content or file paths.

## Files

- `cli.js` — argument parsing, mode dispatch, JSON/exit-code contract.
- `engines.js` — testable primitives: process runner, sniffing, poppler wrappers,
  WinRT OCR adapter, reading-order reconstruction, OOXML extraction, page ranges.
- `ps/winrt-ocr.ps1` — WinRT OCR script (probe + batch OCR, outputs per-line boxes).
- `py/extract_office.py` — local OOXML text extraction for the bundled python.
- `test/make-fixtures.mjs` — synthetic fixture generator; exports `makeTextPdf`,
  `makeScanPdf`, `makeScanImage`, `generateFixtures`, `ensureFixtures` for the e2e.
- `test/measure-engines.mjs` — reproducible measured engine matrix used by the research note.

## Tests

```
node --test test/cli.test.mjs test/engines.test.mjs test/fixtures.test.mjs
```

49 tests; require poppler on `PATH` and the bundled python, no network. Run it with any Node.js 22+ (the runtime bundled with DeepSeek Harness also works).
On a machine without a local OCR engine the OCR tests assert the `NO_LOCAL_OCR` block
instead of success (they branch on the measured engine list).
