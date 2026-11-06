# Security policy

This repository is a **reference implementation** of a privacy workflow; it is tagged `v0.3.0`, has
a GitHub release and no formal support window. Read [docs/design.md](docs/design.md) for the threat model and
[§12 "Known limitations"](docs/design.md#12-known-limitations) for what it does **not** protect
against. An independent adversarial review, with the list of fixed findings and remaining residuals,
is in [docs/research/security-review.md](docs/research/security-review.md).

## Reporting a vulnerability

Use GitHub's private **Security → Report a vulnerability** flow on this repository. Do not open a
public issue for a vulnerability, and **do not include real personal data** in a report: the whole
point of this tool is that such data should not be copied around. Reproduce with synthetic values
(fake IBANs, test names, generated PDFs) — the test suites in this repository show how.

Please include:

- the component and version/commit you tested,
- a minimal reproduction with synthetic data,
- what you expected to be masked or blocked, and what actually happened,
- whether the issue is a bypass (PII leaves despite the design) or a usability/robustness defect.

## Scope

In scope:

- PII bypasses of the documented controls: detector misses on the shapes listed in
  [the detector catalogue](docs/research/pii-detectors.md), encoding tricks that survive the BLOB
  rules, path-guard bypasses, placeholder round-trip leaks.
- Fail-open behaviour where the design says fail-closed.
- Network I/O in shipped plugin code (there should be none).
- Plaintext values or keys written where the design says they must not be.

Out of scope:

- A compromised local machine, a hostile operating system, or a hostile local model.
- What a provider does with data after it has been sent (that is why the data is masked first).
- Free-text personal names and other values outside the deterministic detector scope — these are
  documented limitations, not vulnerabilities.
- The exact live matrix: the bundle and middleware were exercised manually on 2026-11-03 (DSH
  0.2.1-rc.5 headless + live Magpie gateway), but there is no CI live test and the DSH GUI profile is
  managed by the Electron app — see [docs/design.md §11](docs/design.md#11-verification).
