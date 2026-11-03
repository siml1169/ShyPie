/**
 * Synthetic fixture generators for the pii-core test suite.
 *
 * HARD RULE (docs/interface-contract.md I9): never use a real person's data. Every value below is
 * generated from a deterministic PRNG at test time, with checksums computed
 * programmatically. Names/addresses use the official German "Muster" style
 * placeholders. No fixture is read from disk and no user document is touched.
 */

export function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function randomDigits(rng, n) {
  let out = '';
  for (let i = 0; i < n; i++) out += String(Math.floor(rng() * 10));
  return out;
}

export function randomLetters(rng, n, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ') {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

/* --- local reference checksum implementations (independent of index.js) --- */

export function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function luhnCheckDigit(payload) {
  for (let d = 0; d <= 9; d++) {
    if (luhnValid(payload + String(d))) return String(d);
  }
  throw new Error('unreachable');
}

export function iso7064Mod1110Valid(digits) {
  let product = 10;
  for (let i = 0; i < digits.length - 1; i++) {
    let sum = (Number(digits[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(digits[digits.length - 1]);
}

export function iso7064CheckDigit(payload) {
  for (let d = 0; d <= 9; d++) {
    if (iso7064Mod1110Valid(payload + String(d))) return String(d);
  }
  throw new Error('unreachable');
}

function mod97(numericString) {
  let rem = 0;
  for (let i = 0; i < numericString.length; i++) {
    rem = (rem * 10 + Number(numericString[i])) % 97;
  }
  return rem;
}

/* --- valid synthetic values --- */

/** Valid German IBAN (ISO 13616 mod-97), 22 chars, synthetic BBAN. */
export function makeIban(rng, blz) {
  const bank = blz !== undefined ? String(blz) : randomDigits(rng, 8);
  const account = randomDigits(rng, 10);
  const bban = bank + account;
  const check = 98 - mod97(bban + '1314' + '00');
  const checkStr = check < 10 ? '0' + check : String(check);
  return 'DE' + checkStr + bban;
}

/** Valid German USt-IdNr (ISO 7064 MOD 11,10), 11 chars. */
export function makeVatId(rng) {
  const payload = randomDigits(rng, 8);
  return 'DE' + payload + iso7064CheckDigit(payload);
}

/** Valid German IdNr (11 digits, ISO 7064 MOD 11,10). */
export function makeIdNr(rng) {
  const payload = randomDigits(rng, 10);
  return payload + iso7064CheckDigit(payload);
}

/** Valid Visa-shaped card number (IIN 4, 16 digits, Luhn). */
export function makeCard(rng) {
  const payload = '4000' + randomDigits(rng, 11);
  return payload + luhnCheckDigit(payload);
}

/** Valid US SSN shape (area/group/serial rules of the SSA). */
export function makeUsSsn(rng) {
  const area = 101 + Math.floor(rng() * 700);
  const group = 1 + Math.floor(rng() * 99);
  const serial = 1 + Math.floor(rng() * 9999);
  return (
    String(area).padStart(3, '0') + '-' + String(group).padStart(2, '0') + '-' + String(serial).padStart(4, '0')
  );
}

/** Synthetic PEM-looking private key block (NOT a real key; base64 of random bytes). */
export function makePemBlock(rng) {
  let b64 = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let line = 0; line < 3; line++) {
    let chunk = '';
    for (let i = 0; i < 64; i++) chunk += alphabet[Math.floor(rng() * alphabet.length)];
    b64 += chunk + '\n';
  }
  return '-----BEGIN RSA PRIVATE KEY-----\n' + b64 + '-----END RSA PRIVATE KEY-----';
}

/** Synthetic short secret-ish token. */
export function makeApiKey(rng) {
  return 'sk-' + randomLetters(rng, 16, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
}

/** Long synthetic base64-ish blob (>= 2048 chars) — never real data. */
export function makeBase64Blob(rng, length = 3000) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

export function makeHexBlob(rng, length = 1200) {
  const alphabet = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

/* --- composite synthetic documents --- */

/** All synthetic values used by the detector/redactor tests. */
export function makeSampleValues(seed = 20261102) {
  const rng = makeRng(seed);
  const iban = makeIban(rng, '37040044');
  return {
    iban,
    vatid: makeVatId(rng),
    idnr: makeIdNr(rng),
    card: makeCard(rng),
    usSsn: makeUsSsn(rng),
    apiKey: makeApiKey(rng),
    pem: makePemBlock(rng),
    base64: makeBase64Blob(rng),
    hex: makeHexBlob(rng),
    email: 'max.mustermann@example.invalid',
    phoneIntl: '+49 30 12345678',
    phoneDe: '030 1234567',
    bic: 'COBADEFFXXX',
    person: 'Max Mustermann',
    street: 'Musterstraße 12',
    plzort: '10115 Berlin',
    dob: '12.03.1985',
    account: '1234567890',
    taxId: '12/345/67890',
    passport: 'C01X00T47',
    idCard: 'L01X00T47',
    deSsn: '12 345678 X 123',
    password: 'PASSWORD=hunter2-hunter2-hunter2',
  };
}

/** A realistic-looking synthetic business paragraph containing many PII kinds. */
export function makeParagraph(seed = 7) {
  const v = makeSampleValues(seed);
  return [
    'Rechnung Nr. ORD-2024-11-02-0042 vom 02.11.2024.',
    'Kunde: ' + v.person + ', ' + v.street + ', ' + v.plzort + '.',
    'E-Mail: ' + v.email + ', Telefon: ' + v.phoneIntl + ' / ' + v.phoneDe + '.',
    'Geburtsdatum: ' + v.dob + ', Personalausweis ' + v.idCard + '.',
    'IBAN: ' + v.iban + ' bei der ' + v.bic + ', Konto ' + v.account + '.',
    'Karte: ' + v.card + '. USt-IdNr: ' + v.vatid + ', Steuernummer ' + v.taxId + '.',
    'Sozialversicherungsnummer: ' + v.deSsn + ', SSN 123-45-6789.',
    'Reisepass ' + v.passport + ', ' + v.password + '.',
  ].join('\n');
}

/** ~targetChars synthetic document for the performance test (deterministic). */
export function makeLargeDocument(targetChars = 50000, seed = 99) {
  const rng = makeRng(seed);
  const parts = [];
  let length = 0;
  let i = 0;
  while (length < targetChars) {
    const iban = makeIban(rng);
    const vatid = makeVatId(rng);
    const card = makeCard(rng);
    const ssn = makeUsSsn(rng);
    const email = 'kunde.' + String(i) + '@example.invalid';
    const phone = '+49 30 ' + randomDigits(rng, 8);
    const street = 'Musterweg ' + (1 + Math.floor(rng() * 200));
    const plz = String(10000 + Math.floor(rng() * 80000));
    const chunk =
      'Vorgang ' + i + ': ' + email + '; Tel ' + phone + '; IBAN ' +
      iban + '; USt-IdNr ' + vatid + '; Karte ' + card + '; SSN ' + ssn +
      '; Adresse ' + street + ', ' + plz + ' Berlin; Geburtsdatum 12.03.1985; ' +
      'Steuernummer 12/345/67890; Konto 1234567890. ';
    parts.push(chunk);
    length += chunk.length;
    i++;
  }
  return parts.join('');
}

/** Text that must produce ZERO hits (negative cases from docs/interface-contract.md). */
export function makeNegativeDocument() {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const semver = 'v2.14.3-rc.1';
  const isoDate = '2024-01-15T22:06:38Z';
  const ip = '192.168.10.42';
  const orderId = 'ORD-2024-11-02-0042';
  const sha = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const shortB64 = 'c2hvcnQtYmFzZTY0LWZpeHR1cmUtdGhhdC1pcy1kZWxpYmVyYXRlbHktc2hvcnQ';
  const version = '1.2.3';
  const longVersion = '1.2.3.4.5.6';
  const timestamp = '2024-11-02 22:06:38';
  const numberList = '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15';
  return [
    'UUID ' + uuid,
    'Version ' + semver,
    'Zeitstempel ' + isoDate,
    'Host ' + ip,
    'Auftrag ' + orderId,
    'SHA256 ' + sha,
    'Base64 ' + shortB64,
    'Version ' + version + ' und ' + longVersion,
    'Zeit ' + timestamp,
    'Liste ' + numberList,
  ].join('\n');
}
