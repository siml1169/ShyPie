/**
 * Suite entry point.
 *
 * `node --test test/` is the documented command (docs/interface-contract.md), but Node's test
 * runner only accepts files/globs — a bare directory argument is resolved as a
 * module, so `node test/` lands here and this module imports the whole suite.
 * The individual `*.test.js` files remain runnable directly and are also
 * discoverable via `node --test` / `node --test "test/**\/*.test.js"`.
 */
import './crypto.test.js';
import './detectors.test.js';
import './redactor.test.js';
import './vault.test.js';
import './perf.test.js';
import './magpie-compat.test.js';
import './hardening.test.js';
