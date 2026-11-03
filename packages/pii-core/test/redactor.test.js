import test from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor, tokenFor, findPlaceholders, isPlaceholderShaped, VERSION } from '../index.js';
import * as fx from './helpers/fixtures.mjs';

const KEY = 'session-key-redactor-tests';
const values = fx.makeSampleValues();
const paragraph = fx.makeParagraph();
const rng = fx.makeRng(777);
const pem = fx.makePemBlock(rng);
const apiKey = fx.makeApiKey(rng);

function make(config = {}) {
  return createRedactor({ key: KEY, allowWords: [values.person], ...config });
}

test('redact() returns { text, tokens, hits, changed } and masks every detected value', () => {
  const r = make();
  const out = r.redact(paragraph);
  assert.equal(out.changed, true);
  assert.ok(Array.isArray(out.tokens) && out.tokens.length > 0);
  assert.equal(out.hits.length, out.tokens.reduce((n, t) => n + t.count, 0));
  for (const token of out.tokens) {
    assert.match(token.token, /^\{\{[A-Z][A-Z0-9]*_[A-Z2-7]{8}\}\}$/);
    assert.deepEqual(Object.keys(token).sort(), ['count', 'kind', 'length', 'token']);
  }
});

test('no plaintext value ever appears in redact() output, tokens, hits, stats or errors', () => {
  const r = make();
  const out = r.redact(paragraph);
  const surfaces = [out.text, JSON.stringify(out.tokens), JSON.stringify(out.hits), JSON.stringify(r.stats())];
  const rawValues = [
    values.iban, values.vatid, values.idnr, values.card, values.usSsn, values.email,
    values.phoneIntl, values.phoneDe, values.person, values.street, values.dob,
    values.account, values.taxId, values.passport, values.idCard, values.deSsn, values.password,
  ];
  for (const surface of surfaces) {
    for (const raw of rawValues) {
      assert.equal(surface.includes(raw), false, 'plaintext leaked into a redact() surface');
      // Also check the value without its punctuation-heavy wrapper, for the secret.
      const core = raw.replace(/^PASSWORD=/, '');
      assert.equal(surface.includes(core), false, 'plaintext leaked into a redact() surface');
    }
  }
});

test('SECRET and BLOB values are masked and never retained', () => {
  const r = make();
  const blob = fx.makeBase64Blob(fx.makeRng(3));
  const text = 'Login ' + apiKey + ' PEM\n' + pem + '\nBLOB ' + blob;
  const out = r.redact(text);
  const kinds = out.hits.map((h) => h.kind);
  assert.ok(kinds.includes('SECRET'));
  assert.ok(kinds.includes('BLOB'));
  assert.equal(out.text.includes(apiKey), false);
  assert.equal(out.text.includes(blob), false);
  // Placeholders for non-restorable kinds stay placeholders; values are not in memory.
  assert.equal(r.restore(out.text).includes(apiKey), false);
  assert.equal(r.restore(out.text).includes(blob), false);
  assert.match(r.restore(out.text), /\{\{SECRET_[A-Z2-7]{8}\}\}/);
});

test('redaction is deterministic for the same key', () => {
  const a = make().redact(paragraph);
  const b = make().redact(paragraph);
  assert.equal(a.text, b.text);
  assert.deepEqual(a.tokens, b.tokens);
  assert.deepEqual(a.hits, b.hits);
});

test('placeholders are stable across calls and in the whole session', () => {
  const r = make();
  const first = r.redact('Mail ' + values.email);
  const second = r.redact('Nochmal ' + values.email + ' und ' + values.email);
  assert.equal(first.tokens[0].token, second.tokens[0].token);
  assert.equal(second.tokens.length, 1);
  assert.equal(second.tokens[0].count, 2);
});

test('a different key yields different placeholders (keyed, not bare hashes)', () => {
  const a = createRedactor({ key: 'key-one' }).redact('Mail ' + values.email);
  const b = createRedactor({ key: 'key-two' }).redact('Mail ' + values.email);
  assert.notEqual(a.tokens[0].token, b.tokens[0].token);
});

test('redact() is idempotent: redact(redact(x)) === redact(x)', () => {
  const r = make();
  const once = r.redact(paragraph);
  const twice = r.redact(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.tokens, []);
  // Same through scan(): nothing left to detect.
  assert.deepEqual(r.scan(once.text), []);
});

test('restore() round-trips restorable values and is tolerant of model rewrites', () => {
  const r = make();
  const original = 'IBAN ' + values.iban + ' und Mail ' + values.email;
  const out = r.redact(original);
  assert.equal(r.restore(out.text), original);
  assert.equal(r.resolve(out.text), original);

  const token = out.tokens[0].token;
  assert.equal(r.restore(token.toLowerCase()), values.iban);
  assert.equal(r.restore(token.replace('_', ' ')), values.iban);
  assert.equal(r.restore(token.replace('{{', '{{ ').replace('}}', ' }}')), values.iban);
  const fullWidth = token.replace(/\{/g, '\uFF5B').replace(/\}/g, '\uFF5D');
  assert.equal(r.restore(fullWidth), values.iban);
  const innerSpaces = token.slice(0, 2) + ' ' + token.slice(2, -2) + ' ' + token.slice(-2);
  assert.equal(r.restore(innerSpaces), values.iban);
});

test('restore() leaves unknown and non-restorable placeholders untouched', () => {
  const r = make();
  const unknown = '{{IBAN_AAAAAAAA}}';
  assert.equal(r.restore('hi ' + unknown), 'hi ' + unknown);
  assert.equal(r.restore('{{not a placeholder}}'), '{{not a placeholder}}');
});

test('helper exports: hasPlaceholders/findPlaceholders/isPlaceholderShaped', () => {
  const r = make();
  const emailToken = tokenFor(KEY, 'EMAIL', values.email);
  const text = 'a ' + emailToken + ' b ' + emailToken.toLowerCase() + ' c {{PHONE_ABCDEFGH}}';
  assert.equal(r.hasPlaceholders(text), true);
  assert.equal(r.hasPlaceholders('kein Platzhalter'), false);

  const found = findPlaceholders(text);
  assert.deepEqual(found, [
    { token: emailToken, kind: 'EMAIL' },
    { token: '{{PHONE_ABCDEFGH}}', kind: 'PHONE' },
  ]);

  assert.equal(isPlaceholderShaped(emailToken), true);
  assert.equal(isPlaceholderShaped('  ' + emailToken + '  '), true);
  assert.equal(isPlaceholderShaped('x' + emailToken), false);
  assert.equal(isPlaceholderShaped('{{NOPE}}'), false);
  assert.equal(isPlaceholderShaped('plain text'), false);
});

test('scan() is sorted, read-only and never exposes values', () => {
  const r = make();
  const hits = r.scan(paragraph);
  assert.ok(hits.length > 5);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].start < hits[i].start);
  for (const hit of hits) {
    assert.equal(typeof hit.kind, 'string');
    assert.equal(hit.valid, true);
    assert.ok(hit.source.length > 0);
    assert.equal(JSON.stringify(hit).includes(values.person), false);
  }
  // scan() must not mutate; redact still works afterwards.
  assert.ok(r.redact(paragraph).changed);
});

test('stats() counts scanned chars and hits per kind', () => {
  const fresh = make();
  const initial = fresh.stats();
  assert.equal(initial.charsScanned, 0);
  assert.deepEqual({ ...initial.byKind }, {});
  fresh.redact('Mail ' + values.email + ' IBAN ' + values.iban);
  const stats = fresh.stats();
  assert.equal(stats.charsScanned, ('Mail ' + values.email + ' IBAN ' + values.iban).length);
  assert.equal(stats.byKind.EMAIL, 1);
  assert.equal(stats.byKind.IBAN, 1);
  assert.equal(JSON.stringify(stats).includes(values.iban), false);
  assert.equal(typeof fresh.stats().charsScanned, 'number');
});

test('config.kinds restricts the enabled detectors', () => {
  const onlyEmail = make({ kinds: ['EMAIL'] });
  const out = onlyEmail.redact('Mail ' + values.email + ' IBAN ' + values.iban);
  assert.equal(out.text.includes(values.email), false);
  assert.equal(out.text.includes(values.iban), true);
  assert.deepEqual([...new Set(out.hits.map((h) => h.kind))], ['EMAIL']);
});

test('allowWords controls PERSON detection (free-text names are out of deterministic scope)', () => {
  const withoutList = createRedactor({ key: KEY });
  assert.equal(withoutList.redact('Kunde: ' + values.person).hits.length, 0);
  const withList = createRedactor({ key: KEY, allowWords: [values.person] });
  const hits = withList.redact('Kunde: ' + values.person + ' und ' + values.person).tokens;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'PERSON');
  assert.equal(hits[0].count, 2);
});

test('invalid configuration fails closed without echoing input', () => {
  assert.throws(() => createRedactor(), /requires an object/);
  assert.throws(() => createRedactor({}), /config.key must be a non-empty string/);
  assert.throws(() => createRedactor({ key: '' }), /config.key must be a non-empty string/);
  assert.throws(() => createRedactor({ key: 'k', kinds: 'EMAIL' }), /config.kinds must be an array/);
  assert.throws(() => createRedactor({ key: 'k', kinds: ['EMAIL', 'NOPE'] }), /unknown detector kind/);
  assert.throws(() => createRedactor({ key: 'k', allowWords: 'Max Mustermann' }), /config.allowWords must be an array/);
  assert.throws(() => createRedactor({ key: 'k', allowWords: [42] }), /config.allowWords must contain only strings/);
  assert.throws(() => createRedactor({ key: KEY }).redact(null), /requires a string/);
});

test('VERSION is exported', () => {
  assert.equal(VERSION, '0.1.0');
});
