import test from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor, KINDS } from '../index.js';
import * as fx from './helpers/fixtures.mjs';

const KEY = 'test-session-key';

function make(config = {}) {
  return createRedactor({ key: KEY, ...config });
}

function scan(text, config = {}) {
  return make(config).scan(text);
}

function kindsOf(hits) {
  return hits.map((h) => h.kind);
}

const values = fx.makeSampleValues();
const rng = fx.makeRng(424242);
const pem = fx.makePemBlock(rng);
const apiKey = fx.makeApiKey(rng);

test('KINDS is the frozen contract catalogue in order', () => {
  assert.deepEqual(KINDS, [
    'SECRET', 'IBAN', 'BIC', 'EMAIL', 'PHONE', 'CARD', 'VATID', 'TAXID', 'IDNR', 'SSN',
    'PASSPORT', 'IDCARD', 'DOB', 'ADDRESS', 'ACCOUNT', 'PERSON', 'BLOB',
  ]);
  assert.equal(Object.isFrozen(KINDS), true);
});

test('every catalogue kind is detected on a synthetic sample', () => {
  const cases = [
    ['SECRET', pem],
    ['SECRET', apiKey],
    ['SECRET', 'PASSWORD=' + 'synthetic-value-123456'],
    ['IBAN', values.iban],
    ['BIC', 'COBADEFFXXX'],
    ['EMAIL', values.email],
    ['PHONE', values.phoneIntl],
    ['PHONE', values.phoneDe],
    ['CARD', values.card],
    ['VATID', values.vatid],
    ['TAXID', 'Steuernummer: ' + values.taxId],
    ['IDNR', values.idnr],
    ['SSN', 'SSN ' + values.usSsn],
    ['SSN', 'Sozialversicherungsnummer ' + values.deSsn],
    ['PASSPORT', 'Reisepass ' + values.passport],
    ['IDCARD', 'Personalausweis ' + values.idCard],
    ['DOB', 'Geburtsdatum: ' + values.dob],
    ['ADDRESS', values.street],
    ['ADDRESS', values.plzort],
    ['ACCOUNT', 'Konto ' + values.account],
    ['PERSON', values.person],
    ['BLOB', values.base64],
    ['BLOB', values.hex],
    ['BLOB', '%PDF-1.7'],
  ];
  for (const [kind, text] of cases) {
    const hits = scan(text, { allowWords: [values.person] });
    assert.ok(kindsOf(hits).includes(kind), 'expected ' + kind + ' in [' + kindsOf(hits).join(',') + '] for ' + kind + ' sample');
  }
});

test('hit shape is exactly { kind, start, end, length, source, valid }', () => {
  const hits = scan('Mail ' + values.email);
  assert.equal(hits.length, 1);
  assert.deepEqual(Object.keys(hits[0]).sort(), ['end', 'kind', 'length', 'source', 'start', 'valid']);
  assert.equal(hits[0].kind, 'EMAIL');
  assert.equal(hits[0].valid, true);
  assert.equal(hits[0].start, 5);
  assert.equal(hits[0].length, values.email.length);
  assert.equal(hits[0].end - hits[0].start, hits[0].length);
});

test('negative shapes from the contract produce no hits', () => {
  const negatives = [
    '550e8400-e29b-41d4-a716-446655440000', // UUID
    'v2.14.3-rc.1', // semver
    '1.2.3',
    '1.2.3.4.5.6',
    '2024-01-15T22:06:38Z', // ISO timestamp
    '192.168.10.42', // IP
    'ORD-2024-11-02-0042', // order id
    '2024-11-02 22:06:38', // timestamp
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // hex hash (64 chars)
    'c2hvcnQtYmFzZTY0LWZpeHR1cmUtdGhhdC1pcy1kZWxpYmVyYXRlbHktc2hvcnQ', // short base64
    '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15',
    'GEMEINDE STADT RATHAUS', // uppercase words must not look like a BIC
  ];
  for (const text of negatives) {
    assert.deepEqual(scan(text), [], 'unexpected hit for negative: ' + text);
  }
  assert.deepEqual(scan(fx.makeNegativeDocument()), []);
});

test('checksum failures are rejected (IBAN, CARD, VATID, IDNR)', () => {
  // IBAN with broken mod-97 (check digits replaced).
  const badIban = values.iban.slice(0, 2) + '00' + values.iban.slice(4);
  assert.equal(kindsOf(scan(badIban)).includes('IBAN'), false);

  // Card with broken Luhn.
  const last = Number(values.card[values.card.length - 1]);
  const badCard = values.card.slice(0, -1) + String((last + 1) % 10);
  assert.equal(kindsOf(scan(badCard)).includes('CARD'), false);

  // VATID and IdNr with a broken ISO 7064 MOD 11,10 check digit.
  const badVat = values.vatid.slice(0, -1) + String((Number(values.vatid.slice(-1)) + 1) % 10);
  assert.equal(kindsOf(scan(badVat)).includes('VATID'), false);
  const badIdNr = values.idnr.slice(0, -1) + String((Number(values.idnr.slice(-1)) + 1) % 10);
  assert.equal(kindsOf(scan(badIdNr)).includes('IDNR'), false);

  // 11 random digits with an invalid check digit must not be an IdNr.
  const eleven = '12345678901';
  assert.equal(fx.iso7064Mod1110Valid(eleven), false);
  assert.equal(kindsOf(scan(eleven)).includes('IDNR'), false);
});

test('documented BMF USt-IdNr example passes the ISO 7064 check', () => {
  // Public example from tax-authority documentation, not live customer data.
  const hits = scan('USt-IdNr DE136695976');
  assert.ok(kindsOf(hits).includes('VATID'));
});

test('IBAN variants: contiguous, spaced groups, lowercase', () => {
  const spaced = values.iban.replace(/(.{4})/g, '$1 ').trim();
  for (const variant of [values.iban, spaced, values.iban.toLowerCase()]) {
    const hits = scan('IBAN ' + variant + ' Ende');
    assert.ok(kindsOf(hits).includes('IBAN'), 'IBAN variant missed: ' + variant);
  }
  assert.equal(scan(values.iban.replace(/(.{4})/g, '$1 ').trim()).length, 1);
});

test('context detectors stay inside their keyword context', () => {
  // A bare date is not a DOB; only with the keyword.
  assert.equal(kindsOf(scan('am 12.03.1985')).includes('DOB'), false);
  assert.equal(kindsOf(scan('Geburtsdatum: 12.03.1985')).includes('DOB'), true);
  // A bare SSN shape is not a US SSN without context.
  assert.equal(kindsOf(scan('Nummer 123-45-6789')).includes('SSN'), false);
  assert.equal(kindsOf(scan('SSN 123-45-6789')).includes('SSN'), true);
  // Steuernummer only with its keyword.
  assert.equal(kindsOf(scan('Nummer 12/345/67890')).includes('TAXID'), false);
  // A passport-shaped token without the keyword is not a passport.
  assert.equal(kindsOf(scan('Code C01X00T47')).includes('PASSPORT'), false);
});

test('phone detection does not eat timestamps, order ids or version numbers', () => {
  for (const text of ['2024-11-02T22:06:38', '12.03.2024', '02/2024', '2024-11-02', '1.2.3', 'ORD-2024-11-02-0042']) {
    assert.equal(kindsOf(scan(text)).includes('PHONE'), false, 'phone false positive for: ' + text);
  }
});

test('BLOB is a block signal for long base64/hex and PDF/ZIP magic', () => {
  const blobHits = scan(values.base64).filter((h) => h.kind === 'BLOB');
  assert.equal(blobHits.length, 1);
  assert.equal(blobHits[0].source, 'blob:base64');
  assert.equal(blobHits[0].length, values.base64.length);

  const hexHits = scan(values.hex).filter((h) => h.kind === 'BLOB');
  assert.equal(hexHits.length, 1);
  assert.equal(hexHits[0].source, 'blob:hex');

  assert.ok(kindsOf(scan('%PDF-1.7')).includes('BLOB'));
  assert.ok(kindsOf(scan('PK\u0003\u0004binary')).includes('BLOB'));
});

test('priority resolution: EMAIL beats BIC inside an uppercase address', () => {
  const hits = scan('MAX.MUSTERMANN@COBADEFF.DE');
  assert.deepEqual(kindsOf(hits), ['EMAIL']);
});

test('priority resolution: URL credentials beat EMAIL', () => {
  const hits = scan('https://user:' + 'pa55word' + '@example.invalid/x');
  assert.ok(kindsOf(hits).includes('SECRET'));
  assert.equal(kindsOf(hits).includes('EMAIL'), false);
});

test('existing placeholders are never re-detected', async () => {
  const { tokenFor } = await import('../index.js');
  const token = tokenFor(KEY, 'EMAIL', values.email);
  assert.deepEqual(scan('Wert ' + token + ' Ende'), []);
  // Rewritten placeholder shapes are excluded from detection too.
  assert.deepEqual(scan('Wert ' + token.toLowerCase() + ' Ende'), []);
});

test('PERSON only fires for allowWords and only as a whole word', () => {
  assert.equal(kindsOf(scan(values.person)).includes('PERSON'), false);
  assert.ok(kindsOf(scan(values.person, { allowWords: [values.person] })).includes('PERSON'));
  assert.equal(kindsOf(scan('Maximilian Mustermann', { allowWords: [values.person] })).includes('PERSON'), false);
});

test('scan respects the kinds allowlist', () => {
  const hits = scan('Mail ' + values.email + ' IBAN ' + values.iban, { kinds: ['EMAIL'] });
  assert.deepEqual(kindsOf(hits), ['EMAIL']);
  assert.throws(() => make({ kinds: ['NOPE'] }), /unknown detector kind/);
});
