# @shypie_privacy/dsh-privacy-gate

A DeepSeek Harness **Host bundle** that keeps PII on this machine. It masks at
**ingestion**, because DSH's outbound request is a deep-frozen fold of the session
log and cannot be rewritten on the way out — see
[`../../docs/research/dsh-hooks.md`](../../docs/research/dsh-hooks.md) §4.

## What it does

| Gate | Seam | Behaviour |
|---|---|---|
| 1 — tool ingress | `tools/post-execute` (waterfall) | Every tool result's text is masked with `pii-core` before the loop appends `tool/result`. A success result is sanitized through `value` so the logged `meta` is re-derived from masked data. Binary payloads (`BLOB`) and image/file content are **blocked**, never forwarded. `next()` is returned untouched when nothing changed. |
| 2 — local extraction | `privacy_extract`, `privacy_ocr`, `privacy_scan` | PDF/Office/image text is produced by the local CLI (`packages/local-extract/cli.js`), masked here, and only then returned. A blocked conversion (`NO_LOCAL_OCR`, `NOT_A_DOCUMENT`, …) is a tool **error**, never content. |
| 3 — user ingress | `agent/pre-step` (waterfall) | User text is masked and the masked messages are what the loop appends as `user/message`; a step carrying an image or file part is **rejected**. |
| Guards | `ctx.tools.guard()` | Denies `read_image` outright, and denies `read` of binary/document extensions outside `allowPaths`. |
| Round trip | `privacy_rehydrate` | Resolves placeholders **inside the tool**, writes the plaintext to a local artifact, and returns only `{ path, replaced, kinds }`. |
| Extra (defensive) | `tools/ptc-dispatch-log` | Masks the durable log copy of `run_code` sub-dispatches. |

## Files

```
index.js             apply()/Config/inject — the bundle entry point
lib/config.js        pure config resolution (frozen, unknown keys fail)
lib/paths.js         pure path predicates used by the guard
lib/redact.js        pure content/message/value masking over the pii-core API
lib/gate.js          the gates as pure decision shapers + installGates()
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
(`privacy-gate`). Packages shipped with dsh resolve from the dsh installation,
so no dependencies are declared. Do **not** hand-edit the profile's
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
extractCli: ''                # defaults to ../../packages/local-extract/cli.js
audit: { enabled: false, path: '' }   # JSONL, kind/length/count/path_hash/ts only
placeholderKey: { file: '' }  # defaults to ~/.dsh/privacy/placeholder.key, created 0600
blockNonTextResults: true     # block tool results containing image/file blocks
artifactDir: ''               # defaults to ~/.dsh/privacy/artifacts (privacy_rehydrate target)
toolTimeoutMs: 120000
maxExtractChars: 200000
```

There is no `failClosed` switch: the gate always fails closed.

`failClosed` is not a setting — failing closed is the only mode: if `vendor/pii-core.js` cannot load,
the key file is unusable, a redactor throws, or a document path is outside `allowPaths`, the gates
block tool results, reject prompt steps, and the four tools throw. Nothing falls through.

## Tools

```
privacy_extract { path, mode?: pdf|doc|auto, max_chars?, pages?, lang? }
privacy_ocr     { path, max_chars?, pages?, lang? }
privacy_scan    { text }
privacy_rehydrate { text, artifact_path }   -> { path, replaced, kinds }
```

All four return masked text or throw. `privacy_rehydrate` never returns a value,
only a path and counts (the interface contract round-trip rule).

## Tests

```
node --test                     # 81 tests, no network, synthetic fixtures only
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
4. **`read_image` is denied, not converted.** Image content cannot be masked, so
   the only fail-closed choice is refusal; use `privacy_ocr` for text.
5. **`privacy_rehydrate` is session-scoped.** `restore()` only resolves values
   masked by that same redactor instance; cross-restart restore would need
   `pii-core`'s encrypted vault, which this bundle does not wire up.
