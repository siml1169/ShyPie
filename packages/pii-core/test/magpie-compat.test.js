import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Magpie compatibility: index.js is vendored into the moejs gateway middleware
 * plugin, so it must be plain ECMAScript — no imports, no Node built-ins, no
 * network, no console, no timers. docs/interface-contract.md: "no `node:` import in index.js".
 */
const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, '..', 'index.js');
const source = readFileSync(indexPath, 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('index.js has no imports, Node built-ins, network, I/O, timer or console usage', () => {
  const forbidden = [
    [/from\s+['"]node:/, 'node: import'],
    [/\brequire\s*\(/, 'require()'],
    [/^\s*import\s/m, 'import statement'],
    [/\bimport\s*\(/, 'dynamic import'],
    [/\bprocess\s*\./, 'process usage'],
    [/\bBuffer\b/, 'Buffer usage'],
    [/\bconsole\s*\./, 'console usage'],
    [/\bTextEncoder\b/, 'TextEncoder usage'],
    [/\bsetTimeout\s*\(/, 'setTimeout'],
    [/\bsetInterval\s*\(/, 'setInterval'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  ];
  for (const [re, label] of forbidden) {
    assert.doesNotMatch(code, re, 'index.js must not contain ' + label);
  }
});

test('index.js loads and redacts inside a bare ECMAScript vm context (moejs shape)', () => {
  // Strip ESM syntax only; there are no imports to resolve.
  const script = code
    .replace(/^export default[\s\S]*?;\s*$/m, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({});
  const api = vm.runInContext(script + '\n;({ VERSION, KINDS, createRedactor, tokenFor, findPlaceholders });', context);

  assert.equal(api.VERSION, '0.1.0');
  assert.equal(api.KINDS.length, 17);

  const redactor = api.createRedactor({ key: 'moejs-session-key' });
  const out = redactor.redact('Mail max.mustermann@example.invalid, 漢字 ünïcode 😀, Tel +49 30 12345678');
  assert.match(out.text, /\{\{EMAIL_[A-Z2-7]{8}\}\}/);
  assert.equal(out.text.includes('max.mustermann@example.invalid'), false);
  assert.equal(redactor.redact(out.text).changed, false);
  assert.equal(api.findPlaceholders(out.text).length >= 1, true);
  assert.equal(api.tokenFor('k', 'EMAIL', 'x').length, '{{EMAIL_'.length + 8 + 2);
});
