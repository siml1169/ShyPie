# ShyPie — privacy-first workflow for DeepSeek Harness + Magpie

> Keep PII on your machine: documents are converted to text **locally**, recognised PII is replaced
> with stable placeholders **before it can enter the session log**, and anything that cannot be
> masked locally is **blocked**, not sent.

This repository is a reference implementation of a two-plugin combo for
[DeepSeek Harness](https://github.com/deepseek-ai) (DSH) and [Magpie](https://usemagpie.ai):

| Component | npm package | Role |
|---|---|---|
| [`plugins/dsh-privacy-gate`](plugins/dsh-privacy-gate) | `@shypie_privacy/dsh-privacy-gate` | DSH host bundle: redacts tool output and document text at **ingestion**, provides local `privacy_extract` / `privacy_ocr` / `privacy_scan` / `privacy_rehydrate` tools, and guards binary reads |
| [`plugins/magpie-privacy-gate`](plugins/magpie-privacy-gate) | `@shypie_privacy/magpie-privacy-gate` | Magpie gateway middleware: a structural egress firewall that rejects content Magpie cannot mask (images, files, encoded blobs) for non-local models |
| [`packages/pii-core`](packages/pii-core) | `@shypie_privacy/pii-core` | Zero-dependency detector + keyed-placeholder library shared by both plugins |
| [`packages/local-extract`](packages/local-extract) | `@shypie_privacy/local-extract` | Local-only PDF / Office / scan → text CLI with fail-closed blocking |

The two plugins are prepared for the **Magpie** and **DeepSeek Harness** plugin markets; they are
not published yet. Package metadata, the MIT license, and both marketplace submission files are in
place — [docs/publish.md](docs/publish.md) is the checklist.

It is a **privacy-first workflow**, not a guarantee: what it protects, and what it cannot, is
documented precisely in [docs/design.md](docs/design.md) and summarised below.

## Why two plugins

1. **DSH's outbound request is immutable.** It is a deep-frozen fold of the session log
   (`dsh-agent-loop`, `markAgentLoopRequest`), so a plugin cannot rewrite it on the way out the way
   Magpie does for other agents. Masking must happen **at ingestion** — before bytes become part of
   the history that is replayed on every turn.
2. **Magpie's masking is text-only.** Its own documentation says *"Images and file data are sent as
   they are. Text inside a screenshot is not masked."* A gateway can never mask a PDF page or a
   screenshot, so the gateway must **reject** what it cannot mask.

The DSH gate covers what enters the session log; the Magpie gate covers every other agent behind the
gateway (Cursor, Copilot, Claude Code, scripts).

## Architecture

```
user text / attach ─► Gate 3  ingress redaction ─────────────┐
                                                             ▼
tool call ──────────► tool ─► Gate 1 tool-result redaction ─► session log (placeholders)
(read/pwsh/MCP)                ▲                             │
                               │                             ▼
pdf / scan / doc ───► privacy_extract / privacy_ocr ──► redact ──► placeholders
                        │ (local pdftotext / OS OCR)   │
                        └─ blocked ───────────────────► tool error (no data)
                                                             │
model output (placeholders) ─► privacy_rehydrate ─► local artifact
                                                             │
                                              LLM request (placeholders only)
                                                             ▼
                     ┌──────────────── Magpie gateway ─────────────────┐
                     │ text masking (built-in, local model)           │
                     │ privacy-gate middleware: rejects images, files, │
                     │ audio, encoded blobs, non-allowlisted models    │
                     └─────────────────────────────────────────────────┘
                                                             ▼
                                                       LLM provider
```

## What it protects

- **Tool and document ingress.** Every tool result is scanned by deterministic detectors before it
  is appended; PDFs, Office documents and scans are converted to text locally first.
- **Local conversion only.** Text layers use `pdftotext`; scans use `pdftoppm` plus a local OCR
  adapter (on Windows, the built-in `Windows.Media.Ocr` engine — no install, no network). If no
  local engine exists the call is **blocked** (`NO_LOCAL_OCR`), never sent to a cloud converter.
- **Un-maskable payloads are rejected**: base64/hex/`data:`-encoded documents (contiguous, line-
  wrapped or dump-formatted), image/file/audio parts to non-local providers, unknown binaries,
  encrypted PDFs.
- **Round-trip without exposing values.** `privacy_rehydrate` resolves placeholders inside the tool
  and returns only `{path, replaced, kinds}`; the model can fill a form without seeing the value.

## What it does not do

- **Free-text names** are outside deterministic detection (use the word list or a *local* classifier).
- **Transformed values** (reversed, re-encoded) are not detected; zero-width and soft-hyphen tricks are.
- **Detector false negatives** are possible; the design is layered (rules → local gateway model →
  fail-closed blocks) but not complete. Read [docs/design.md §12](docs/design.md#12-known-limitations).
- **Local at-rest residues** are named, not hidden: DSH records the raw submitted prompt before any
  plugin seam, and Magpie's masking journal keeps values for 30 days.
- **History predating installation** is replayed unchanged — start new sessions after installing.
- The plugins are **not installed by this repository**; installation changes profile-wide state and
  is documented step by step.

## Requirements

- Windows 10/11 (the OCR and path policy are Windows-first; the core libraries are portable).
- DeepSeek Harness with a configurable plugin profile, and Magpie running its local gateway.
- `pdftotext` / `pdftoppm` / `pdfinfo` on `PATH` for PDF text and scan rendering (poppler).
- Node.js 22+ for the test suite and CLI (the bundled DSH runtime works).
- Optional: `tesseract` (an adapter exists but is untested here).

## Quick start

Nothing is published yet, so install from this checkout today:

1. Install the Magpie middleware from the folder — see [`plugins/magpie-privacy-gate`](plugins/magpie-privacy-gate/README.md).
2. Install the DSH bundle through the plugin manager — see [`docs/install.md`](docs/install.md).
3. In Magpie, enable masking under **Settings → Privacy** (text half of the combo).
4. Start a **new** DSH session and run the checks in [docs/install.md](docs/install.md#verify).

Both plugins are reversible; no profile file is edited by hand. Once the packages are on npm, the
same steps become `magpie plugin add @shypie_privacy/magpie-privacy-gate` and
`dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate`; [docs/publish.md](docs/publish.md) covers
that path and the two marketplace listings.

## Verify

```bash
node tests/run-all.mjs
```

Measured on the reference machine (Windows 11, Node 24, no network):

| Suite | Result |
|---|---|
| `pii-core` | 61 tests, 60 pass (1 platform skip); 50,125-char doc with 2,133 hits redacts in 11.5 ms; 300k-digit run 40 ms |
| `local-extract` | 49/49; text PDF, Office, local OCR, and all documented block reasons |
| `dsh-privacy-gate` | 86/86; activation check registers 3 listeners, 1 guard, 4 tools |
| `magpie-privacy-gate` | 49/49 in a `node:vm` sandbox with only `console` (proves the moejs constraint) |
| `e2e` | 11/11 — synthetic invoice → local text → placeholders → gateway → mock vendor, with zero plaintext on the wire |

The end-to-end suite uses only synthetic fixtures generated at test time. No real document, invoice,
identity paper or personal record is present in this repository.

## Repository layout

```
docs/
  design.md               design, threat model, gates, fail-closed matrix, limitations
  install.md              installation and verification guide
  interface-contract.md   frozen API / CLI / tool interfaces
  publish.md              npm publish order + Magpie and DSH marketplace listings
  research/               evidence: DSH seams (path:line), Magpie hook docs (URL + quote),
                          detector catalogue, measured engine matrix, background, security review
packages/
  pii-core/               detectors, keyed placeholders, encrypted vault
  local-extract/          local-only PDF / Office / OCR to text
plugins/
  dsh-privacy-gate/       DeepSeek Harness bundle
  magpie-privacy-gate/    Magpie gateway middleware
marketplace/              submission files for the two plugin markets (not yet submitted)
config/                   example Magpie middleware options
tests/                    end-to-end tests and the one-command runner
LICENSE                   MIT
```

## Documentation

- [Design](docs/design.md) — the full design and threat model
- [Install](docs/install.md) — installation, configuration, verification
- [Interface contract](docs/interface-contract.md) — the stable interfaces both plugins implement
- [Publish](docs/publish.md) — npm release order and the Magpie / DSH marketplace listings
- [Research](docs/research/) — evidence notes, measurements and the [security review](docs/research/security-review.md)
- Component READMEs: [pii-core](packages/pii-core/README.md), [local-extract](packages/local-extract/README.md),
  [DSH gate](plugins/dsh-privacy-gate/README.md), [Magpie gate](plugins/magpie-privacy-gate/README.md)

## Status

Reference implementation, tested on one Windows machine. **Not published:** the npm packages, the
Magpie registry entry and the DSH catalog entry are prepared but unsubmitted — see
[docs/publish.md](docs/publish.md). The **live wiring** (loading the bundle into
a real DSH profile, loading the middleware into a real Magpie gateway) is written against the
documented APIs and the source evidence in [docs/research](docs/research/), but was not exercised in
this repository's test suite — exercising it changes profile-wide state. What is and is not verified
is listed in [docs/design.md §11](docs/design.md#11-verification).

Security issues: see [SECURITY.md](SECURITY.md).
