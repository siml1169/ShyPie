# Contributing

This is a privacy tool: the most important contribution rule is that **no real personal data enters
the repository**. All fixtures are generated at test time; keep it that way.

## Ground rules

1. **Synthetic data only.** Never commit a real document, invoice, identity paper, IBAN, address,
   e-mail, phone number or name — not in tests, issues, commit messages or screenshots. The public
   test IBAN (`DE89 3704 0044 0532 0130 00`) and the "*Muster*" names are the intended placeholder
   values.
2. **No network I/O in shipped code.** Neither plugin may call `fetch`, `http`, DNS, telemetry or an
   update check. Tests must pass offline.
3. **Evidence for claims.** A statement about DeepSeek Harness internals needs a `path:line`
   reference into the shipped source; a statement about Magpie needs the docs URL and the quoted
   sentence. Unverifiable claims are marked `UNVERIFIED` in `docs/research/`.
4. **Fail closed.** New extraction paths, new content types and new request shapes default to a
   block, not a pass. If a control cannot decide, it refuses.

## Development

There are no npm dependencies to install for the libraries. Use Node.js 22+ (the runtime bundled
with DeepSeek Harness works):

```bash
node tests/run-all.mjs                     # all suites
node --test test/                          # inside packages/pii-core
node --test "test/*.test.mjs"              # inside plugins/dsh-privacy-gate
node plugins/magpie-privacy-gate/test/harness.mjs
```

The `local-extract` suite additionally needs poppler (`pdftotext`, `pdftoppm`, `pdfinfo`) on `PATH`;
it generates its fixtures with the bundled Python when Office documents are involved.

## Changing an interface

[`docs/interface-contract.md`](docs/interface-contract.md) describes the shapes shared between the
packages and plugins. A change there must update every implementer and the tests in the same change.
Behavioural values (thresholds, defaults, allowlists) are documented next to the component and are
not frozen.

## Documentation changes

- `docs/design.md` is the design of record; update its threat model or limitations if a change alters
  them.
- `docs/install.md` is the installation path a user follows; keep commands copy-pasteable.
- `docs/research/` holds evidence, not opinion. Do not rewrite a measurement without re-running it;
  do not delete a finding because it is inconvenient — record the fix and keep the finding auditable.
- Paths in documents use placeholders: `<repo>`, `$DSH_INSTALL`, `%USERPROFILE%`, `%TEMP%`. Do not
  commit machine-specific absolute paths or a user name.
