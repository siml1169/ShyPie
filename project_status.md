# Project status — ShyPie privacy-first workflow

**Last updated:** 2026-11-06
**Scope:** the whole project — the DeepSeek Harness bundle, the Magpie middleware, the shared
libraries, publication and marketplace state.
**Update this file after every package release, PR merge, or marketplace change.**

## 1. The initial goal (the contract)

The project started from this brief:

> Design a privacy-first workflow as a plugin combo for **DeepSeek Harness (DSH) + Magpie** — with
> PII masking in mind, all PII stays local and is masked if it has to be sent to LLM providers.
> PDF and OCR tool use should be local and converted to text locally; if that is not possible,
> block the data transfer.

In one sentence: **convert and mask locally, and fail closed when a local layer cannot do it.**

The working model after the filter-mode redesign is narrower:

- **DSH ShyPie** is the conversation entry point: it extracts images/PDFs locally, keeps the local
  transcript readable by default, blocks unmaskable content, and enforces the provider allowlist.
- **Magpie ShyPie** is the gateway structural gate: it rejects or withholds binary content, and
  **Magpie's built-in Privacy masking** does the text masking.

## 2. Alignment verdict

The goal is **implemented and verified on the reference machine**, and the main distribution steps
have moved forward:

- the local ingestion half is published and live-tested;
- the Magpie egress half is **merged in-tree** at magpie-community/plugins (`28108dd`) and awaits its
  first community npm publish;
- the DSH catalog entry is **merged**;
- the DSH **source** now includes filter mode, image/PDF attachment extraction and the composer
  switch, but `0.3.0` is not published yet;
- the legacy personal-scope npm package is retired in the docs but its npm deprecation is still
  pending;
- one Magpie guide-mode metadata issue is open ([#795](https://github.com/magpie-community/plugins/issues/795)).

This is a **best-effort privacy design, not an absolute guarantee**. The named residuals in
[docs/design.md §12](docs/design.md#12-known-limitations) remain part of the status.

## 3. Goal → implementation → evidence

| Initial requirement | How it is implemented | Evidence | Status |
|---|---|---|---|
| **PII stays local and is masked before it reaches an LLM** | `pii-core` detectors + keyed placeholders; default `textPolicy: filter` keeps raw local text while Magpie's Privacy masking masks the gateway text path; `mask` restores local redaction; DSH Gate 1/3 and `llm/stream` enforce the filter | `pii-core` 61 top-level tests (60 pass, 1 platform skip); DSH gate 154/154; e2e 11/11; live DSH + Magpie runs | Met for the documented scope; free-text names, the raw submitted prompt and Magpie's masking journal remain named residuals |
| **PDF / Office / OCR conversion is local** | `local-extract` CLI and the DSH `privacy_extract` / `privacy_ocr` tools; images/PDFs attached to a DSH message are converted before logging; `pdftotext`/`pdftoppm`/`pdfinfo`, Windows `Windows.Media.Ocr`, optional tesseract adapter | `local-extract` 49/49; DSH 154/154 includes OCR plus PDF/file attachment tests; measured scan OCR ~0.65–0.78 s for 2 pages, ~2.9–3.3 s full CLI; all block reasons tested | Met on Windows; no cloud converter is ever called |
| **If local conversion or masking is impossible, block the transfer** | DSH tool errors and guards fail closed; the DSH `llm/stream` guard blocks before dispatch; Magpie returns 403 for binary parts/blobs/disallowed models by default, or withholds binary parts in guide mode; `onProvider` blanks content when it cannot reject | Magpie 62 in-tree cases; live image 403; guide-mode image withheld with HTTP 200; model-allowlist live 403; vendor-signature replays 200 | Met; the bounded text scan, engine timeout fail-open and the open guide-MIME issue are documented limits |
| **DSH + Magpie plugin combo** | DSH host bundle (`@shypie_privacy/dsh-privacy-gate`) plus Magpie gateway middleware (`@magpie-community/middleware-privacy-gate`) | DSH bundle installs into `headless` and `desktop` profiles; live two-turn DeepSeek and Copilot sessions; merged middleware loaded in a live Magpie gateway | Met in code; Magpie package is merged in-tree but not yet on npm |
| **A usable, maintained distribution** | ShyPie npm packages published (`dsh-privacy-gate` at `0.2.0`, others at `0.1.0`); DSH source `0.3.0` pending publish; Magpie middleware merged in-tree at `28108dd`; DSH catalog PR #12308 merged; tag `v0.2.0` | `npm view` for the packages; [PR #685](https://github.com/magpie-community/plugins/pull/685); [DSH catalog PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308); this repository's tags | Partial: Magpie npm publication and DSH `0.3.0` publication are pending |
| **Honest limits, not a false guarantee** | design §12, security review with resolution table, bounded-scan/summary wording, explicit "does not mask text" scope | [docs/design.md](docs/design.md), [docs/research/security-review.md](docs/research/security-review.md), Magpie registry summary | Met; see §6 for open items |

## 4. Component status

| Component | Version / source | Distribution | State |
|---|---|---|---|
| `@shypie_privacy/pii-core` | `0.1.0`, `packages/pii-core` | npm published | ✅ |
| `@shypie_privacy/local-extract` | `0.1.0`, `packages/local-extract` | npm published | ✅ |
| `@shypie_privacy/dsh-privacy-gate` | `0.3.0` source, `plugins/dsh-privacy-gate` | npm `0.2.0` published; `0.3.0` pending publish | ✅ filter mode, image/PDF extraction, composer switch, stable egress code; 154/154 tests |
| `@magpie-community/middleware-privacy-gate` | `0.1.0` source, `packages/privacy-gate` on magpie-community/plugins `main` | merged in-tree at `28108dd`; npm not published | ✅ registry merged, 62 cases; npm publish pending |
| legacy `@shypie_privacy/magpie-privacy-gate` | `0.1.0`, `plugins/magpie-privacy-gate` | npm published; legacy source still in ShyPie | 🟡 stage reject/deprecate pending |
| marketplace entries | `marketplace/magpie/registry-entry.json`, `marketplace/dsh/…yml` | Magpie PR #685 merged; DSH catalog PR #12308 merged | ✅ both merged |
| brand assets | `assets/brand/shypie/` | SVG + PNG + favicon + platform exports | ✅ source-of-truth vector package |

## 5. Verification snapshot

### Automated

- `pii-core`: 61 top-level tests, 60 pass, 1 platform skip.
- `local-extract`: 49/49.
- `dsh-privacy-gate`: 154/154; activation check registers **3 listeners, 1 guard, 5 tools**.
- `e2e`: 11/11.
- Magpie middleware: **62 cases** in `packages/privacy-gate/cases.json`; `bun scripts/check.mjs`
  validates the merged registry. Measured in moejs: 2,000 tool turns / 3.5 MB / ~40k values = 76 ms
  (403 at cap); 200 turns / 350 KB = 38 ms (pass); guide-mode bound and protocol-site cases added.

### Live (reference machine, 2026-11-03/06)

- DSH 0.2.1-rc.5 headless with the bundle installed from npm; a two-turn DeepSeek session through a
  live Magpie gateway.
- **2026-11-05, new workspace session (`session-a430510a`):** DSH read a synthetic fixture through
  the `read` tool; the persisted tool result and `session.v4` events contain placeholders for email,
  IBAN, phone and card and **no raw values**. The free-text name `Alex Example` remained, matching
  the documented PERSON/free-text residual. Magpie recorded a 200 for `deepseek-flash`.
- **2026-11-05, filter mode (`session-909d6a95`):** a synthetic email and IBAN stayed raw in the
  local transcript (by design); Magpie returned 200. This verifies the DSH filter + Magpie masking
  split.
- **2026-11-05, fail-closed session (`session-422c5754`):** with
  `egressAllowProviders: ["definitely-not-magpie"]`, the new turn failed with
  `code: PRIVACY_EGRESS_BLOCKED`; Magpie's usage row did not change.
- **2026-11-05, Magpie direct:** image and 600-char base64 requests each returned 403 permission
  errors without reaching a provider.
- **2026-11-06, guide mode merged:** an image request returned HTTP 200 with the image withheld;
  the model asked how to process it locally. The malicious-`allowModels` guard returned 403 in the
  live gateway.
- Copilot-routed OpenAI Responses `encrypted_content` (5,208 chars) and Anthropic thinking
  `signature` (892 chars) replayed through the live gateway and returned HTTP 200.
- Magpie engine fail-open confirmed ([`yetone/magpie#5305`](https://github.com/yetone/magpie/issues/5305)):
  `requestLimit` is 250 ms and a timed-out `onRequest` is logged, then the request continues
  unchanged. Reproduced with a 3.59 MB / 60k-message body at `maxNodes: 500000`: the log said
  `onRequest: took too long`, the gate did not answer, and the request reached the upstream (400 for
  the deliberately invalid model). At the default `maxNodes: 40000`, a 30k-message body returned
  403 in 0.21 s wall and 200k 400-char runs in 0.015 s, so the measured issue bodies no longer time
  out — but a slower host or a body under a raised budget can still fail open.
- A DSH headless session patched to `copilot/gpt-6.1-sol` resumed a second turn through the same
  gateway.
- DSH egress guard live: a provider-allowlist denial made the turn fail with
  `privacy-gate: egress blocked (PROVIDER)` and Magpie received no request; a normal turn completed
  with `EGRESS-OK` through the same profile.
- Not exercised: the DSH GUI session, real streaming paths against a real upstream, and CI live tests.

## 6. Open items / blockers

1. **Magpie engine fail-open on hook timeout** — [`yetone/magpie#5305`](https://github.com/yetone/magpie/issues/5305)
   is confirmed and not fixed by this project. The gate's budgets reduce the chance of a timeout but
   cannot turn an engine timeout into a rejection; the fix belongs in Magpie (gate declaration or a
   gate-specific budget).
2. **Magpie npm publication** — `@magpie-community/middleware-privacy-gate` does not exist on npm
   yet. The registry entry is merged; the community workflow must publish the package.
3. **Guide-mode MIME metadata** — [issue #795](https://github.com/magpie-community/plugins/issues/795):
   `guideMime` validates a 100-character clip rather than the whole value, so a long base64-like
   `media_type` can contribute a fake MIME prefix to the guide prompt. Still open; not a binary
   egress bypass.
4. **DSH `0.3.0` publication** — source includes filter mode, image/PDF extraction and the composer
   switch; npm `0.2.0` is still the published version, and `v0.2.0` is the current tag/release.
5. **Legacy npm cleanup** — the external `@shypie_privacy/magpie-privacy-gate` package is still
   installable and its `0.1.1` stage still exists. Both require an authenticated npm write:
   `npm stage reject a9792716-3890-46a2-ae6f-c92e0fcf3aae` and
   `npm deprecate "@shypie_privacy/magpie-privacy-gate@*" "…"`.
6. **ShyPie legacy middleware source** — `plugins/magpie-privacy-gate` is kept only as a legacy
   mirror; the canonical source is the merged in-tree package.
7. **GitHub releases** — `v0.1.1` and `v0.2.0` are tagged and released; `v0.2.0` is current.

## 7. Definition of done for the initial goal

- [x] Local document/OCR conversion with fail-closed blocking.
- [x] DSH ingestion filtering/extraction tools.
- [x] Magpie structural gate, including valid multi-turn vendor-signature replays.
- [x] `pii-core`, `local-extract`, `dsh-privacy-gate` published.
- [x] Magpie community package merged in-tree and registry entry merged.
- [x] Both marketplace listings merged.
- [ ] Magpie community package published on npm.
- [ ] DSH source `0.3.0` published and tagged.
- [ ] Guide-mode MIME issue fixed/closed.
- [ ] Legacy npm package rejected/deprecated.
- [x] GitHub release from `v0.2.0`.

## 8. Sources of truth

- Interfaces and residual limits: [docs/interface-contract.md](docs/interface-contract.md),
  [docs/design.md](docs/design.md).
- Install and verification: [docs/install.md](docs/install.md).
- Release, stage IDs and marketplace state: [docs/publish.md](docs/publish.md).
- Magpie submission: [PR #685](https://github.com/magpie-community/plugins/pull/685).
- Magpie guide-MIME issue: [issue #795](https://github.com/magpie-community/plugins/issues/795).
- Magpie engine timeout fail-open: [yetone/magpie#5305](https://github.com/yetone/magpie/issues/5305).
- Security review (historical + addendum):
  [docs/research/security-review.md](docs/research/security-review.md).
