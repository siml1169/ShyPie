import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { sha256Hex, hmacSha256Hex, tokenFor, VERSION } from '../index.js';

// Independent RFC 4648 Base32 (test-side reference implementation).
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

test('VERSION is 0.3.0', () => {
  assert.equal(VERSION, '0.3.0');
});

test('pure-JS SHA-256 matches node:crypto (empty, ASCII, Unicode, long)', () => {
  const cases = [
    '',
    'abc',
    'The quick brown fox jumps over the lazy dog',
    'üñïçødé',
    'Ümlaute ÄÖÜ ß',
    'emoji 😀🎉 and CJK 漢字',
    'a'.repeat(1000),
    "!@#$%^&*()_+-=[]{};':\",./<>?`~",
  ];
  for (const input of cases) {
    const expected = createHash('sha256').update(input, 'utf8').digest('hex');
    assert.equal(sha256Hex(input), expected, 'sha256 mismatch for input length ' + input.length);
  }
});

test('pure-JS SHA-256 matches node:crypto on control characters and lone surrogates', () => {
  const cases = ['\u0000\u0001\u007f\u0080\u00ff', '\uFEFF bom', '\uD800 lone', '\uDC00 lone low', '\uD83D\uDE00 pair'];
  for (const input of cases) {
    const expected = createHash('sha256').update(input, 'utf8').digest('hex');
    assert.equal(sha256Hex(input), expected, 'sha256 mismatch for surrogate/control case');
  }
});

test('pure-JS HMAC-SHA256 matches node:crypto (short, 64-byte, hashed-key paths)', () => {
  const cases = [
    { key: 'session-key-1', message: 'hello' },
    { key: 'session-key-1', message: '' },
    { key: 'k', message: 'IBAN\u0000DE00 3704 0044 0532 0130 00' },
    { key: 'x'.repeat(64), message: 'exactly-64-byte-key' },
    { key: 'y'.repeat(65), message: 'longer-than-block-key' },
    { key: 'üñïçødé-key-😀', message: 'Geburtsdatum: 12.03.1985' },
    { key: 'z'.repeat(200), message: 'w'.repeat(5000) },
  ];
  for (const { key, message } of cases) {
    const expected = createHmac('sha256', key).update(message, 'utf8').digest('hex');
    assert.equal(hmacSha256Hex(key, message), expected, 'hmac mismatch for key length ' + key.length);
  }
});

test('tokenFor is the keyed placeholder defined by the contract', () => {
  const key = 'session-key-1';
  const kind = 'IBAN';
  const value = 'DE00 3704 0044 0532 0130 00';
  const mac = createHmac('sha256', key).update(kind + '\u0000' + value, 'utf8').digest();
  const expected = '{{IBAN_' + base32(mac.subarray(0, 5)) + '}}';
  assert.equal(tokenFor(key, kind, value), expected);
  assert.match(tokenFor(key, kind, value), /^\{\{[A-Z][A-Z0-9]*_[A-Z2-7]{8}\}\}$/);
});

test('tokenFor is deterministic and keyed (no bare hash, no plaintext)', () => {
  const a = tokenFor('key-a', 'EMAIL', 'max.mustermann@example.invalid');
  const b = tokenFor('key-a', 'EMAIL', 'max.mustermann@example.invalid');
  const c = tokenFor('key-b', 'EMAIL', 'max.mustermann@example.invalid');
  const d = tokenFor('key-a', 'EMAIL', 'erika.mustermann@example.invalid');
  const e = tokenFor('key-a', 'PHONE', 'max.mustermann@example.invalid');
  assert.equal(a, b);
  assert.notEqual(a, c, 'different key must give a different token');
  assert.notEqual(a, d, 'different value must give a different token');
  assert.notEqual(a, e, 'different kind must give a different token');
  assert.equal(a.includes('mustermann'), false);
});

test('tokenFor rejects a missing/empty key and normalizes the kind', () => {
  assert.throws(() => tokenFor('', 'IBAN', 'x'), /non-empty string key/);
  assert.throws(() => tokenFor(undefined, 'IBAN', 'x'), /non-empty string key/);
  assert.match(tokenFor('k', 'iban', 'x'), /^\{\{IBAN_[A-Z2-7]{8}\}\}$/);
  assert.match(tokenFor('k', 'weird kind!', 'x'), /^\{\{WEIRD_KIND_[A-Z2-7]{8}\}\}$/);
});
