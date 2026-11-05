# Project status — ShyPie privacy-first workflow

**Last updated:** 2026-11-05
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

## 2. Alignment verdict

The goal is **implemented and verified on the reference machine**, but not fully distributed:

- the local ingestion half is published and live-tested;
- the Magpie egress half is finished, moved in-tree to magpie-community/plugins, and awaiting review
  and its first community release;
- the legacy personal-scope npm package is retired in the docs but still needs its registry
  deprecation/OTP cleanup;
- neither marketplace listing is live yet.

This is a **best-effort privacy design, not an absolute guarantee**. The named residuals in
[docs/design.md §12](docs/design.md#12-known-limitations) remain part of the status.

## 3. Goal → implementation → evidence

| Initial requirement | How it is implemented | Evidence | Status |
|---|---|---|---|
| **PII stays local and is masked before it reaches an LLM** | `pii-core` detectors + keyed placeholders; DSH Gate 1 redacts every tool result before append; DSH Gate 3 rewrites model-visible user text; Magpie's Privacy masking covers the gateway text path | `pii-core` 61 top-level tests (60 pass, 1 platform skip); DSH gate 86/86; e2e 11/11; live DSH + Magpie runs | Met for the documented scope; free-text names, the raw submitted prompt and Magpie's masking journal remain named residuals |
| **PDF / Office / OCR conversion is local** | `local-extract` CLI and the DSH `privacy_extract` / `privacy_ocr` tools; `pdftotext`/`pdftoppm`/`pdfinfo`, Windows `Windows.Media.Ocr`, optional tesseract adapter | `local-extract` 49/49 tests; measured scan OCR ~0.65–0.78 s for 2 pages, ~2.9–3.3 s full CLI; all 8 block reasons tested | Met on Windows; no cloud converter is ever called |
| **If local conversion or masking is impossible, block the transfer** | DSH tool errors and guards fail closed; Magpie middleware returns 403 for binary parts, blobs, disallowed models, and blanks content in `onProvider` when it cannot reject | Magpie 33 in-tree cases; live image 403; model-allowlist live 403 for DSH and Copilot; vendor-signature replays 200 after the exemption fix | Met; the bounded text scan and pre-uploaded Files-API references are documented residual limits |
| **DSH + Magpie plugin combo** | DSH host bundle (`@shypie_privacy/dsh-privacy-gate`) plus Magpie gateway middleware (`@magpie-community/middleware-privacy-gate`) | DSH bundle installs into `headless` and `desktop` profiles; live two-turn DeepSeek and Copilot sessions; middleware loaded in a live Magpie gateway | Met in code; Magpie package is not yet published from its new home |
| **A usable, maintained distribution** | three ShyPie npm packages published at `0.1.0`; Magpie middleware in-tree in magpie-community/plugins (PR #685); tag `v0.1.1` | `npm view` for the three packages; [PR #685](https://github.com/magpie-community/plugins/pull/685); this repository's tag | Partial: Magpie community package and both marketplace listings are pending |
| **Honest limits, not a false guarantee** | design §12, security review with resolution table, bounded-scan/summary wording, explicit "does not mask text" scope | [docs/design.md](docs/design.md), [docs/research/security-review.md](docs/research/security-review.md), Magpie registry summary | Met; see §5 below for what is still not true |

## 4. Component status

| Component | Version / source | Distribution | State |
|---|---|---|---|
| `@shypie_privacy/pii-core` | `0.1.0`, `packages/pii-core` | npm published | ✅ |
| `@shypie_privacy/local-extract` | `0.1.0`, `packages/local-extract` | npm published | ✅ |
| `@shypie_privacy/dsh-privacy-gate` | `0.2.0` source, `plugins/dsh-privacy-gate` | npm `0.1.0` published; `0.2.0` pending publish | ✅ egress guard live-tested in DSH 0.2.1-rc.5 |
| `@magpie-community/middleware-privacy-gate` | `0.1.0` in PR #685, `packages/privacy-gate` on the PR branch | **in-tree, not yet published** | 🟡 waiting for review/merge; 43 cases pass |
| legacy `@shypie_privacy/magpie-privacy-gate` | `0.1.0`, `plugins/magpie-privacy-gate` | npm published; docs no longer reference it | 🟡 stage `0.1.1` and deprecation need npm OTP |
| marketplace entries | `marketplace/magpie/registry-entry.json`, `marketplace/dsh/…yml` | Magpie PR open; DSH entry ready | 🟡 |

## 5. Verification snapshot

### Automated

- `pii-core`: 61 top-level tests, 60 pass, 1 platform skip.
- `local-extract`: 49/49.
- `dsh-privacy-gate`: 98/98, including the `llm/stream` egress guard.
- `e2e`: 11/11.
- Magpie middleware: **43 cases** in the in-tree `packages/privacy-gate/cases.json`; moejs measurement: 2,000 tool turns / 3.5 MB / ~40k values = 76 ms (403 at cap), 200 turns / 350 KB = 38 ms (pass); legacy ShyPie
  harness has 58 checks that predate the six site-scoping regressions.

`node tests/run-all.mjs` covers the ShyPie suites.

### Live (reference machine, 2026-11-03/04)

- DSH 0.2.1-rc.5 headless with the bundle installed from npm; a two-turn DeepSeek session through a
  live Magpie gateway.
- A temporary Magpie model allowlist rejected a DSH turn with the gate's 403; restoring it let the
  next turn through.
- Copilot-routed OpenAI Responses `encrypted_content` (5,208 chars) and Anthropic thinking
  `signature` (892 chars) replayed through the live gateway and returned HTTP 200.
- Magpie engine fail-open confirmed ([`yetone/magpie#5305`](https://github.com/yetone/magpie/issues/5305)):
  `requestLimit` is 250 ms and a timed-out `onRequest` is logged, then the request continues unchanged.
  Reproduced with a 3.59 MB / 60k-message body at `maxNodes: 500000`: the log said
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
   is confirmed, not fixed by this project. The gate's budgets reduce the chance of a timeout but
   cannot turn an engine timeout into a rejection; the fix belongs in Magpie (gate declaration or a
   gate-specific budget).
2. **Magpie PR #685** — open, awaiting re-review/merge. The in-tree package has the site-scoped
   signature/role/type exemption, newest-first text budget, linear blob scan, primitive/array value bound, per-field text share, 43 cases, and is rebased on current `main` (`2d16b15`).
3. **Magpie npm publication** — `@magpie-community/middleware-privacy-gate` does not exist on npm
   yet; it publishes only after the PR merges through the community workflow.
4. **Legacy npm cleanup** — the external package `@shypie_privacy/magpie-privacy-gate` is still
   installable and its `0.1.1` stage still exists. Both writes need a fresh npm OTP:
   `npm stage reject a9792716-3890-46a2-ae6f-c92e0fcf3aae` and
   `npm deprecate "@shypie_privacy/magpie-privacy-gate@*" "…"`.
5. **DSH catalog** — the entry is ready; the repository now meets the one-day-age requirement, but
   the awesome-dsh-plugin PR has not been opened.
6. **GitHub release** — tag `v0.1.1` exists; no release has been created from it.
7. **ShyPie legacy source** — `plugins/magpie-privacy-gate` is kept only so the folder install
   works until the community package publishes; remove or archive it afterwards.

## 7. Definition of done for the initial goal

- [x] Local document/OCR conversion with fail-closed blocking.
- [x] DSH ingestion redaction and local extraction tools.
- [x] Magpie structural gate, including valid multi-turn vendor-signature replays.
- [x] `pii-core`, `local-extract`, `dsh-privacy-gate` published.
- [ ] Magpie community package merged and published.
- [ ] Both marketplace listings live.
- [ ] Legacy npm package rejected/deprecated.
- [ ] GitHub release from `v0.1.1`.
- [ ] DSH bundle `0.2.0` (egress guard) published.
- [ ] ShyPie legacy middleware source removed after the community package publishes.

## 8. Sources of truth

- Interfaces and residual limits: [docs/interface-contract.md](docs/interface-contract.md),
  [docs/design.md](docs/design.md).
- Install and verification: [docs/install.md](docs/install.md).
- Release, stage IDs and marketplace state: [docs/publish.md](docs/publish.md).
- Magpie submission: [PR #685](https://github.com/magpie-community/plugins/pull/685).
- Magpie engine timeout fail-open: [yetone/magpie#5305](https://github.com/yetone/magpie/issues/5305).
- Security review (historical + addendum):
  [docs/research/security-review.md](docs/research/security-review.md).
