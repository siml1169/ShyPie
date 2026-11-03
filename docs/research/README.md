# Research notes

Evidence for the design in [../design.md](../design.md). Every claim about DeepSeek Harness internals
carries a `path:line` reference into the shipped source; every claim about Magpie carries the docs URL
and the quoted sentence. Anything that could not be verified is marked **UNVERIFIED** with the reason.

| Note | What it records |
|---|---|
| [dsh-hooks.md](dsh-hooks.md) | The DeepSeek Harness seams the gate relies on: tool-result waterfall, guards, tool registration, the deep-frozen request, user/attachment ingress, and the resume/fork/replay proof. Includes what a supported plugin seam cannot do. |
| [magpie-hooks.md](magpie-hooks.md) | The Magpie gateway middleware contract: runtime (moejs), hooks and ordering, per-protocol body shapes, options and open questions. |
| [pii-detectors.md](pii-detectors.md) | Detector catalogue: patterns, checksums, false-positive notes, explicit out-of-scope items, placeholder derivation, measured performance. |
| [local-extract-env.md](local-extract-env.md) | Measured engine matrix for local extraction and OCR on the reference machine: commands, outputs, exit codes, block reasons. |
| [background.md](background.md) | Redacted account of the incident that motivated the workflow. Contains no personal data. |
| [security-review.md](security-review.md) | Independent adversarial review of the design, its claims and the code, with a resolution table for the fixed findings. |

## Conventions

- `<repo>` — repository root.
- `$DSH_INSTALL` — the DeepSeek Harness installation directory. DSH ships its implementation inside
  `app.asar`; to read the shipped source, extract it (`npx asar extract app.asar dsh-src`) and look
  under `dsh-src/node_modules/@deepseek-ai/`.
- `%USERPROFILE%` / `$HOME` — the current user's home directory; `%TEMP%` — the temporary directory.
- Measurements were taken on one reference machine (Windows 11, Node 24, poppler 24.04). They are
  evidence, not guarantees for other machines.

## Reproduce

```bash
node tests/run-all.mjs                     # every suite, one summary
node packages/local-extract/test/measure-engines.mjs   # the engine matrix
```

The suites generate their own synthetic fixtures at test time and never use the network. No real
document, invoice, identity paper or personal record is used anywhere in this repository.
