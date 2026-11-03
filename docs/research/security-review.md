# Security review — adversarial audit of the workflow

**Reviewer:** an independent adversarial reviewer (not one of the implementers). **Date:** 2026-11-02.
**Scope:** the whole repository — claims, code, tests, repo hygiene. **Read-only**: this file is the only
thing written; the shipped suites were executed to check the "all suites pass" claim, plus targeted
probes (below).

> **Reading note.** This is the review of the pre-release revision, kept as written so the findings stay
> auditable. After it, the repository was restructured for publication — the design, interface and install
> documents moved into `docs/`, the evidence notes into `docs/research/`, and the working titles
> `red-team-review.md` / `originating-session.md` became `security-review.md` / `background.md` — and
> machine-specific paths were replaced with placeholders. Line numbers in `file:line` references are those
> of the reviewed revision; the resolution section records what changed.

> **Post-publication update (2026-11-03).** The repository is now published at `0.1.0` and tagged
> `v0.1.1`; the Magpie middleware was loaded into a live Magpie gateway and exercised with DSH
> 0.2.1-rc.5 headless (two-turn DeepSeek session; a temporary model-allowlist block was rejected by the
> gate). Current top-level suite counts: pii-core 61 (60 pass, 1 skip), local-extract 49, dsh gate 86,
> Magpie harness 58, e2e 11. In 0.1.1 vendor-sealed signature/id fields are exempt only inside their
> vendor block, and `ctx.reject` is called with the hook returning immediately — magpie's host performs
> the rejection and returns nothing, so the return value is not consulted.

**What was not done (and why):** no live DSH profile, no live Magpie gateway (away from a user's machine),
no user documents/PII trees read, no installs, no network. Consequences are marked **UNVERIFIED** where
they matter. Probes that were executed are marked **measured**.

**Bottom line.** The deterministic core is real, the local extraction really is local, the tests really
pass — but the headline guarantee ("PII never reaches a provider", "only placeholders leave the machine",
"fails closed") is **overstated in four independent ways**, two of which are measured end-to-end on the
repository's own synthetic invoice. This is a strong *best-effort* design; it is not yet the absolute
guarantee the README sells. Findings below are ordered by severity inside each section; every one has
`file:line`.

---

## 1. Claims audit

Twelve specific claims, each marked. "Measured" means a command was run in this session (appendix A).

| # | Claim (source) | Verdict | Evidence / counter-evidence |
|---|---|---|---|
| C1 | "**Only placeholders leave the machine.**" (`README.md:29`) | **OVERSTATED — blocker** | False for document bytes: base64 of the repo's own 1013-byte invoice (1352 chars, mixed alphabet) is **allowed by both gates** (measured; see B1). False for any detector miss (free-text names, `design.md:462-469`), for transformed text (B4), and for `pwsh` network egress (phase 2, `design.md:508-509`). The accurate statement is "placeholders *that the detectors recognised*". |
| C2 | "**The session log holds placeholders**, so every replay, export, spill file, subagent and provider hop carries placeholders." (`README.md:31-32`) | **OVERSTATED — high** | True for tool results (Gate 1) and `user/message` (Gate 3), verified in code (`plugins/dsh-privacy-gate/lib/gate.js:66-154`; append-after-post-execute `dsh-agent-loop/lib/index.js:691-707`). False for: raw prompt (`agent/inbox/spliced`, correctly named), and for anything Gate 1 cannot see — wrapped/hex/small base64 and undetected values are written to the log verbatim (measured, B1/B2). The claim is conditional, the README states it unconditionally. |
| C3 | "**Anything that cannot be masked locally is blocked**" (`README.md:35-37`), "encoded blobs" blocked (`README.md:36`) | **OVERSTATED — high** | Only four content block types are blocked (`lib/redact.js:17,112-115`); every other non-text block type is passed through untouched. Blob thresholds are trivially small-document-sized: base64 ≥2048 chars / hex ≥1024 **contiguous** (`packages/pii-core/index.js:604-605,638-668`; `gate.middleware.js:212-217`) — the repo's own 1013-byte invoice escapes both (B1). `dsh-hooks.md:191` explicitly claims "a shell cat/base64 dump is caught by the BLOB rule on its result" — **disproved** for a one-page text PDF. |
| C4 | "**Nothing in the detector path touches the network / no cloud fallback in any code path**" (`README.md:29-30,35-37`) | **VERIFIED** | No `fetch`/`http(s)`/`net`/`dns`/`WebSocket` in shipped `*.js/*.mjs/*.ps1/*.py`; only `child_process.spawn` of local binaries (`packages/local-extract/engines.js:15,102-143`, `plugins/dsh-privacy-gate/lib/extract.js:13,99`). Extractor blocks instead of falling back (`cli.js:416-427`; all 8 reasons tested). Caveat: this claim covers the *extractor*, not the agent's `pwsh`, which can reach the network (B10). |
| C5 | "**Fails closed**" — Magpie gate (middleware comment `gate.middleware.js:28-30`; `magpie-privacy-gate/README.md:10-17`; `design.md:306-311`) | **UNVERIFIED — high risk** | `onRequest` returns whatever `ctx.reject()` returns (`gate.middleware.js:541-545,573`). If `ctx.reject` returns `undefined`, the hook's return value is exactly the documented "nothing = send it on as it was" (`magpie-hooks.md:49`; the worked example returns
`ctx.reject` at `51`; measured: `onRequest` → `undefined`). The harness invents a sentinel (`test/harness.mjs:73-83`); the e2e helper treats `undefined` as **allowed** (`tests/e2e/e2e.test.mjs:59-60`). No live-gateway test exists. `design.md:450-451` admits the middleware was never run in a real gateway — but the README still asserts "fails closed" as fact. |
| C6 | "**Reads of binary/document files outside `allowPaths` are denied**" (`design.md:279-283,353`; `dsh-hooks.md:189-196`) | **FALSE for traversal + unguarded tools — high** | `normalizeForCompare` does not collapse `..` (`lib/paths.js:23-30`) and `isWithinPath` is a string prefix test (`paths.js:33-38`). Measured: `isPathAllowed("C:\\allowed\\..\\..\\Users\\x\\secret\\invoice.pdf", ["C:\\allowed"]) === true`. `privacy_extract` never consults `allowPaths` at all (`lib/tools.js:150-162`; `lib/extract.js:27-37,99` — no `PRIVACY_EXTRACT_ALLOWED_ROOT`), and `gate.test.mjs:151` asserts that bypass as intended. Only `read`/`read_image` are guarded (`gate.js:42-56`); `grep`/`glob`/`pwsh`/`str_replace_editor` are not. |
| C7 | "**Round-trip works without exposing values** … if the agent reads the artifact back, the design is idempotent by construction" (`README.md:38-40`; `design.md:334-337`) | **PARTLY VERIFIED / OVERSTATED — medium** | Tool-level round-trip is real and tested against the real core (`plugins/dsh-privacy-gate/test/integration-core.test.mjs:80-100`). But "re-redacted on read" only covers values *the detectors recognise*: free-text names and uncatalogued data in the artifact are re-sent by `read` (B8/B13). The artifact itself is plaintext on disk, path returned to the model (`tools.js:224-257`). |
| C8 | "**All suites pass**" (`README.md:73-81`; `design.md:3,432-451`) | **VERIFIED** | `node tests/run-all.mjs` → 5/5 PASS, exit 0. Reproduced counts: pii-core 50 tests/49 pass/1 platform skip (`vault.test.js:75`), local-extract 49/49, dsh gate 81/81, magpie harness 44/44, e2e 9/9. Caveat: the e2e "9/9" includes a conditional early-return that can silently pass (T3). |
| C9 | "**17 deterministic detectors … handle 50k-char texts without pathological backtracking**" (`docs/interface-contract.md:140`; `pii-detectors.md:96-105`) | **PARTLY / misleading — medium** | No catastrophic regex was found; but the claim is tested only on a synthetic padded doc (`test/perf.test.js:14-41`). Measured worst case: 50,000 pure digits → **62 ms warm best** (budget 50 ms); 300,000 digits → 437 ms. Cause: `CARD` scans 13..19-digit candidates at every start of every digit run (`index.js:797-845`, especially 824-843). The note's "bounded by a constant, not by document length" omits that the constant is ~130 ops/char. |
| C10 | "**grep, glob and MCP tools are all covered by `tools/post-execute`**" (`design.md:164,252-256`; `dsh-hooks.md:25-40`) | **VERIFIED — no issue** | MCP tools are registered through the ordinary registry (`dsh-mcp-client/lib/index.js:153`: `ctx.tools.register(definition)`), and every dispatch runs `postExecute` (`dsh-tools/lib/index.js:3503-3504`). The other shipped listeners on this event honour the gate's decision: `dsh-tool-fs-search` only re-renders when the decision has neither `value` nor `content` (`lib/index.js:848-863,1159-1178` + `acceptedDirectCallValue`), `dsh-spill-policy` derives from `decision.content ?? result.content` and skips when `value` is present (`lib/index.js:237-255`), `dsh-repeat-tool-reminder` spreads the downstream decision (`lib/index.js:1577-1590`). `finalizeContent` does run after the gate (`dsh-tools/lib/index.js:3391,3399-3406`) but only `dsh-tool-jobs` defines one; on success the gate replaces `value`, so its re-derivation comes from redacted data. |
| C11 | "**The vault is encrypted (AES-256-GCM, key 0600)**" (`docs/interface-contract.md:39-40`; `design.md:206-209`) | **VERIFIED as a library, UNUSED by the bundle — low** | `vault.js` tests pass (ciphertext-only, tamper). But the DSH bundle never wires it: rehydrate is session-scoped and dies on restart (`dsh-hooks.md:249-252`; `tools.js:237-250`). Also `0600` is a no-op on Windows and the test skips there (`vault.test.js:75`). |
| C12 | "**The gateway stays the only route to a provider: every DSH provider entry points at 127.0.0.1:3425/v1**" (`design.md:397`) | **UNENFORCED CLAIM — medium** | Nothing in code checks this; it is a statement about the current profile. A second DSH provider entry (direct-to-vendor) bypasses Magpie entirely (`design.md:411` T7 is about *other agents*, not about a second DSH provider). With one layer gone: undetected values (names), small/wrapped blobs (B1) and `localModels`-style trust errors (B12) reach the vendor. |

Named-and-honest residuals that I confirmed rather than re-discovered: raw prompt in `agent/inbox/spliced`
(`design.md:86,423-428,493-495`), pre-install history/fork replay (`design.md:496-500`), free-text names
(`design.md:462-465`), Magpie masking journal (`design.md:416-421`), Files API (`design.md:481-483`),
Magpie's own side requests (`design.md:484-486`), `localModels` mirroring (`design.md:487-489`),
`onUsage`-not-loaded (`docs/research/magpie-hooks.md:56-61`).

---

## 2. Bypass analysis

Each entry: scenario → control that should have caught it → why it doesn't → severity. Measured items were
run against the shipped code.

### B1 — Small or line-wrapped base64 of a document passes **both** gates. **blocker**
Scenario: `pwsh "[Convert]::ToBase64String([IO.File]::ReadAllBytes('invoice.pdf'))"` (or a wrapped variant
from `certutil -encode`/`Get-Content -Encoding Byte` + format). The repo's own synthetic invoice (1013
bytes, text layer contains a literal IBAN) becomes 1352 contiguous base64 chars / 1373 chars wrapped at
64 columns.
Control: BLOB block in Gate 1 (`packages/pii-core/index.js:604-605`; `lib/redact.js:35-37,61-74`) and the
Magpie blob rule (`gate.middleware.js:271-289`).
Why not: base64 threshold is 2048 **contiguous** chars (docs, `pii-detectors.md:49`), hex 1024 contiguous;
`pii-core` has **no** line-wrapped heuristic; Magpie's wrapped heuristic only runs when `text.length >= 2048`
(`gate.middleware.js:280-289`, `221-235`) and its base64 regex needs one contiguous 2048-run. Measured:
contiguous 1352 → Magpie **ALLOW**, Gate 1 `accept` **unredacted**; wrapped (22 lines) → Magpie **ALLOW**,
`pii-core` hits **NONE**. The bytes of a PII-bearing document therefore enter the session log and the
outbound body as base64. `design.md:410` records only "threshold tuning" as the residual, not that a
one-page invoice is below it.

### B2 — `pwsh` hex dumps (e.g. `Format-Hex`) pass both gates. **high**
Scenario: `pwsh "Format-Hex invoice.pdf"` → ASCII hex pairs with offsets/spaces. Control: BLOB hex rule
(`index.js:659-668`) and Magpie hex regex (`gate.middleware.js:213`). Why not: both require ≥1024 *contiguous*
hex characters; `Format-Hex` interleaves spaces/addresses. Measured: Magpie **ALLOW**. Gate 1's `CARD`
detector over-matches some digit runs inside the dump (false-positive `{{CARD_…}}`), but the hex letters and
most bytes survive untouched.

### B3 — Reversible/Unicode transforms defeat both layers. **high**
Scenario: the model (or a document/OCR/copy-paste) presents the value reversed, letter-spaced, or with
zero-width characters. Control: deterministic detectors at ingestion (Gate 1/Gate 3) and Magpie's masker at
egress. Why not: both are shape-based on forward, normalized text; there is no normalization step (no NFKC,
no zero-width/soft-hyphen stripping) anywhere in `packages/pii-core/index.js`. Measured on Gate 1 with the
real core: `IBAN DE89…013000` reversed → unchanged; the same IBAN joined with U+200B → unchanged; `DE89 3704
0044 0532 0130 00` (normal spacing) → correctly masked. Zero-width/soft-hyphen characters are **common** in
text copied from PDFs/Word, so this is not only an adversarial case.

### B4 — Placeholder-shaped text suppresses detection of the value inside it. **medium**
Scenario: a document/tool output contains `{{DE136695976ABCDEFGH}}`. Control: all detectors (they run on
text before redaction). Why not: `findPlaceholderSpans` (`index.js:287-301,1230-1231`) excludes *any*
"tolerant" placeholder shape (fullwidth braces, any case, ≤48-char body whose last 8 chars are Base32 and
whose head is a kind-shaped token — `index.js:273,276-284`), and `resolveHits` drops every detector hit that
overlaps those spans (`index.js:1103-1125`). Measured: `USt-IdNr DE136695976` → `{{VATID_4TDGWXOH}}`;
`USt-IdNr {{DE136695976ABCDEFGH}}` → **no hits at all**. Works for values up to ~40 chars (IBAN-length
values exceed the 16-char kind regex and are safe). A document using `{{…}}` template syntax can hide
account/tax/ID numbers by accident.

### B5 — `toLowerCase()` index desync silently disables all context-anchored detectors. **medium**
Scenario: a single U+0130 (İ) or another character whose lower-case form changes length appears anywhere
before `Konto`/`Steuer`/`SSN`/`Pass`/`geb.`. Control: `scanContext` maps keyword offsets in `lower` back to
`text` (`index.js:461-493`, esp. 469-473; lower built at `1216-1221`). Why not: `String.prototype.toLowerCase`
can change length (U+0130 → 2 code units), so every subsequent offset is shifted by one: the window is cut
one character late and the value is missed (or a wrong span is masked). Measured: `"Konto 1234567890"` →
masked; `"İ Konto 1234567890"` → **no hits**. Affects TAXID, SSN, PASSPORT, IDCARD, DOB, ACCOUNT — i.e. the
context-anchored half of the catalogue.

### B6 — `allowPaths` is bypassable by `..` (reproduced) and irrelevant to Gate 2. **high**
Scenario: `read` of `C:\allowed\..\..\Users\me\secret\invoice.pdf`; or `privacy_extract` with any absolute
path at all. Control: the monotonic guard (`lib/gate.js:42-56`) and the tool's own path policy. Why not:
`normalizeForCompare` only rewrites separators/case and strips `./` (`paths.js:23-30`); `..` is never
collapsed, so `isWithinPath` returns true (measured). Symlinks/junctions inside an allowed root are likewise
not resolved (documented only obliquely at `dsh-hooks.md:240-241`). `privacy_extract`/`privacy_ocr` never
call `isPathAllowed` and the extractor's opt-in pin is never set by the caller (`lib/tools.js:150-162`;
`lib/extract.js:99` spawns with inherited env), so the "sanctioned" path is an unrestricted local file
reader whose output is redacted only by the (imperfect) detectors. `paths.test.mjs:19-31` has no traversal
case, so the suite is green.

### B7 — Text-file reads turn the documented *local* residuals into provider leaks. **medium-high**
Scenario: `read`/`grep` of the session JSONL (`agent/inbox/spliced` holds the raw prompt) or of Magpie's
masking journal (`values[].p`). Control: the design calls these "local at-rest residuals" and says they
never reach a provider (`design.md:423-428,493-495`); nothing gates them. Why not: the guard classifies only
binary/document **extensions** (`paths.js:8-20,55-57`); `.jsonl`, `.json`, `.csv`, `.log`, `.md`, `.env` are
always readable, and Gate 1 re-redacts only detector-recognised values — free-text names survive. The
statement "the model never receives it" is therefore conditional on the agent never reading the log, and the
gate does not enforce that. (This session's DSH file policy is `danger-full-access`; under a stricter
desktop sandbox the read may be blocked by DSH, not by this design.)

### B8 — Rehydrated artifact can be laundered by a detector miss. **medium**
Scenario: `privacy_rehydrate` writes plaintext to `<repo>/artifacts/…` and returns the path; the agent reads
it back (or copies it into a new file and reads that). Control: `design.md:334-337` ("re-redacted on read …
gets placeholders again"). Why not: re-redaction is only as good as the detectors; a name, an uncatalogued
number, or a value in a transformed shape comes back in plaintext and can be quoted into the next request.
Plaintext artifacts are also written under the repository tree by default (§4.3/§5).

### B9 — A second DSH provider entry bypasses Magpie, leaving one (imperfect) layer. **medium**
Scenario: the user adds a direct vendor provider in DSH settings; `allowModels`/`localModels` are irrelevant
because the request never reaches the gateway. Control claimed at `design.md:397` ("no direct-to-vendor path
to forget"). Why not: nothing in the bundle validates or monitors the profile; DSH requests then carry
whatever Gate 1/Gate 3 produced — including undetected names and B1/B2 payloads. The design's two-layer
argument silently degrades to one.

### B10 — `pwsh`/`bash` are a general egress and byte channel (named, but under-scoped). **medium**
`pwsh` can `curl`/`Invoke-WebRequest` a rehydrated artifact or raw file to the internet, or print bytes as
base64/hex (B1/B2). The design names "phase-2 shell egress guard" (`design.md:508-509`, T10 row), so this is
not a surprise finding — but the README's unqualified "Only placeholders leave the machine" does not hold
while phase 2 is absent. Tool *results* are gated; tool *side effects* and *arguments* are not.

### B11 — Magpie "local model" trust is a glob on an agent-supplied model id. **medium**
Control: `localModels` allows binary parts (`gate.middleware.js:428,440-446`). Why not: `matchesAny(localModels,
model)` matches `ctx.model`/`body.model` — a string the agent chose — and nothing consults `ctx.provider`
(available per `magpie-hooks.md:47`), the account, or the endpoint. A routing-group name or a provider plugin
registered under a local-sounding name (`ollama/*`) sends a "local" image/file to whatever endpoint that
provider actually is. `design.md:487-489` warns that `localModels` must mirror the "unmasked provider"
setting but does not state that the id is unauthenticated.

### B12 — Oversized input: the default inspection budget rejects normal long sessions, and the documented remedy raises the fail-open risk. **high**
Control: `INSPECT_LIMIT` rejection (`gate.middleware.js:432-438`). Why a problem: `maxTextChars` defaults to
**1,000,000** (`gate.middleware.js:107`) — a 260k-token conversation (the context size the design itself
cites, `design.md:59`) is roughly 1M+ characters, so a *normal long session* is rejected 403. Measured: a
1.05M-char text-only body → `INSPECT_LIMIT` 403. Meanwhile the fail-open mode is time: a hook that exceeds
250 ms is ignored and the request is sent as-is (`docs/research/magpie-hooks.md:31-32`), the gate has **no
wall-clock self-limit**, and Magpie runs it in goja (not V8), where throughput is unknown. The middleware
README's advice for a legitimate large request is to **raise** `maxTextChars` (`magpie-privacy-gate/README.md:157-160`)
— i.e. to move closer to the timeout that fails open. The default is the worst of both: it rejects users who
did nothing wrong, training them to raise/disable it.

### B13 — `ctx.reject` returning `undefined` could let a blocked request through. **high (unverified)**
See C5. `rejectOrBlank` returns `ctx.reject(403, msg)` (`gate.middleware.js:541-545`); measured:
`onRequest` then returns `undefined`, which the docs define as "send it on as it was"
(`docs/research/magpie-hooks.md:49`). The fallback `sanitize()` only runs if `ctx.reject` **throws** or is not
a function (`546-552`) — not if it returns `undefined`. Cheap hardening that does not depend on the answer:
`return ctx.reject(...) ?? sanitize(body, ctx)` (or call `sanitize` unconditionally after `ctx.reject`), and
add a harness ctx whose `reject` returns `undefined`.

### B14 — Verification that went the other way (no issue found)
- **MCP tools**: covered, see C10.
- **Subagents / workflow / agent-team**: the listeners are registered on the host (global) context, and the
  dispatch is scoped per calling agent (`dsh-tools/lib/index.js:3504`; `dsh-hooks.md:37`), so subagent tool
  results are gated too; a subagent *final answer* is a normal tool result of the parent. No new path found.
  (A subagent session started **before** install is the same named fork residual.)
- **Image/file attachments**: `agent/pre-step` rejects the whole step when a message contains
  `image|file|audio|video` (`lib/redact.js:17,112-114`; `lib/gate.js:109-115,136-145`; verified by
  `gate.test.mjs:109-115`). `read_image` is denied unconditionally (`gate.js:45-47`), which is *stricter*
  than `design.md:353` ("outside allowPaths") — a documentation mismatch in the safe direction (nit).
- **Raw `%PDF-`/`PK` bytes in text**: caught and blocked (measured; `index.js:607-632`; `gate.middleware.js:257-265`).
- **`tools/ptc-dispatch-log`**: defensive redaction present and tested (`gate.js:161-172,194-197`); whether it
  covers *all* nested `run_code` dispatches remains **UNVERIFIED** (named at `dsh-hooks.md:48`).
- **`restore()` error paths**: none echo a value — pii-core throws only for config/type errors
  (`index.js:258-266,1131-1133,1161-1184`); `privacy_rehydrate` errors carry counts only (`tools.js:237-250`).
  No issue found.
- **Placeholder key collision**: 40-bit keyed tokens; `values` is keyed by token (`index.js:1189-1190,1283-1290`),
  so a collision would silently restore the *wrong* value into an artifact. Probability for a session's
  thousands of values is ~10⁻⁶; acceptable, but the bound is documented nowhere. Nit.

---

## 3. Test integrity

**T1 — The "end-to-end" test is a simulation; it would pass with Gate 1 deleted. high.**
`tests/e2e/e2e.test.mjs:88-108` takes `res.body.text` from the extractor, calls `pii-core.redact()` **in the
test**, then writes its own "session log" from the already-redacted text and asserts the log is clean
(`103-108`) — a tautology. The "wire" is likewise `chatBody([textPart(out.text)])` (`112-118`). Nothing in the
e2e imports `plugins/dsh-privacy-gate/index.js` or `lib/gate.js`, so removing Gate 1/Gate 3 entirely leaves
9/9 green. The README's "e2e … zero plaintext on the wire" is a hand-assembled pipeline, not the product's.

**T2 — The middleware's block semantics are mocked to a sentinel the host may not return. high.**
`test/harness.mjs:73-83` defines `ctx.reject = (s,m) => { seen.push(...); return "REJECTED" }` and every
reject test asserts `out === "REJECTED"` (`91-107`). `tests/e2e/e2e.test.mjs:51-54` does the same with
`{rejected:true}`; its `runHook` maps an `undefined` return to **allowed** (`59-60`). So the one behaviour
that decides fail-open vs fail-closed (C5/B13) is asserted against an invented contract. A test using
`ctx.reject = () => {}` (the documented effectful call) would fail — which is exactly the uncertainty the
design needs resolved before "fails closed" can be claimed.

**T3 — The OCR case has a silent conditional pass. medium.**
`tests/e2e/e2e.test.mjs:143-152`: if `makeScanPdf` cannot be imported, the test `return`s and node:test
records a pass; no `t.skip`, no diagnostic. The module exists today (`packages/local-extract/test/make-fixtures.mjs:281`),
so it does run — but a future rename/refactor silently drops the only e2e OCR assertion. It also hard-codes
`engine === "winrt-ocr"` (`161`), so it fails on any machine with tesseract installed (the preferred adapter,
`engines.js:111-115`).

**T4 — No tests for the two controls that are actually broken. high (coverage).**
`plugins/dsh-privacy-gate/test/paths.test.mjs:19-31` tests only prefix boundaries — no `..`, no symlink, no
UNC, no trailing-dot/space; hence B6 is green. No test asserts that `privacy_extract` is confined;
`gate.test.mjs:151` asserts the opposite ("privacy_extract … undefined") and
`integration-core.test.mjs:38-47` stubs the extractor so `path` is never used. No test for `ctx.reject`
returning `undefined`. No test for a body at the default `maxTextChars` (the harness budget test overrides it
to 1000, `harness.mjs:520-525`).

**T5 — No timing evidence for the 250 ms claim. medium.**
The middleware harness runs in `node:vm` on V8; the production engine is goja
(`docs/research/magpie-hooks.md:25-31`). Nothing measures hook duration, so "well before the 250 ms hook budget"
(`design.md:310-311`) is an assumption, and C8/B12's inversion is untested.

**T6 — The perf test bounds only its own fixture. medium.**
`packages/pii-core/test/perf.test.js:14-41` measures a generated mixed document. Measured worst case: 50k
digits = 62 ms warm vs the 50 ms assertion; 300k digits = 437 ms. A tool result that is a numeric dump
(spreadsheet columns, a log of ids) is plausible for this user; Gate 1 runs it synchronously before append.

**T7 — Mostly-good assertions, with one weak pattern. low.**
Gate/pii-core suites do assert absence of plaintext (`gate.test.mjs:37-38,75`; `redactor.test.js:30-47`) and
`next()` pass-through (`gate.test.mjs:41-46,183-190`) — real. Weak spots: the harness "no content echo"
check looks for only 24 base64 chars (`harness.mjs:104-105`); the e2e "no plaintext" loop only checks the
six `FIXTURE_PII` values (`e2e.test.mjs:92-98,116-118`) and never transformed/encoded forms; the `node:vm`
"confinement" claim (`harness.mjs:1-13,297-309`) is a **compatibility** check — `node:vm` is not a security
boundary (escape is trivial) — the real evidence is the forbidden-token regex (`266-286`) plus the absent
globals, which is fine if scoped as such.

**T8 — One documented test command is broken. low.**
`plugins/dsh-privacy-gate/package.json` `"test": "node --test test/"` and `docs/interface-contract.md:214`'
`node --test test/` fail on this Node (v24.18/v24.21 do not accept a directory here: "Cannot find module …
\test"). The README's bare `node --test` works (**81/81**, verified) and `tests/run-all.mjs` works because it
passes explicit files (`run-all.mjs:46-47`) — but `npm test` in the bundle fails. pii-core already worked
around the same quirk (`test/index.js`); local-extract lists files; dsh-gate did not.

**T9 — Honest reporting that checks out.** The single skip is real and appropriate (`vault.test.js:75`); the
"not verified live" rows (`design.md:450-451`) match reality; suite counts in `README.md:76-81` are accurate
(pii-core 50/49/1, local-extract 49/49, dsh 81/81, magpie 44/44, e2e 9/9).

---

## 4. Code review (highest-risk paths)

### 4.1 `packages/pii-core/index.js`
- **`toLowerCase` offset desync — medium.** `index.js:1216-1221` builds `lower = text.toLowerCase()` and
  `scanContext` slices `text` with offsets taken from `lower` (`461-493`). Measured failure with U+0130
  (B5). Fix: lower-case per position (e.g. `for` loop with 1:1 mapping or only lower ASCII), or search with
  a regex `i` flag directly on `text`.
- **Tolerant placeholder exclusion is too permissive — medium.** `index.js:273` accepts any brace pair, any
  case, any kind ≤16 chars, last 8 Base32 chars (`276-301`), and `resolveHits` then drops *every* hit that
  overlaps (`1103-1125`, filtered at `1230-1231`). This is what makes idempotence cheap, but it also hides
  short values (B4). Safer: exclude only *strict* canonical tokens plus tokens present in the session's
  value map, and treat the tolerant form only inside `restore()`.
- **`CARD` candidate scan is the perf hot spot — medium/low.** `index.js:797-845`: for every start of every
  digit run, 7 candidate lengths × Luhn/IIN, allocating slices and numbers (`cardIinOk` 775-795). 62 ms for
  50k digits (measured), 437 ms for 300k. Fix: cap run length / skip runs that cannot be an IIN, or do a
  single suffix pass with incremental Luhn.
- **No Unicode normalization — medium (shared with Gate 1/3):** no NFKC, no zero-width/soft-hyphen removal;
  both this and Magpie's masker are defeated by B3.
- **Restore tolerance is sound.** `restore()` (`1297-1306`) resolves only tokens present in `values`, leaves
  unknown tokens verbatim (`1300-1303`), and `NON_RESTORABLE` (`54`) keeps SECRET/BLOB out of memory.
  Verified: no error path echoes a value; `redact()`/`scan()` never return values (`1135-1142,1283-1290`).
- **Token collision — nit.** 40-bit keyed token; `values` keyed by token (`1189-1190`). A collision would
  silently restore the wrong value into a rehydrate artifact. Bound (~n²/2⁴¹) is fine, but write it down.

### 4.2 `plugins/magpie-privacy-gate/gate.middleware.js`
- **Fail-open path when `ctx.reject` returns `undefined` — high (unverified).** B13/C5.
- **Budget inversion / no self-timing — high.** `DEFAULTS.maxTextChars = 1000000` at `107`; `INSPECT_LIMIT`
  at `432-438`; the walk itself (`315-357`) has no clock. B12.
- **`localModels` is model-id trust only — medium.** `428,440-446`; `ctx.provider` available but unused
  (`magpie-hooks.md:47`). B11.
- **Walker coverage is good; two gaps — low.** `binaryOf` treats `image/file/document/audio/video` keys as
  binary only inside part arrays (`303-309`), so a structured tool argument like
  `tool_use.input = {file: "<base64 under 2048>"}` is scanned as text only; and `PART_ARRAY_KEY` does not
  include `contents`/`items`, so nested part arrays are reached via `parts`/`content` only (works for all
  four documented dialects, verified by the harness; it is a future-schema risk).
  The blob regexes (`208-217`) and `looksWrappedBase64` (`221-235`, gated on `text.length >= 2048`) are
  the reason B1/hex escapes exist.
- **Prototype-key false positive — nit.** `binaryOf` indexes `BINARY_TYPE[node.type]` directly
  (`294`), and `SKIP_KEY`/`WEAK_KEY` are plain object lookups, so `{"type":"constructor"}` is rejected as a
  binary part (measured 403 "type constructor"). Also `globRegExp` resets a global cache at 500 entries
  (`185-192`) while `logMaxLines` is intended as a global cap — per-request module state assumption
  (`comment 26-27`) contradicts the module-level counters (`507-521`); docs say "compiled once" (R2), so the
  cap semantics are undefined. Nit.

### 4.3 `plugins/dsh-privacy-gate/lib/*`
- **`paths.js`: `..`/symlink bypass — high.** B6; `paths.js:23-38`.
- **`tools.js`/`extract.js`: extraction path unconstrained — high.** `tools.js:150-162`; `extract.js:27-37,99`
  (no `env` passed, so `PRIVACY_EXTRACT_ALLOWED_ROOT` is never set, despite the CLI honouring it at
  `cli.js:388-405`). Fix: apply `isPathAllowed` to the parsed `path` (and to `artifact_path`), or set the
  env pin from `allowPaths`.
- **`redact.js`: unknown block types are passed through, not blocked — medium.** `96-118`: only `text`/
  `reasoning` are redacted (a text block whose `text` is not a string is appended unchanged at `108-115`),
  only four media types are blocked, everything else passes. `redactMessage` returns unchanged when
  `message.content` is not an array (`194-195`). For today's DSH union this is safe; for a future/first-party
  tool result it is a silent pass. Given the design's fail-closed principle, unknown block types should block.
- **Block-vs-pass on the results path is correct — no issue.** `shapePostExecute` never overrides another
  block (`gate.js:71`), blocks when the redactor is broken/absent (`68,73`), blocks on malformed decisions
  (`69,72`), blocks BLOB (`79,87-92,101`), and returns `next()`'s decision when unchanged (`80,110-112`) —
  matching `dsh-tools/lib/index.js:3506-3531` semantics (checked). `next()` composition is right
  (`gate.js:183-199`): every listener awaits `next()`, and the disposers are returned/torn down.
- **Success results: `meta` sanitized via value replacement; error results: `meta` not sanitisable — low.**
  Named at `dsh-hooks.md:46` but **not** in `design.md` §12; today no shipped tool puts content in an error
  `meta` and `errorInfo` only carries name/code (`dsh-tools/lib/index.js:toolErrorResult`/`errorInfo`), so
  low.
- **`failClosed` is dead config — low.** Parsed and validated (`lib/config.js:89,107`; `index.js:55`) but
  never read; the gate always fails closed. Safe direction, but the documented knob is a lie to the operator.
- **`detectors` can silently remove the BLOB block — medium.** `createRedaction` passes `kinds` only when
  non-empty (`index.js:91`); `createRedactor` then enables exactly those kinds (`index.js:1157-1170`). An
  operator narrows to `detectors: [IBAN, EMAIL]` → **no BLOB detector** → the "block the data transfer" rule
  disappears. BLOB/SECRET should be non-configurable (or config must be validated to include BLOB).
- **Default key/artifact locations are inside the repository — medium.** `index.js:42-47`:
  `keys/placeholder.key` and `artifacts/` under the repository root; `writeArtifact` writes plaintext with a
  no-op `mode: 0600` on Windows (`index.js:100-104`). Out-of-the-box, the HMAC key and the restored plaintext
  live in the repo tree that the user is likely to copy/share. `install.md:64-66` tells the user to
  move them to `~/.dsh/privacy/` — the code should default there, not in the repo.
- **Guard denial message carries the file basename into the session — low.** `gate.js:52` interpolates
  `displayName(filePath)` into tool-error content, which Gate 1 then logs/sends (redacted only if the name
  itself matches a detector). Filenames routinely contain names ("Rechnung_Max_Mustermann.pdf"); the audit
  journal correctly stores only `path_hash` (`audit.js:16-20,42-60`), but this message is not the journal.
- **`read_image` denied unconditionally vs docs "outside allowPaths" — nit.** `gate.js:45-47` vs
  `design.md:353`.

### 4.4 `packages/local-extract` (spot-checked)
No network, no shell interpolation: powershell/poppler/python are spawned with argv arrays
(`engines.js:102-143,592-594,870-884`); page ranges/lang are parsed/mapped (`1015-1035`, `507-578`), so the
model-controlled `lang`/`pages` do not reach a command string. Temp rasters are cleaned in `finally`
(`engines.js` render/OCR paths; measured in `docs/research/local-extract-env.md:104-109`) with a force-kill
residue named honestly. CLI path pin resolves symlinks via `realpath` (`cli.js:376-405`) — **the pin works,
the gate just never sets it**. Timeout kill does not kill grandchildren on Windows (`extract.js:100-103`) —
orphaned `pdftoppm`/`powershell` can outlive the timeout; low.

---

## 5. Privacy of the repository itself

- **Fixtures are synthetic — verified.** `Musterstraße`, `Erika Mustermann`, `.invalid`/`example.com`,
  `sk-test-000…`, a generated fake PEM and `hunter2` password (`tests/e2e/fixtures.mjs:57-83`;
  `packages/pii-core/test/helpers/fixtures.mjs:130,182`). The IBAN is the published ISO example
  (`DE89370400440532013000`), not a customer account. `tests/e2e/.tmp/session-log.jsonl` contains only
  placeholders and synthetic values.
- **No credentials or PII in shipped code — verified.** The only `BEGIN … PRIVATE KEY` / `PASSWORD=` strings
  are the synthetic test fixtures above. No real invoices, ID documents, addresses or names anywhere.
- **No network calls in shipped code — verified.** `grep` for `fetch|http|https|net|dns|XMLHttpRequest|
  WebSocket|Invoke-WebRequest|Invoke-RestMethod` over shipped `*.js/*.mjs/*.ps1/*.py`/`*.json`: only local
  `spawn`s, test sentinels, and doc URLs. The Magpie middleware is additionally `vm`-loaded with no host
  globals (`test/harness.mjs:41-67,304-309`).
- **No plaintext dump of the originating session — verified.** [`background.md`](background.md) is redacted
  and the original session log is not in the repository.
- **Generated artifacts inside the tree — medium (hygiene).** `tests/e2e/.tmp/` (PDFs, `session-log.jsonl`)
  is committed/present, there is no `.gitignore`, and the default `keys/` + `artifacts/` directories are
  created under the repo root at first run (§4.3). A `git add .`/zip would carry the HMAC key and plaintext
  artifacts. Add a `.gitignore` (`keys/`, `artifacts/`, `tests/e2e/.tmp/`) and move defaults to
  `~/.dsh/privacy/`.
- **Machine/user identifiers baked into docs — low.** Real absolute paths with the Windows user name appeared
  throughout the reviewed revision (contract, design, install guide, research notes), including a personal
  folder name. Not a functional leak, but it conflicts with the repository's own I9 ("never print or commit
  a real … name") if the repository is shared. **Fixed in the public-release cleanup: all paths are now
  placeholders (`<repo>`, `$DSH_INSTALL`, `%USERPROFILE%`).**

---

## 6. Verdict

**Must-fix before this can be called "PII never reaches a provider" (in order):**

1. **B1 — document bytes below the blob thresholds / line-wrapped pass both gates.** Reproduced with the
   repo's own 1013-byte invoice (contiguous and wrapped base64: Magpie ALLOW, Gate 1 unredacted). Fix
   thresholds + add a line-wrapped/whitespace-insensitive blob check to Gate 1 (parity with Magpie), and
   treat `pwsh` byte/hex output as blocked by default.
2. **B13/C5 — the Magpie "fails closed" claim depends on unverified `ctx.reject` return semantics**
   (`gate.middleware.js:541-545,573`); the tests mock a sentinel (`harness.mjs:73-83`) and the e2e helper
   reads `undefined` as allowed. Make the reject path unconditional (`?? sanitize(...)`), add an
   undefined-returning `reject` test, and re-scope the claim until a live gateway test exists.
3. **B6 — `allowPaths` is bypassable by `..` and never enforced on `privacy_extract`.** Fix
   `normalizeForCompare`/`isWithinPath` (resolve `..`, reject symlink targets), apply the same policy to
   Gate 2, and add traversal/symlink/extraction-path tests.
4. **B12 — the 1M-char default rejects legitimate long sessions and the documented remedy increases the
   timeout fail-open risk.** Set a conservative default, add a wall-clock self-limit inside the gate, and
   measure goja throughput before shipping the 250 ms claim.
5. **B4/B5/B3/B2 — detection is not Unicode/encoding robust and placeholder-shaped text suppresses it.**
   Normalize input (NFKC, strip zero-width/soft hyphen), restrict placeholder exclusion to canonical
   session tokens, fix the `toLowerCase` offset desync, and state the guarantee as "values the detectors
   recognise in the shapes they recognise".

*(B7 text-file reads of local residuals, B9 second provider, B11 local-model trust, and the plaintext
artifact/key defaults are next in line; B8 material for the shell-egress phase.)*

**Most over-stated claims (all three should be rewritten, not deleted):**

1. "**Only placeholders leave the machine**" / "the session log holds placeholders" — true only for
   detector-recognised values in supported shapes and tool results; false for small/wrapped/encoded
   document bytes and detector misses (B1, B2, B3, B4).
2. "**Fails closed**" for the Magpie gate — unverified and dependent on undocumented return semantics; the
   only fail-closed-by-construction path today is `onProvider`'s sanitize (`gate.middleware.js:581-602`).
3. "**Reading a rehydrated artifact back re-redacts it** … placeholders again" (`design.md:334-337`) and
   "there is no direct-to-vendor path to forget" (`design.md:397`) — both are conditional in practice: the
   first only for detected values, the second only for the profile as currently configured, with no code
   enforcement.

**What I would not ship:** the combined claim "PII never reaches an LLM provider" and the Magpie README's
"fails closed" as stated today. Ship the mechanisms, the tests and the honest §12 limitations — but label the
product as *deterministic best-effort masking with a structural egress firewall*, not as a guarantee that
only placeholders can leave. Also do not ship the current defaults (blob thresholds, `maxTextChars`, key/
artifact paths inside the repo) without the fixes above.

---

## Appendix A — evidence (commands run, all local, no network)

- `node tests/run-all.mjs` → `all suites passed` (pii-core 50 tests/49 pass/1 skip; local-extract 49/49;
  dsh-privacy-gate 81/81; magpie harness 44/44; e2e 9/9).
- `node scripts/vendor-core.mjs --check` → `vendor-core: up to date`.
- B1 probe: base64 of `tests/e2e/.tmp/invoice.pdf` (1013 B → 1352 chars contiguous, 1373 wrapped at 64) →
  Magpie `onRequest` ALLOW; `shapePostExecute` with the real vendored core returns `accept` unchanged;
  `pii-core.scan` hits = NONE. Raw PDF-as-text *is* blocked (`%PDF-` magic).
- B2 probe: 1200 spaced hex pairs → Magpie ALLOW; Gate 1 masks some digit runs as `CARD`, bytes survive.
- B4 probe: `{{DE136695976ABCDEFGH}}` → no hits; `USt-IdNr DE136695976` → `{{VATID_4TDGWXOH}}`.
- B5 probe: `"Konto 1234567890"` → masked; `"İ Konto 1234567890"` → no hits.
- B6 probe: `isPathAllowed("C:\\allowed\\..\\..\\Users\\x\\secret\\invoice.pdf", ["C:\\allowed"]) → true`.
- B12 probe: 1.05M-char text-only body → `INSPECT_LIMIT` 403; `type:"constructor"` part → 403.
- B13 probe: `onRequest` returns `undefined` with a `reject` that returns nothing.
- Perf probe (`node --input-type=module`): 50k digits warm best 62 ms; 100k 164 ms; 300k 437 ms; 1.01M prose 62 ms.
- Source checks: `dsh-mcp-client/lib/index.js:153` (`ctx.tools.register`) +
  `dsh-tools/lib/index.js:3503-3531` (postExecute); `dsh-tool-fs-search`, `dsh-spill-policy`,
  `dsh-repeat-tool-reminder` listeners; `dsh-agent-loop/lib/index.js:691-707` (tool/result append).
- `node --test` in `plugins/dsh-privacy-gate` → 81/81; `node --test test/` → fails ("Cannot find module …
  \test") — T8.


---

## 7. Resolution (added when the fixes landed)

Every blocker and high finding was fixed and is covered by a regression test; the rest is now a
named limitation in `design.md` §12 rather than an unstated gap. The review text above is kept
as written so the findings remain auditable.

| Finding | Status | Where the fix / evidence lives |
|---|---|---|
| B1 small or wrapped base64 of a document | **fixed** | thresholds 400 (was 2048/1024), line-wrapped and `data:` detection (`packages/pii-core/index.js` BLOB section); tests: `pii-core/test/hardening.test.js`, `tests/e2e/e2e.test.mjs`, `magpie-privacy-gate/test/harness.mjs` |
| B2 `Format-Hex` spaced hex dump | **fixed** | spaced-hex detector with an a-f requirement so decimal tables do not trip it; same three test files |
| B3 reversed / re-encoded text | **partly** | zero-width + soft-hyphen normalisation added; reversed text remains a named limitation (§12.18) |
| B4 placeholder-shaped text hides a value | **fixed** | only *issued* placeholders are excluded; unknown shapes are scanned with their hash blanked; `hardening.test.js` |
| B5 `toLowerCase` index desync | **fixed** | keyword matching is a case-insensitive regex on the original text; `hardening.test.js` |
| B6 `allowPaths` traversal / extract bypass | **fixed** | `..` collapsed in `lib/paths.js`; extract tools check lexical path **and** realpath and never spawn on refusal; `paths.test.mjs`, `tools.test.mjs` |
| B13 `ctx.reject` returning undefined | **fixed** | `ctx.reject(...)` call is the rejection and the hook returns immediately (no fallback on an undefined return); harness case + live-gateway check |
| B12 oversized body rejected / no self-limit | **fixed** | deterministic `scanChars` text budget; no size rejection, no clock; long-session test in the harness |
| B11 model-id spoofing for "local" | **fixed** | `onProvider` requires the *provider* id in `localProviders`; harness case |
| B7/B8/B9/B10 text-file reads, rehydrate misses, second provider, shell egress | **documented** | DESIGN §12.19-21 |
| B14 (MCP/subagent coverage) | no issue | confirmed in the review |
| C1/C2/C3/C5/C7 overstated claims | **fixed** | README "What it guarantees — and what it does not" and DESIGN §1 rewritten |
| C6/C9/C11/C12 | fixed / documented | path policy fixed; card-detector fast path (300k digits 380→40 ms); vault-unwired and provider-route notes in §12 |
| Dead `failClosed` config | **removed** | the gate always fails closed; config rejects the key now (`config.test.mjs`) |
| Key/artifacts defaulting inside the repo | **fixed** | defaults moved to `%USERPROFILE%\\.dsh\\privacy\\{placeholder.key,artifacts}`; `.gitignore` covers both |
| No `.gitignore` / generated artifacts in the tree | **fixed** | root `.gitignore`; generated fixtures, `.tmp`, keys and artifacts are ignored |
| Machine/user identifiers in docs | **fixed** | public-release cleanup: portable placeholders throughout |
