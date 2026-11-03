# @shypie_privacy/pii-core

Deterministic, local-first PII detection + keyed placeholder masking shared by the DSH and Magpie
privacy gates. **Zero npm dependencies, no I/O, no network.** `index.js` is plain ECMAScript so it can
be vendored into Magpie's moejs middleware; Node-only persistence lives behind `./vault`.

Contract: `../../docs/interface-contract.md`. Detector evidence/checksums/scope:
`../../docs/research/pii-detectors.md`.

## Install (local path only — no registry involved)

```json
{ "dependencies": { "@shypie_privacy/pii-core": "file:../pii-core" } }
```

DSH does not need this: `plugins/dsh-privacy-gate/vendor/pii-core.js` is a generated copy of
`index.js`. Magpie gets the same copy inlined into its middleware file.

## API

```js
import {
  VERSION, KINDS, createRedactor, tokenFor, findPlaceholders, isPlaceholderShaped,
} from '@shypie_privacy/pii-core';
import { createVault } from '@shypie_privacy/pii-core/vault';

const redactor = createRedactor({
  key: 'session-key',          // REQUIRED: secret, per-session
  kinds: ['EMAIL', 'IBAN'],    // optional detector allowlist (default: all KINDS)
  allowWords: ['Max Mustermann'], // optional: exactly the words PERSON will mask
});

redactor.scan(text);        // -> Hit[]  { kind, start, end, length, source, valid }
redactor.redact(text);      // -> { text, tokens: Token[], hits, changed }
                            //    Token = { token, kind, length, count }  (never a value)
redactor.restore(text);     // -> string (tolerant of case/space/full-width-brace rewrites)
redactor.resolve(text);     // alias of restore
redactor.hasPlaceholders(text);
redactor.stats();           // -> { charsScanned, byKind }

tokenFor(key, 'IBAN', value); // -> "{{IBAN_XXXXXXXX}}"  deterministic per key/value
findPlaceholders(text);      // -> [{ token, kind }] (canonical tokens, rewrite-tolerant)
isPlaceholderShaped(text);   // -> boolean (whole string is exactly one placeholder)
```

Placeholders are `{{KIND_XXXXXXXX}}` where `XXXXXXXX` is 8 Base32 chars = 5 bytes of
`HMAC-SHA256(key, KIND + "\0" + value)` (RFC 4648 Base32). Keyed, not a bare hash; stable for the
whole session so prompt caching keeps working.

Encrypted vault (Node only): `createVault({ dir })` → `{ put(token, kind, value), get(token),
save(redactor), load(redactor?), path, wipe() }`; AES-256-GCM, key file `0600`, no plaintext on disk.

## Safety properties (enforced by tests)

- `redact()` output, `tokens`, `hits`, `stats()` and error messages never contain a plaintext value.
- Deterministic: same key + same text ⇒ same output; idempotent: `redact(redact(x)) === redact(x)`.
- `SECRET` and `BLOB` values are never retained in memory or persisted; `restore()` leaves their
  placeholders untouched (secrets must never be re-materialised into a reply; BLOB is a block signal).
- Any `BLOB` hit means the caller must **fail closed** and reject the content.
- Detector priority (highest wins on overlap): `SECRET > BLOB > IBAN > CARD > VATID > TAXID > IDNR >
  EMAIL > BIC > SSN > PASSPORT/IDCARD > PHONE > ADDRESS > ACCOUNT > DOB > PERSON`.
- Out of deterministic scope (documented): free-text personal names (only `allowWords`), non-German
  VAT IDs, non-numeric/word-month DOB formats, addresses in non-German formats, images/OCR (that is
  `@shypie_privacy/local-extract` + the gates).

## Tests / performance

```bash
node --test test/                       # 49 pass, 1 skipped (POSIX mode test on Windows), 0 fail
node --test "test/**/*.test.js"         # equivalent alternative
```

`test/index.js` is the suite entry point that makes the directory form work on Node ≥ 22 (which
resolves a bare directory as a module rather than recursing test files).

Measured on the bundled Node v24.21.0: a 50,125-char synthetic document with 2,133 hits redacts in
**10.6–14.8 ms** warm (first call ≈ 40–60 ms pays JIT/regex compilation); a clean 50k document in
≈ 2.4 ms. No real user documents are read; all fixtures are synthetic and generated at test time.

## Deviations from the interface contract 

1. `redact()` masks BLOB spans as well as reporting them, so invariant "no plaintext in `redact()`
   output" holds; gates must still reject on any `BLOB` hit.
2. `PLZ Ort` is implemented as "5 digits + a capitalised city word with ≥ 3 letters" (requiring three
   *uppercase* letters would miss mixed-case German city names).
3. `BIC` country scope is DE + EU/EEA/CH/GB (false-positive control).
4. Additive internal helpers: `sha256Hex`/`hmacSha256Hex` (used by the `node:crypto` cross-check
   test) and Redactor `_entries()`/`_hydrate()` (used only by the vault; the gate never sees values).
5. `vault.load(redactor?)` accepts an optional redactor to hydrate; `load()` alone still fills memory
   so `vault.get(token)` works per contract.
6. `stats()` accumulates over both `scan()` and `redact()` calls.
