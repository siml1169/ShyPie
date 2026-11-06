# Interface reference

The stable interfaces of this workflow: the shared redactor, the local extractor CLI, the DSH bundle
and the Magpie middleware. The components implement this document; rationale is in
[design.md](design.md), installation in [install.md](install.md), and the evidence notes in
[research/](research/).

Two constraints shaped every interface below:

- DSH's outbound LLM request is deep-frozen and is a pure fold of the session log, so a plugin
  **cannot** rewrite the request on the way out (that is what Magpie does for its other agents).
- Therefore masking must happen **at ingestion**, before bytes enter the session log.
- Magpie's masking is a last-hop text substitution over the outbound body. It cannot touch raster
  images, PDFs or tool results, and the plaintext stays in the local session log.
- The required design is therefore: local extraction (PDF/OCR) → local deterministic redaction →
  only redacted text enters the session log and leaves the machine. Any path where local conversion
  fails must **block**, never pass through.

These shapes are frozen: changing one requires changing every component and the tests in the same
commit. Behavioural values (detector thresholds, defaults) are documented with the components.

## Non-negotiable invariants

I1. No plugin code performs network I/O. No `fetch`, no `http`, no telemetry, no update checks.
    Tests must not require network.
I2. Plaintext PII never leaves the machine in an LLM request. Document and tool output enter the
    session log already redacted. User-typed prompt text is redacted in the model-visible projection
    by Gate 3, but the raw submitted prompt is durably recorded by the harness itself
    (`agent/inbox/spliced`) before any supported plugin seam runs — that is a **documented local
    residual**, not a provider leak; the DSH gate must say so rather than claim otherwise. A supported
    plugin must not monkey-patch internal methods to close it.
I3. The DSH gate fails closed: unknown/failed extraction ⇒ structured error and no content.
I4. The Magpie gate fails closed: a content part that cannot be masked (image/file/audio/video)
    is rejected for any model not explicitly allowlisted as local.
I5. Vault values are held in memory only during a session and, if persisted, encrypted
    (AES-256-GCM) at rest with a key file mode 0600. No plaintext audit log, ever.
I6. Redaction is deterministic and idempotent. `redact(redact(x)) === redact(x)`.
I7. Placeholders are keyed: a placeholder must not reveal its value (no plain hash of the value
    without a secret key). Format: `{{KIND_xxxxxxxx}}` where `xxxxxxxx` is 8 uppercase Base32
    chars of HMAC-SHA256(key, kind + "\0" + value).
I8. Restore is tolerant of model rewrites: case changes, internal spaces, full-width braces.
I9. Never read or copy a user's real documents. Fixtures must be synthetic and generated.
    Never print or commit a real IBAN, address, name, invoice, or ID document.
I10. Journal/audit records contain `kind`, `length`, `count`, `path_hash`, `ts` — never a value,
     not even first characters.

## Component layout

```
README.md
docs/
  design.md               design, threat model, limitations
  install.md              installation and verification
  interface-contract.md   this document
  research/               evidence notes (DSH seams, Magpie docs, detectors, engine matrix,
                          background, security review)
packages/
  pii-core/               @shypie_privacy/pii-core
  local-extract/          @shypie_privacy/local-extract
plugins/
  dsh-privacy-gate/       @shypie_privacy/dsh-privacy-gate
  privacy-gate/           @magpie-community/middleware-privacy-gate
config/                   example Magpie middleware options
tests/                    end-to-end suite and the one-command runner
```

The test suite never installs either plugin, never edits a live DSH profile or Magpie configuration,
and never uses the network.

## Reference environment

The build and the measurements in [research/](research/) were made on a Windows 11 machine. Notes
for other environments:

- DSH ships its implementation inside `app.asar`. The research notes refer to `$DSH_INSTALL` for the
  directory containing `node_modules/@deepseek-ai/`; to inspect the shipped source, extract the
  archive (`npx asar extract app.asar dsh-src`) and read `dsh-src/node_modules/@deepseek-ai/...`.
- Node.js 22+ (the runtime bundled with DSH works). Python 3.11+ is needed only by the Office
  extraction bridge.
- Poppler tools (`pdftotext`, `pdftoppm`, `pdfinfo`) on `PATH`.
- Windows OCR (`Windows.Media.Ocr`, reached through `powershell.exe`) is the default local OCR
  adapter. The `tesseract` adapter exists but was not exercised on the reference machine.
- Magpie's gateway listens on `http://127.0.0.1:3425/v1` by default; the workflow assumes the DSH
  providers point at it.

## pii-core API — `packages/pii-core/`

ESM, `"type": "module"`, zero npm dependencies, no `node:` import in `index.js` (so the module can
also be loaded by Magpie's moejs middleware, which has standard JS only). Node-only helpers live
behind the `./vault` subpath export.

```js
// package.json exports: { ".": "./index.js", "./vault": "./vault.js" }
export const VERSION;                 // "0.1.0"
export const KINDS;                   // readonly string[] — see catalogue below

export function createRedactor(config); // config: { key: string, kinds?: string[], allowWords?: string[] }
  // -> Redactor

Redactor = {
  scan(text),        // -> Hit[]; Hit = { kind, start, end, length, source, valid }
  redact(text),      // -> { text, tokens: Token[], hits: Hit[] , changed: boolean }
                     //    Token = { token, kind, length, count }   (NO value)
  restore(text),     // -> string  (unmask; tolerant rewrite handling)
  resolve(text),     // alias of restore
  hasPlaceholders(text), // -> boolean
  stats(),           // -> { charsScanned, byKind: Record<string, number> }
}

export function tokenFor(key, kind, value);   // -> "{{KIND_xxxxxxxx}}" deterministic
export function findPlaceholders(text);       // -> [{ token, kind }]
export function isPlaceholderShaped(text);    // -> boolean (whole-string test)
```

Detector catalogue (kind → what it must catch; checksum required where marked):

| Kind | Rule | Notes |
|---|---|---|
| `SECRET` | PEM private-key block, `sk-…`, `ghp_`, `AKIA…`, JWT, `user:pass@`, `PASSWORD=`-style named secrets | highest priority; never restore into a reply |
| `IBAN` | country-shape + **mod-97 == 1** | reject on checksum failure |
| `BIC` | `[A-Z]{4}DE[A-Z0-9]{2}([A-Z0-9]{3})?` and EU variants | deterministic |
| `EMAIL` | RFC-5322-lite | |
| `PHONE` | E.164 `+` form and DE national (`0…` with separators) | do not eat order ids / timestamps |
| `CARD` | 13-19 digits + **Luhn** + known IIN | |
| `VATID` | `DE` + 9 digits, **ISO 7064 MOD 11,10** | |
| `TAXID` | DE Steuernummer shapes (`12/345/67890`, `1234567890`) in keyword context `Steuer`, `St.-Nr`, `Tax` | context-anchored |
| `IDNR` | DE 11-digit tax id, **ISO 7064 MOD 11,10** | |
| `SSN` | US SSN with context, DE social-security `12 345678 X 123` | |
| `PASSPORT` / `IDCARD` | after `Pass`, `Reisepass`, `Personalausweis`, `ID`, `Ausweis` | context-anchored |
| `DOB` | dates in keyword context (`geb.`, `Geburtsdatum`, `DOB`, `birthday`) | suppress version-like strings |
| `ADDRESS` | DE street shape (`…straße|str.|weg|platz|gasse|allee|ring|damm|ufer` + number) and `PLZ Ort` (5 digits, ≥3 uppercase letters) | deterministic |
| `ACCOUNT` | `Konto`, `BLZ`, `IBAN`-adjacent account numbers | context-anchored |
| `PERSON` | only from `allowWords` (masked words list) | free-text names are explicitly out of deterministic scope; document this |
| `BLOB` | base64 run ≥ 400 chars (contiguous or line-wrapped), hex run ≥ 400 chars (contiguous or spaced), `data:` URI, PDF magic, ZIP magic | this is a **block** signal; `pii-core` also masks the span so `redact()` output carries no bytes target |

Placeholder output for a masked value: `{{IBAN_7K3Q2M2A}}`. Same value + same key ⇒ same token
for the whole session (prompt-cache stability). `redact()` must be O(n) per detector and handle
50k-char texts without pathological regex backtracking (no nested quantifiers).

`vault.js` (Node only): `createVault({ dir })` → `{ put(token, kind, value), get(token),
save(redactor), load(), path, wipe() }`. File encrypted AES-256-GCM; key file `0600`; no plaintext.

Tests: `node --test test/`. Must include negative cases (UUID, semver, ISO date, IP, order id,
hex hash, short base64, version strings, `1.2.3`) and checksum-failure cases.

## local-extract CLI — `packages/local-extract/`

Node ESM, zero deps, shells out to local binaries only.

```
node cli.js --json <mode> <path> [--max-chars N] [--pages A-B] [--lang deu+eng]
mode = pdf | ocr | doc | image | auto
```

Exit 0 + stdout JSON on success; exit 3 + JSON `{ ok:false, blocked:true, reason, detail }` on a
policy block; exit 2 on usage error. Contract:

```json
{ "ok": true, "mode": "pdf", "engine": "pdftotext", "text": "…", "pages": 3,
  "chars": 4210, "warnings": ["no-text-layer"], "elapsedMs": 120 }
```
```json
{ "ok": false, "blocked": true, "reason": "NO_LOCAL_OCR", "detail": "…" }
```
Blocked reasons (exact strings): `NO_LOCAL_OCR`, `NO_LOCAL_RENDERER`, `NOT_A_DOCUMENT`,
`UNSUPPORTED_BINARY`, `ENCRYPTED_PDF`, `PARSE_FAILED`, `OUTPUT_TOO_LARGE`, `TIMEOUT`,
`PATH_NOT_ALLOWED`. A policy block always exits 3; exit 2 is reserved for a usage error.
`PATH_NOT_ALLOWED` is emitted only when `PRIVACY_EXTRACT_ALLOWED_ROOT` is set and the input is
outside it — the CLI has no implicit path policy; the DSH gate's `allowPaths` owns that.
`PRIVACY_EXTRACT_DISABLE_OCR=1` (or `--no-ocr`) is a documented test seam that forces the
`NO_LOCAL_OCR` branch on machines where a local OCR engine exists.

Rules: `pdf` uses `pdftotext -layout -enc UTF-8 -q`; if the text layer is empty/whitespace-only it
must not silently succeed with empty text — it falls back to `ocr` and if OCR is unavailable
returns `NO_LOCAL_OCR` blocked. `image` mode either OCRs or blocks — it must never return bytes.
`doc` (docx/xlsx/pptx) uses the bundled python libs. No network. Everything runs with a timeout.

Tests: synthetic fixtures generated by `test/make-fixtures.mjs` (hand-built minimal PDF with a text
layer; an image-only PDF with a DCTDecode JPEG page built via Pillow). Cover: text PDF extracts,
image-only PDF blocks with `NO_LOCAL_OCR` when no engine, binary input blocks `UNSUPPORTED_BINARY`,
path outside workspace blocks, timeout.

## DSH plugin — `plugins/dsh-privacy-gate/`

A DSH bundle (Host plugin). Files: `package.json` (with `dsh.bundle.patch`), `cordis.patch.yml`,
`index.js`, `lib/*.js` (pure, testable), `locale/en.json`, `vendor/pii-core.js` (generated copy of
`packages/pii-core/index.js` by `scripts/vendor-core.mjs`).

Implements the following, verified against the shipped source (every claim carries a `file:line` reference in `research/dsh-hooks.md`):

- Gate 1 — tool ingress: a `tools/post-execute` waterfall listener that sees every text block of any
  tool result before it is appended. `textPolicy: 'filter'` (default) keeps local text and scans
  BLOB/media; `mask` redacts with `pii-core`. An
  error result's `meta` cannot be rewritten by this seam and is a documented local residual.
  Deterministic substitute: `dsh-compaction-tool-result-pruner`. Must return `next()` when it has
  nothing to change (practices.md: waterfall listeners that do not own the decision return next()).
- Gate 2 — local extraction tools: `privacy_extract` (pdf/doc/auto), `privacy_ocr`, `privacy_scan`.
  A document outside `allowPaths` is refused before the extractor is spawned (lexical path and
  realpath), and `allowPaths: []` means no document is readable.
  They shell out to `packages/local-extract/cli.js` (path configurable), redact the text with
  `pii-core` before returning, and surface a blocked result as a tool error, never as content.
- Gate 3 — user/attachment ingress: `agent/pre-step` handles the messages the loop appends.
  `textPolicy: 'filter'` keeps user text local; `mask` redacts it. An attached `image` is OCR'd
  locally and a `file` (PDF/Office) is extracted locally through the host attachment service; the
  block is replaced by one text block. Extraction results stay raw locally in filter mode and are
  masked in mask mode. The step is rejected when bytes cannot be read locally (missing service,
  failed verification, missing/failing extractor, empty result, BLOB, `imageParts`/`fileParts: block`);
  audio/video and unsupported files are rejected. The harness records the raw submitted prompt
  before this seam; that residual is documented, not hidden.
- Guards: deny `read_image` and `read` of binary/document extensions outside `allowPaths`; deny any
  tool result carrying a `BLOB` hit (base64/PDF/zip) — that is the "block the data transfer" rule.
- `privacy_rehydrate(text, artifactPath)`: resolves placeholders **inside the tool** into a local
  artifact and returns only `{ path, replaced, kinds }` — never the plaintext values. This is the
  round-trip rule: the model can act on placeholders without seeing values.
- Config via schemastery `Config`: `{ allowPaths: string[], detectors: string[],
  extractCli: string, audit: { enabled, path }, placeholderKey: { file }, imageParts: 'ocr'|'block',
  fileParts: 'extract'|'block', textPolicy: 'filter'|'mask' }`.
- Fail-closed: if `pii-core` cannot load, if the key file is missing, or if extraction blocks, the
  gate must deny rather than pass text through.

Tests: `node --test "test/*.test.mjs"` against `lib/*.js` with a fake ctx exposing the documented
waterfall registrations; assert that redaction happens, that `next()` is returned when unchanged,
that BLOB hits block, and that the fail-closed paths hold. The suite does not load the bundle into a
live profile.

## Magpie plugin — `packages/privacy-gate/` (magpie-community/plugins)

A Magpie gateway-middleware plugin (plain JS, runs in moejs: **no** `fetch`, timers, Node APIs,
`require`, or imports outside the plugin — everything bundled into the file).

Files: `privacy-gate.middleware.js`, `cases.json`, `privacy-gate.test.mjs`, `package.json`, `README.md`.

Hooks:

```js
export function onRequest(body, ctx)   // before routing/redaction; call ctx.reject(status, msg);
                                       // in magpie's host the call performs the rejection and returns nothing
export function onProvider(body, ctx)  // per provider try; may only rewrite body
export function onUsage(row, options)  // audit counters only; no bodies
```

Behaviour:

1. Structural egress firewall (the part Magpie cannot do): walk every `messages[].content[]` /
   `input[]` part; classify `text` vs `image_url|input_image|image|file|input_file|document|
   audio|video`; if a non-text part exists and `ctx.model` is not in `options.localModels` →
   `ctx.reject(403, "privacy-gate: binary/document part cannot be masked locally; extract to text
   first")` in `binaryPolicy: fail` (default). In `binaryPolicy: guide`, replace the part with
   type/size metadata and a neutral local-tool prompt instead, and re-scan the rewritten body;
   fall back to 403 if the rewrite cannot be bounded. The message must never echo content.
2. BLOB smuggling: reject a *text* part matching a base64/hex blob over the configured threshold
   (an agent can smuggle document bytes as text) with 403. Guide mode's single bounded walk must
   still scan older text and `system`/`instructions`. Vendor-sealed replay fields are exempt
   **only inside their vendor block**: Anthropic thinking `signature`, Responses reasoning
   `encrypted_content`, Gemini part `thoughtSignature`, and vendor item `id`; a same-named key in
   tool arguments or message text is still scanned. The text scan is bounded by `scanChars`.
3. Model allowlist: `options.allowModels` (globs) — anything else is rejected with 403 naming the
   model and the policy, never the content. Empty/absent = allow all (but rule 1 still applies).
   A present-but-malformed `allowModels` refuses every request instead of falling back to allow-all.
4. Audit: `onUsage(row, options)` increments counters and `console.log`s one bounded line
   (provider/model/status/blocked counts only) — Magpie logs it.
5. Never reject on plaintext PII *text*: `onRequest` runs before Magpie's redaction, so rejecting
   there would double-guess the masker. Document this ordering explicitly (docs: "before magpie's
   redaction on the way out and after it on the way back"), and state that text masking is Magpie's
   job (`redact` plugin, local astrlink-guard) while *this* plugin owns the structural gap.

The canonical plugin README gives the exact install/verify commands (`magpie plugin add <clone>/packages/privacy-gate`,
`magpie plugin options privacy-gate '<json>'`, the Settings → Privacy setup for full masking, and the
`magpie web`/`settings.json` equivalent), plus how to confirm with Settings → Privacy → Try it.

Tests: `test/harness.mjs` loads the middleware with `node:vm` in a context that exposes only
standard JS globals (proving moejs compatibility), feeds chat/responses/anthropic/gemini shaped
bodies, and asserts reject/allow decisions. No network.

## Evidence

Claims about DSH internals carry `path:line` references into the shipped source; claims about Magpie
carry the doc URL and the quoted sentence. The notes live in [research/](research/). Where a claim
could not be verified it is marked `UNVERIFIED` with the reason, and it is not treated as a
guarantee. A claim without evidence is not part of this contract.
