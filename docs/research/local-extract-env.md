# local-extract — measured environment and engine matrix

**Notation.** `<repo>` = this repository's checkout root; relative paths (`test/…`, `ps/…`, `py/…`, `engines.js`)
are from the package directory `<repo>/packages/local-extract/`; `%TEMP%` (`$TMPDIR` on POSIX) = the per-user
temporary directory; `%SystemRoot%` = the Windows directory.

Measured **2026-11-02** on the reference machine (Europe/Berlin) with the bundled runtimes.
All fixtures are synthetic files generated locally by `test/make-fixtures.mjs`; no real
document, invoice, ID or PII tree was read (invariant I9).

Environment: **Windows 11 Pro, 10.0.26200.0**, node `v24.21.0` (bundled), python `3.12.14`
(bundled), poppler `24.04.0` from the MiKTeX distribution (`pdftotext.exe`, `pdftoppm.exe`,
`pdfinfo.exe` on `PATH`), Windows PowerShell `5.1` (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`).

Reproduce the whole table with the bundled node:

```
node test/measure-engines.mjs
```

## 1. Tool / engine matrix (command → measured output, exit code)

| Tool / probe | Command run | Measured output (abridged) | Exit | Verdict |
|---|---|---|---|---|
| bundled node | `node --version` | `v24.21.0` | 0 | present |
| bundled python | `python --version` | `Python 3.12.14` | 0 | present |
| `pdftotext` | `pdftotext -v` | `pdftotext version 24.04.0` | 0 | works |
| `pdftoppm` | `pdftoppm -v` | `pdftoppm version 24.04.0` | 0 | works |
| `pdfinfo` | `pdfinfo -v` | `pdfinfo version 24.04.0` | 0 | works |
| `tesseract` | `where.exe tesseract` | `INFO: Could not find files for the given pattern(s).` | **1** | **absent** |
| `tesseract` | `tesseract --version` | PowerShell: "The term 'tesseract' is not recognized…" | **1** | **absent** |
| WinRT OCR capability | `powershell.exe -File ps/winrt-ocr.ps1 -Probe` | `WINRT_PROBE_OK langs=de-DE,en-GB,en-US,zh-Hans-CN maxdim=10000` | 0 | **works** |
| WinRT OCR (2 pages, 300 dpi) | see §2 | `WINRT_OCR_DONE pages=2` | 0 | **works** |
| python libs | `python -c "import PIL, numpy, docx, pptx, openpyxl …"` | `PIL 12.3.0 numpy 2.3.5 openpyxl 3.1.5`; docx/pptx import OK | 0 | works |
| python OCR libs | same probe | `pytesseract ABSENT`, `easyocr ABSENT`, `paddleocr ABSENT` | 0 | absent |
| PDF text layer | `pdftotext -layout -enc UTF-8 -q text.pdf -` | 93 chars: `Rechnung Nr.: 1001 / Kunde: Max Mustermann / IBAN: DE89370400440532013000 / Gesamt: 44,98 EUR` | 0 | works |
| image-only PDF | `pdftotext … scanned.pdf -` | `"\f\f"` — whitespace only (no text layer) | 0 | must fall back to OCR |
| corrupt PDF | `pdftotext … corrupt.pdf -` | empty stdout | **1** | `PARSE_FAILED` |
| encrypted PDF | `pdfinfo encrypted.pdf` | stderr `Command Line Error: Incorrect password` | **1** | `ENCRYPTED_PDF` |
| PDF render | `pdftoppm -r 300 -png scanned.pdf page` | 2 PNGs, `2400×640` each, 679–707 ms | 0 | works |

`pdfinfo` also reports `Encrypted: yes` for normally-open encrypted PDFs; both signals map to
`ENCRYPTED_PDF`. A failed `pdfinfo` with a password/encryption hint is classified as encrypted and
blocks before any text is extracted.

## 2. WinRT OCR adapter (`ps/winrt-ocr.ps1`) — measured

Uses the local Windows OS component `Windows.Media.Ocr` through `powershell.exe`; no package
install, no network, no telemetry (audited: no `fetch`/`node:http(s)/net/dns` in
`cli.js`, `engines.js`, `ps/winrt-ocr.ps1`, `py/extract_office.py` — measured by
`test/measure-engines.mjs` → `network audit: no network API found`).

- **Languages present:** `de-DE, en-GB, en-US, zh-Hans-CN` (`OcrEngine.AvailableRecognizerLanguages`).
- **`OcrEngine.MaxImageDimension`:** `10000` px.
- **Probe cost:** ~0.5 s (one-time per CLI invocation, only when OCR is actually needed).
- **Recognition cost:** 2 pages at 300 dpi → **642–779 ms** including PowerShell startup.
- **Full CLI cost** (`elapsedMs` in the JSON, includes node startup):
  text PDF 866 ms · scanned 2-page PDF 2907–3287 ms · 1 PNG image 1398 ms ·
  docx 546 ms · xlsx 1068 ms · pptx 764 ms · 2-column scan 3116 ms.
- **Output:** per-page JSON with `text`, `x`, `y`, `w`, `h` for every `OcrLine` (bounding box =
  union of its words). Node reconstructs reading order from the boxes.

### Reading order — measured honestly

`OcrResult.Lines` is ordered by layout block, **not** by visual row. On a synthetic two-column
invoice (rendered 2400 px wide, 44 px Arial, 300 dpi) the native order was:

```
["Rechnung Nr. 1001","Kunde: Max Mustermann","Position","Synthetic item A","Synthetic item B",
 "Menge","2","1","19,99 EUR","5,00 EUR","Datum: 01.02.2026","IBAN: DE89370400440532013000",
 "Summe","39,98 EUR","5,00 EUR","Gesamt: 44,98 EUR"]
```

so `label / value` pairs that share a visual row are split far apart. `reconstructReadingOrder()`
groups lines whose vertical centres overlap (tolerance `max(4 px, 0.5 × median line height)`), sorts
rows by `y` and items inside a row by `x`, joining items with ` | `. Reconstructed order (measured,
and asserted in `test/cli.test.mjs` and `test/engines.test.mjs`):

```
Rechnung Nr. 1001 | Datum: 01.02.2026
Kunde: Max Mustermann | IBAN: DE89370400440532013000
Position | Menge | Summe
Synthetic item A | 2 | 19,99 EUR | 39,98 EUR
Synthetic item B | 1 | 5,00 EUR | 5,00 EUR
Gesamt: 44,98 EUR
```

**WinRT OCR is lossy, not a guarantee.** In that same render the `Preis` header was dropped (the
`Position | Menge | Summe` row is missing it; `19,99 EUR` still mapped to its row). Downstream
redaction can only mask what OCR produced; extraction must be treated as best-effort local
transcription, not a fidelity guarantee. Skewed/rotated pages and handwriting are **UNVERIFIED**
(WinRT OCR is tuned for printed text). Only the four installed language packs are available; a
requested `--lang` that is not installed falls back to `en-US`/profile and adds a
`lang-unavailable:*` warning.

### Bitmap and page caps

- Pages are rendered at 300 dpi, reduced by `chooseRenderDpi()` when the page would exceed
  `MaxImageDimension` (e.g. very large formats) with the `render-dpi-reduced` warning.
- Any input bitmap larger than `MaxImageDimension` is downscaled locally with Pillow
  (`ensureOcrSizedImage`), warning `image-downscaled`; this path also covers phone-sized photos.
- OCR is capped at **500 pages** (`DEFAULTS.maxOcrImages`) → `OUTPUT_TOO_LARGE` before rendering.
- Captured subprocess output and extracted text are capped at **4 MiB** → `OUTPUT_TOO_LARGE`.
- Timeouts: pdfinfo 20 s, pdftotext 30 s, pdftoppm 180 s, OCR 240 s, python 90 s → `TIMEOUT`.

### Temp-file handling (privacy)

Rendered page PNGs and OCR result JSONs live in a fresh `%TEMP%\privacy-extract-*` directory
(`mkdtemp`) and are removed in `finally` blocks; OCR text is returned only via the file contents
that are read back. Measured: directories exist during a run (`privacy-extract-render-*`) and
`temp dirs after cleanup: []` afterwards; repeated CLI OCR runs left `0` new `privacy-*` dirs.
Risk: if node is force-killed mid-extraction the directory can survive until OS cleanup; it is
under the user's own temp ACL. No raster or extracted text is written anywhere else.

## 3. OCR adapter ranking (implemented order)

1. **`tesseract`** — implemented in `engines.js::ocrWithTesseract` (`-l <lang> --psm 3`), but
   **UNVERIFIED on the reference machine** because the binary is absent. If installed it is preferred over
   WinRT. `--lang deu+eng` is passed through; a "Failed loading language" error retries with `eng`.
2. **`winrt-ocr`** — works, measured above; the default adapter on the reference machine.
3. **python `easyocr` / `paddleocr`** — absent from the bundled interpreter; no adapter shipped.
   Installing one locally would require adding an adapter to `engines.js`; it is not needed on
   the reference machine.

No network is used by any adapter. `tesseract` and WinRT OCR never receive the document path in a
tool result/block detail (the PS script's stdout carries only ASCII markers; Node never echoes PS
stderr, which can contain a path).

## 4. Mode decision matrix (measured behaviour on the reference machine)

| mode | input | outcome on the reference machine |
|---|---|---|
| `pdf` | PDF with text layer | **works**, `engine: "pdftotext"` |
| `pdf` | image-only PDF | **works**, `engine: "winrt-ocr"`, warning `no-text-layer` |
| `pdf` | image-only PDF with OCR disabled (env/`--no-ocr`) | **blocks** `NO_LOCAL_OCR`, exit 3 |
| `pdf` | image-only PDF with renderer disabled (env seam) | **blocks** `NO_LOCAL_RENDERER`, exit 3 |
| `pdf` | blank scanned page (OCR finds no text) | **blocks** `PARSE_FAILED`, exit 3 (never empty success) |
| `pdf` | encrypted PDF | **blocks** `ENCRYPTED_PDF`, exit 3 |
| `pdf` | corrupt PDF | **blocks** `PARSE_FAILED`, exit 3 |
| `pdf` | non-PDF input | **blocks** `NOT_A_DOCUMENT` (binary/zip input: `UNSUPPORTED_BINARY`) |
| `ocr` | PDF or image | **works**, `winrt-ocr`; no engine → `NO_LOCAL_OCR` |
| `image` | PNG/JPEG/TIFF/BMP/GIF/WebP | **works**, `winrt-ocr`; non-image → `NOT_A_DOCUMENT` |
| `doc` | `.docx` | **works**, `engine: "python-docx"` |
| `doc` | `.xlsx` | **works**, `engine: "openpyxl"` |
| `doc` | `.pptx` | **works**, `engine: "python-pptx"` |
| `doc` | legacy OLE `.doc/.xls/.ppt` | **blocks** `UNSUPPORTED_BINARY` |
| `doc` | corrupt OOXML / empty OOXML | **blocks** `PARSE_FAILED` |
| `auto` | PDF / image / docx / xlsx / pptx | dispatches to the pipeline above |
| `auto` | unknown binary, unknown zip, OLE binary | **blocks** `UNSUPPORTED_BINARY` |
| `auto` | plain text | **blocks** `NOT_A_DOCUMENT` |
| any | timeout / output cap test seams | **blocks** `TIMEOUT` / `OUTPUT_TOO_LARGE` |
| any | path outside `PRIVACY_EXTRACT_ALLOWED_ROOT` | **blocks** `PATH_NOT_ALLOWED`, exit 3 |

The CLI has **no implicit path policy** — Gate 2's `allowPaths` owns it. The allowed-root pin is
opt-in and only set by the caller; it is recorded in [the interface contract](../interface-contract.md).

## 5. Environment seams (test-only, documented)

Production never sets these. They only narrow behaviour (skip engines / lower limits / pin a root),
they can never widen it or add a cloud fallback.

| seam | effect |
|---|---|
| `--no-ocr` (CLI flag) | sets the disable below for one invocation |
| `PRIVACY_EXTRACT_DISABLE_OCR=1` | no OCR adapters at all → image-only input blocks `NO_LOCAL_OCR` |
| `PRIVACY_EXTRACT_DISABLE_RENDERER=1` | `pdftoppm` never runs → `NO_LOCAL_RENDERER` |
| `PRIVACY_EXTRACT_TIMEOUT_MS=N` | overrides every per-step timeout → `TIMEOUT` |
| `PRIVACY_EXTRACT_MAX_OUTPUT_BYTES=N` | overrides the 4 MiB capture cap → `OUTPUT_TOO_LARGE` |
| `PRIVACY_EXTRACT_ALLOWED_ROOT=path` | path pin; outside → `PATH_NOT_ALLOWED` (exit 3) |
| `PRIVACY_EXTRACT_PYTHON=path` | alternatives to the bundled python (portability only) |

## 6. Contract decisions / deviations

1. `PATH_NOT_ALLOWED` added to the blocked-reason vocabulary per the interface contract; exit **3** (not 2).
   No implicit path policy; the pin is opt-in.
2. `--no-ocr` CLI flag added as the required deterministic fail-closed seam (required by the interface contract).
3. `mode` in success JSON is the **executed** pipeline for `auto` (`pdf`/`image`/`doc`), never `"auto"`.
4. `pages` is `1` for OOXML (not a paged format); PDF/OCR report the number of pages processed
   (range-clamped).
5. OCR text joins items on the same visual row with `" | "` — that separator is not in the source
   document; it exists so `key: value` pairs survive the layout-grouped line order.
6. A blank scanned page blocks `PARSE_FAILED` even when an OCR engine exists (an empty result is
   never a success; the frozen vocabulary has no more specific reason for "engine ran, found no text").
7. `--json` is accepted for contract compatibility; stdout is always exactly one JSON object.
8. OCR page cap (500) blocks with `OUTPUT_TOO_LARGE` before rendering, to keep the rules
   "every subprocess has a timeout" and "outputs are capped" meaningful for huge scans.

## 7. Open risks

- **Lossy OCR:** WinRT dropped a column header in a measured render; fields can be missing. Masking
  cannot recover them. Treat `engine: "winrt-ocr"` as best-effort local transcription.
- **Reading-order heuristic:** assumes horizontal rows; multi-line table cells can be merged or
  split differently. It is a heuristic, asserted against measured boxes, not a layout engine.
- **Language packs:** only the installed 4. A machine without any pack → `NO_LOCAL_OCR` (handled by
  probe), not a silent empty result.
- **tesseract adapter untested** on the reference machine (binary absent); shipping code branch is small but unverified.
- **Force-kill during OCR** can leave a `%TEMP%\privacy-extract-*` directory (user-owned temp ACL);
  normal and timeout paths clean up in `finally`.
- **`pdfinfo` encryption heuristics:** encrypted PDFs are detected via `Encrypted: yes` or a
  password/encryption error; exotic security handlers could fail differently and would block
  `PARSE_FAILED`, which is still fail-closed.
- **Performance:** OCR costs ~0.5 s PowerShell startup + ~0.3 s/page; large scans hit the 240 s
  OCR timeout before the page cap in pathological cases, producing `TIMEOUT` (fail-closed).
