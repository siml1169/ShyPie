# ShyPie Filter — @shypie_privacy/dsh-privacy-gate

A DeepSeek Harness **Host bundle** that keeps PII on this machine. It masks at
**ingestion**, because DSH's outbound request is a deep-frozen fold of the session
log and cannot be rewritten on the way out — see
[`../../docs/research/dsh-hooks.md`](../../docs/research/dsh-hooks.md) §4.
It also asserts the final request at **`llm/stream`**, before the provider adapter (and Magpie) can
see it: anything un-maskable or uninspectable fails the turn.

## What it does

| Gate | Seam | Behaviour |
|---|---|---|
| 1 — tool ingress | `tools/post-execute` (waterfall) | Tool-result text is kept local by default (`textPolicy: filter`) or masked (`textPolicy: mask`). In filter mode the text is only scanned for unmaskable BLOB/media; in mask mode a success result is sanitized through `value` so the logged `meta` is re-derived from masked data. Binary payloads (`BLOB`) and image/file content are **blocked**, never forwarded. |
| 2 — local extraction | `privacy_extract`, `privacy_ocr`, `privacy_scan` | PDF/Office/image text is produced by the local CLI (`packages/local-extract/cli.js`) and returned by the explicit tool. Tool results still follow `textPolicy`; a blocked conversion (`NO_LOCAL_OCR`, `NOT_A_DOCUMENT`, …) is a tool **error**, never content. |
| 3 — user ingress | `agent/pre-step` (waterfall) | User text is kept local by default (`textPolicy: filter`) or masked (`mask`). An attached image is read by the local OCR engine; an attached PDF/Office file is read by the local extractor. The block is replaced by text before the message is logged (`imageParts: 'ocr'` / `fileParts: 'extract'`); when it cannot be read the whole step is **rejected**. Audio/video and blocked file parts are rejected. |
| Guards | `ctx.tools.guard()` | Denies `read_image` outright, and denies `read` of binary/document extensions outside `allowPaths`. |
| Round trip | `privacy_rehydrate` | Resolves placeholders **inside the tool**, writes the plaintext to a local artifact, and returns only `{ path, replaced, kinds }`. |
| Extra (defensive) | `tools/ptc-dispatch-log` | Masks the durable log copy of `run_code` sub-dispatches. |
| 4 — egress | `llm/stream` (waterfall, prepended) | Inspects the exact final request before adapter dispatch. Rejects image/file/audio/video blocks, unknown block types, BLOB, provider/model outside the allowlists, and over-budget requests. In `textPolicy: filter` it allows plaintext PII through the default Magpie-only provider, for Magpie to mask; `mask` also rejects PII. Returns a terminal error before `next()`, so no HTTP request reaches Magpie. |

## Files

```
index.js             apply()/Config/inject — the bundle entry point
lib/config.js        pure config resolution (frozen, unknown keys fail)
lib/paths.js         pure path predicates used by the guard
lib/redact.js        pure content/message/value masking over the pii-core API
lib/gate.js          the gates as pure decision shapers + installGates()
lib/ingest.js        reads prompt image/PDF attachments and replaces them with local text
lib/egress.js        final llm/stream egress guard (fail-closed before the adapter)
lib/tools.js         the four ToolDefinitions (raw register() form)
lib/extract.js       local-extract CLI adapter (spawn, no shell, no network)
lib/keyfile.js       placeholder HMAC key (mode 0600)
lib/audit.js         bounded journal: kind/length/count/path_hash/ts only
scripts/vendor-core.mjs   copies packages/pii-core/index.js → vendor/pii-core.js
scripts/activation-check.mjs  import + Config + apply() smoke check
vendor/pii-core.js   generated — never edit
```

## Install (not done by this repository)

```
# 1. vendor the redactor into the bundle
node scripts/vendor-core.mjs

# 2. from the Harness, install the bundle by absolute package directory
plugin_manager  { action: "install_bundle", target: "<abs>/plugins/dsh-privacy-gate" }
```

The bundle declares `dsh.bundle.patch`; its patch inserts one Host row
(`privacy-gate`). It declares `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-settings` as **peer
dependencies** on purpose: the host resolves those from the running installation, and without the
declaration a fresh profile cannot resolve `@deepseek-ai/schemastery` from a linked checkout at
all — the entry then fails to import. Do **not** hand-edit the profile's
`package.json`/`cordis.patch.yml`, and do not copy `vendor/` state between
installs — run the script.

From npm the same bundle installs by name —
`dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate` — with the `vendor/`
copy already inside the package. `engines.dsh` is `>=0.2.0 <0.3.0`
([docs/publish.md](../../docs/publish.md)).

## Config (row config; overrides replace the whole block)

```yaml
allowPaths: []                # path prefixes where a document may be read/extracted ([] means none)
detectors: []                 # pii-core kinds; empty = all
personWords: []               # allowWords for PERSON detection
extractCli: ''                # defaults to the sibling checkout, then the installed local-extract
audit: { enabled: false, path: '' }   # JSONL, kind/length/count/path_hash/ts only
placeholderKey: { file: '' }  # defaults to ~/.dsh/privacy/placeholder.key, created 0600
blockNonTextResults: true     # block tool results containing image/file blocks
artifactDir: ''               # defaults to ~/.dsh/privacy/artifacts (privacy_rehydrate target)
toolTimeoutMs: 120000
maxExtractChars: 200000
egressAllowProviders: ['magpie*']  # filter mode defaults to the Magpie gateway only
egressAllowModels: []        # [] = every model
egressMaxChars: 2000000      # reject instead of passing an uninspectable request
egressMaxNodes: 200000
scope: session               # session (default) | system — see below
sessionsPath: ''             # defaults to ~/.dsh/privacy/sessions.json
ocrEngine: local             # local | vision | auto (vision is configuration-only today)
ocrLang: ''                  # optional BCP-47-ish hint passed to the extractor (--lang)
imageParts: ocr              # ocr (default) | block — what an attached image becomes
fileParts: extract           # extract (default) | block — PDF/Office attachments
textPolicy: filter           # filter (default: raw local text) | mask (redact locally)
```

There is no `failClosed` switch: the gate always fails closed.

### Attached images and PDFs are read locally, not forwarded

An image reaches the agent as an `image` content block and a PDF/Office file as a `file` block, both
referencing an opaque content-addressed object (`ctx.attachments`). The gate reads the bytes, runs the
**local** extractor (`ocr` for images, `auto` for files; Windows OCR / pdftotext on this machine), and
substitutes one text block. In the default **filter** mode that text stays raw in the local
transcript; in **mask** mode it is masked with `pii-core`. Example (filter):

```
[privacy-gate: local OCR of an attached image/jpeg "scan.jpg", 113623 bytes, engine winrt-ocr]

Rechnung DE89370400440532013000 …
```

Why `agent/pre-step` and not the egress guard: the loop appends the decision's messages to the
session log (`dsh-agent-loop` `turn()`), so converting there keeps the pixels out of the transcript
and out of every later request. After that seam the request is a frozen fold of the log and can only
be rejected, never rewritten.

Fail-closed cases (the step is rejected, nothing is sent): no attachment service, an attachment that
fails verification, an extractor that is missing or fails, OCR that returns nothing, a BLOB-shaped
result, and `imageParts: 'block'` / `fileParts: 'block'`. Audio/video and unknown file parts have no
local reader and are rejected.

Trade-off: the transcript keeps the OCR text, not the image. That is the point of the gate — if you
need the model to *see* a picture, send it to a model you have declared local.

### Scope — per session by default

`scope: session` (the default) binds the gate to sessions instead of the whole profile. On first
activation the bundle writes `~/.dsh/privacy/sessions.json` and records, **once**, the sessions that
already exist under `<DSH_HOME>/sessions`: those are stored as `false` and are never gated, so
history written before the bundle existed cannot turn every later turn into
`PRIVACY_EGRESS_BLOCKED`. Sessions first seen after activation are gated; a later `setEnabled` in
that record wins over the snapshot.

`scope: system` is the old behaviour: every session, including ones that predate the bundle. Use it
only after quarantining old logs — the first request that folds unmaskable history is rejected.

The record holds session ids and booleans only — no content, no paths, no per-session timestamps —
and is written atomically with mode 0600. A missing or corrupt record re-snapshots the legacy
sessions, which can only widen the ungated set; it never narrows it silently.

**Session ids have two spellings.** The harness names a session's directory after its `SessionId`, so
the directory name *is* the id: current profiles use `session-<uuid>`, older ones a bare `<uuid>`.
The snapshot stores the name as found and every lookup tries both spellings, so one session cannot
hold two verdicts. Record `version: 1` stripped the prefix and therefore never matched a lookup —
legacy sessions were gated despite being recorded as off — so a version-1 record is discarded and
re-snapshotted on first use (per-session toggles from that record are lost, and the snapshot can only
make a session ungated, never gated).

| seam | session identity |
|---|---|
| `tools/post-execute`, `ctx.tools.guard` | `exec.agent.id` (`SessionId`) |
| `agent/pre-step` | `payload.agent.id` (`Agent.id` is the session id) |
| `llm/stream` | `request.sessionId`; absent on compaction and session-title calls, which `scope: session` leaves alone |
| settings route / `privacy_session` | whatever id the client or the tool passes; both spellings resolve to the same row |

### Settings page — own route, not a settings namespace

`lib/client.js` is the browser half: it registers a **ShyPie Filter** section
(`settings.section`, id `privacy-gate`, order 70) and renders `scope`, `allowPaths`, `extractCli`,
`ocrEngine`, `visionProvider`/`visionModel` and `allowAgentDisable`.

It does **not** use a settings namespace. In DSH 0.2.1-rc.5 the host api-proxy serves only the
namespaces in `WEB_SETTINGS_NAMESPACES` (`@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.js`), so
a third-party namespace answers `settings-not-exposed` for both reads and writes. This is the same
wall `dsh-client-ui-settings-plugins` documents as "a plugin distributed outside this repository
cannot surface its own configuration here without a change in `packages/host/apiproxy`".

The working pattern — used by Plugin Hub (`dsh-plugin`) in this profile — is a plugin-owned
same-origin HTTP route, and that is what this bundle now does:

| Piece | Where |
|---|---|
| `GET /shypie-privacy/settings` → `{ value, revision, defaults }` | [lib/http.js](lib/http.js) |
| `POST /shypie-privacy/settings` with a field patch → applied live, then persisted | [lib/http.js](lib/http.js) |
| Store: `~/.dsh/privacy/settings.json` (`{ version, revision, value }`, mode 0600, atomic) | `loadSettings` / `saveSettings` |
| Mounting: `ctx.inject(['webServer'], (host) => host.effect(() => registerSettingsRoute(...)))` | [index.js](index.js) |

Two details matter for safety and for boot:

- **The route is a security boundary.** It binds loopback only, rejects a non-loopback `Host`
  (plain HTTP and DNS rebinding), requires a matching `Origin` when the browser sends one, accepts a
  fixed field allowlist (`sessionsPath` and friends stay host-only), validates the merged value
  through `resolveConfig` before storing it, and answers `400` without persisting when validation
  fails.
- **Nothing new is injected at boot.** The entry injects `tools` only; `webServer` is requested in a
  child scope, and the client entry injects `slots` only. The earlier attempt injected
  `settingsScope`, which left the web-boot entry pending — DSH treats a pending entry as a failed
  start.

The renderer evaluates the client file through the same `window.__ModuleLoader__.load({ id, factory })`
wrapper the core client packages use. `test/client.test.mjs` checks the export shape and the
registration; `test/http.test.mjs` covers origin checks, the field allowlist, revision bumps and the
rejection paths without a browser.

| Field | Meaning |
|---|---|
| `scope`, `allowPaths`, `extractCli`, `detectors`, `personWords`, `blockNonTextResults` | as in the row config |
| `auditEnabled`, `auditPath` | the audit journal |
| `egressAllowProviders`, `egressAllowModels` | egress allowlists |
| `ocrEngine` | `local` (default), `vision` or `auto` — a preference, not a call |
| `visionProvider`, `visionModel` | the provider/model a future vision fallback would use; **no image is sent anywhere today** |

Saved values layer over the row config and are re-applied on the next start; a value that no longer
validates is ignored with a warning and the patch applies.

## Egress guard — fail closed before Magpie

DSH's `llm/stream` waterfall wraps adapter dispatch (`dsh-llm` `streamWithRegistration`). This
bundle registers a **prepended, global** listener that inspects the final
`{provider, model, messages, tools}` request and, before calling `next()`, returns a terminal error
stream. DSH's agent loop turns that into its own `LlmError` with code **`PRIVACY_EGRESS_BLOCKED`**.
No provider adapter is called, so Magpie never sees a blocked request and Magpie's 250 ms timeout
cannot drop the verdict. The guard does not throw out of the hook, which keeps the turn's error
structured.

The guard rejects:

- `image`, `file`, `audio` or `video` content blocks;
- unknown content-block types;
- `BLOB` in text, reasoning, tool-call arguments or tool-result content (always);
- PII in those fields only when `textPolicy: 'mask'`; in `filter` mode Magpie masks it outbound;
- a provider/model outside `egressAllowProviders` / `egressAllowModels`;
- a request over `egressMaxChars` or `egressMaxNodes` (fail closed, never degrade).

It does not mask or rewrite: the request is frozen, so rejection is the only action. Tool
declarations (`request.tools`, `request.toolHistory`) are schema, not conversation content, and are
skipped. The existing ingestion gates still run first; this is the final assertion that they left
nothing un-maskable.

**PII policy.** Default `filter` mode keeps PII in the local transcript and lets **Magpie's Privacy
masking** handle it outbound. The egress provider allowlist defaults to `magpie*`, so a direct
provider cannot receive raw text by accident. `mask` mode restores local placeholder masking and the
egress guard also rejects surviving PII. Filter mode is a deliberate usability/security trade: the
local log is readable, so protect the machine and keep Magpie masking enabled.

**Incremental scan.** DSH request messages are frozen and reused across steps. The guard caches the
message objects it has successfully inspected and scans only new messages; the first request pays
the full cost, later steps do not rescan the history. On a 5,000-block synthetic request the first
pass was ~107 ms and later requests with one new message ~0.1 ms in Node 24 with the real redactor.

`failClosed` is not a setting — failing closed is the only mode: if `vendor/pii-core.js` cannot load,
the key file is unusable, a redactor throws, or a document path is outside `allowPaths`, the gates
block tool results, reject prompt steps, and the four tools throw. Nothing falls through.

### `PRIVACY_EGRESS_BLOCKED` in a session that predates the gate

The request is a fold of the append-only session log, so **one message the gate cannot mask blocks
every later turn in that session** — including a message written before the bundle was installed.
This is the documented "start a new session after installing" rule, hardened into a hard stop. The
error names the reason and says what to do (`… (PII); an earlier message in this session still holds
content the gate cannot mask — start a new session (the log is append-only)`).

There is no override, by design. Recovering means leaving the poisoned history behind:

- start a **new** session (not a fork — a fork reseeds the old events);
- if the old log holds plaintext, delete or quarantine it rather than keeping it around:
  `%USERPROFILE%\.dsh\sessions\<project>\<session-id>\session.v4.jsonl.zstd`;
- a session whose plaintext came from before the gate was installed cannot be repaired in place;
  the gate never rewrites existing events.

If the rejection reason is not `PII`/`BLOB`, the hint on the error names the actual remedy
(`MEDIA_*` → the attachment is already logged, attach it in a new session, `PROVIDER`/`MODEL` →
allowlist, `LIMIT_*` → raise the budget).

## Troubleshooting the extractor

`privacy_extract` / `privacy_ocr` / `privacy_scan` shell out to `packages/local-extract/cli.js`. When
the row sets no `extractCli`, the default is resolved in this order:

1. the sibling checkout (`<bundle>/../../packages/local-extract/cli.js`) — folder installs;
2. the installed `@shypie_privacy/local-extract` package — npm installs (`0.2.1+` declares it as a
   dependency and the package exports `./cli.js`);
3. nothing — the tools then fail with *"extractCli is not configured and
   @shypie_privacy/local-extract is not installed"* instead of spawning a path that cannot exist.

Two other settings decide whether a document is readable at all: `allowPaths` (`[]` denies
**every** path) and `maxExtractChars`. Set them in the row config and remember that a row `config`
replaces the whole block, so restate the other keys:

```yaml
- id: privacy-gate
  config:
    allowPaths: ['C:\Users\<you>\Documents\privacy-work']
    extractCli: 'C:\Users\<you>\Documents\ShyPie\packages\local-extract\cli.js'
    detectors: []
    personWords: []
    blockNonTextResults: true
    audit: { enabled: true, path: 'C:\Users\<you>\.dsh\privacy\audit.jsonl' }
    placeholderKey: { file: 'C:\Users\<you>\.dsh\privacy\placeholder.key' }
```

## Tools

```
privacy_extract { path, mode?: pdf|doc|auto, max_chars?, pages?, lang? }
privacy_ocr     { path, max_chars?, pages?, lang? }
privacy_scan    { text }
privacy_rehydrate { text, artifact_path }   -> { path, replaced, kinds }
privacy_session { action: status|enable|disable } -> { scope, enabled, explicit, sessionId }
```

The first four return masked text or throw. `privacy_rehydrate` never returns a value,
only a path and counts (the interface contract round-trip rule).

`privacy_session` is the per-session switch: `status` is always allowed, `enable` opts the current
session in, and `disable` is refused unless the deployment sets `allowAgentDisable: true` — a
prompt-injected instruction must not be able to turn the gate off by itself. It acts on
`exec.agent.id`, the same `SessionId` the gates read, and records only an id and a boolean.

## Tests

```
node --test                     # 154 tests, no network, synthetic fixtures only
node scripts/vendor-core.mjs --check   # vendor copy is current
node scripts/activation-check.mjs      # needs @deepseek-ai/schemastery resolvable
```

`test/integration-core.test.mjs` runs the gates and tools against the **real
vendored `pii-core`**; the other suites use a fake redactor with the same
contract shape.

## Residual exposure (read this before claiming "no PII leaves the machine")

1. **Raw prompt text stays in the local session log.** `agent/pre-step` masks the
   `user/message` event and every request derived from it, but the prompt was
   already durably logged by `agent/inbox/spliced` before the step boundary, and
   there is no pre-append hook. Research note §5b proves it does **not** re-enter
   any request on fresh/resume/fork/replay, so it is local-only — but it is local
   plaintext in that session's JSONL.
2. **History logged before the gate was active is replayed as-is.** The gate does
   not rewrite existing events.
3. **A tool result's `meta` on an *error* result cannot be rewritten** by
   `tools/post-execute` (only a successful result can be re-derived through
   `value`). A third-party tool that puts plaintext into an error `meta` keeps it
   in the local log.
4. **`read_image` is denied, not converted.** A *tool* that wants to look at a
   file cannot be served by the prompt-side OCR (which only sees the user's
   attachments); use `privacy_ocr` for text.
5. **An OCR'd attachment loses its layout.** The model gets the extracted text
   (masked), not the picture: tables, stamps and handwriting may be misread, and
   nothing re-attaches the image later. Send the document to a model declared
   local if the bytes themselves matter.
6. **`privacy_rehydrate` is session-scoped.** `restore()` only resolves values
   masked by that same redactor instance; cross-restart restore would need
   `pii-core`'s encrypted vault, which this bundle does not wire up.
