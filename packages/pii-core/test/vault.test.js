import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault } from '../vault.js';
import { createRedactor } from '../index.js';
import * as fx from './helpers/fixtures.mjs';

const values = fx.makeSampleValues();

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pii-core-vault-'));
}

function containsPlaintext(file, valuesToCheck) {
  const bytes = readFileSync(file);
  return valuesToCheck.some((value) => bytes.includes(Buffer.from(value, 'utf8')));
}

test('put/get works and save/load persists only ciphertext', () => {
  const dir = tempDir();
  const vault = createVault({ dir });
  assert.equal(vault.path, join(dir, 'vault.enc'));

  vault.put('{{IBAN_AAAAAAAA}}', 'IBAN', values.iban);
  assert.equal(vault.get('{{IBAN_AAAAAAAA}}'), values.iban);
  assert.equal(vault.get('{{IBAN_BBBBBBBB}}'), undefined);

  vault.save();
  assert.equal(existsSync(join(dir, 'vault.enc')), true);
  assert.equal(existsSync(join(dir, 'vault.key')), true);
  assert.equal(readFileSync(join(dir, 'vault.key')).length, 32);
  assert.equal(containsPlaintext(join(dir, 'vault.enc'), [values.iban]), false);
  assert.equal(containsPlaintext(join(dir, 'vault.key'), [values.iban]), false);

  const reopened = createVault({ dir });
  reopened.load();
  assert.equal(reopened.get('{{IBAN_AAAAAAAA}}'), values.iban);
});

test('save(redactor) + load(redactor) restores placeholders across sessions', () => {
  const dir = tempDir();
  const sessionKey = 'vault-session-key';
  const first = createRedactor({ key: sessionKey });
  const original = 'IBAN ' + values.iban + ', Mail ' + values.email;
  const redacted = first.redact(original);
  createVault({ dir }).save(first);

  const second = createRedactor({ key: sessionKey });
  const loaded = createVault({ dir });
  loaded.load(second);
  assert.equal(second.restore(redacted.text), original);
});

test('SECRET and BLOB values are never persisted', () => {
  const dir = tempDir();
  const rng = fx.makeRng(11);
  const apiKey = fx.makeApiKey(rng);
  const r = createRedactor({ key: 'key' });
  const blob = fx.makeBase64Blob(rng);
  const out = r.redact('Login ' + apiKey + ' blob ' + blob);
  const secretToken = out.tokens.find((t) => t.kind === 'SECRET').token;
  createVault({ dir }).save(r);

  const file = join(dir, 'vault.enc');
  assert.equal(containsPlaintext(file, [apiKey, blob]), false);

  const reopened = createVault({ dir });
  reopened.load();
  assert.equal(reopened.get(secretToken), undefined);
});

test('key file is chmod 0600 where the platform models POSIX modes', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir();
  createVault({ dir }).save();
  const mode = statSync(join(dir, 'vault.key')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('a tampered vault fails closed (AES-256-GCM authentication)', () => {
  const dir = tempDir();
  const vault = createVault({ dir });
  vault.put('{{EMAIL_AAAAAAAA}}', 'EMAIL', values.email);
  vault.save();
  const file = join(dir, 'vault.enc');
  const blob = readFileSync(file);
  blob[blob.length - 1] = blob[blob.length - 1] ^ 0xff;
  writeFileSync(file, blob);

  const reopened = createVault({ dir });
  assert.throws(() => reopened.load(), /authenticate|authentication|unable to/i);
});

test('wipe() clears memory and deletes vault + key files', () => {
  const dir = tempDir();
  const vault = createVault({ dir });
  vault.put('{{EMAIL_AAAAAAAA}}', 'EMAIL', values.email);
  vault.save();
  vault.wipe();
  assert.equal(vault.get('{{EMAIL_AAAAAAAA}}'), undefined);
  assert.equal(existsSync(join(dir, 'vault.enc')), false);
  assert.equal(existsSync(join(dir, 'vault.key')), false);
});

test('createVault validates its configuration', () => {
  assert.throws(() => createVault(), /requires an object/);
  assert.throws(() => createVault({}), /config.dir must be a non-empty string/);
  assert.throws(() => createVault({ dir: '' }), /config.dir must be a non-empty string/);
});

test('a wrong-length key file is refused instead of silently replaced', () => {
  const dir = tempDir();
  createVault({ dir }).save();
  writeFileSync(join(dir, 'vault.key'), Buffer.from('too-short'));
  assert.throws(() => createVault({ dir }).save(), /key file has invalid length/);
});
