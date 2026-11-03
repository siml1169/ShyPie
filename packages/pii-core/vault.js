/**
 * @shypie_privacy/pii-core/vault — Node-only encrypted placeholder vault.
 *
 * Contract: ShyPie/docs/interface-contract.md.
 *   createVault({ dir }) -> { put(token, kind, value), get(token), save(redactor),
 *                              load(), path, wipe() }
 *
 * Invariants implemented here:
 *  - I5  values live in memory only during a session; persistence is AES-256-GCM
 *        with a 32-byte key file chmod 0600 and a 0600 vault file. No plaintext
 *        audit log and no plaintext anywhere on disk.
 *  - I10 the vault file stores { token, kind, value } encrypted; it never writes
 *        a plaintext mapping, and no value is ever logged.
 *
 * This file is the only Node-aware entry point of the package; `index.js` stays
 * standard-ECMAScript-only so it can also be vendored into Magpie's moejs plugin.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const MAGIC = Buffer.from('PIIVL1\n', 'ascii');
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort: Windows does not model POSIX dir modes */
  }
}

function chmod600(file) {
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort: Windows only maps the write bit */
  }
}

function readKey(keyPath) {
  if (!existsSync(keyPath)) {
    const key = randomBytes(KEY_LEN);
    writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
    chmod600(keyPath);
    return key;
  }
  const key = readFileSync(keyPath);
  if (key.length !== KEY_LEN) {
    throw new Error('vault: existing key file has invalid length ' + key.length + '; refusing to continue');
  }
  chmod600(keyPath);
  return key;
}

function encrypt(key, payload) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(payload, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decrypt(key, blob) {
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('vault: vault file is truncated');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('vault: not a pii-core vault file');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function secureDelete(file) {
  if (!existsSync(file)) return;
  try {
    const stat = statSync(file);
    if (stat.isFile() && stat.size > 0) {
      writeFileSync(file, randomBytes(stat.size));
    }
  } catch {
    /* fall through to unlink */
  }
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * Create a placeholder vault rooted at `dir`.
 * Values are held in memory; call save() to persist them encrypted.
 */
export function createVault(config) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('vault: createVault({ dir }) requires an object');
  }
  if (typeof config.dir !== 'string' || config.dir.length === 0) {
    throw new TypeError('vault: config.dir must be a non-empty string');
  }
  const dir = resolve(config.dir);
  ensureDir(dir);
  const filePath = join(dir, 'vault.enc');
  const keyPath = join(dir, 'vault.key');
  const entries = new Map(); // token -> { kind, value }

  function key() {
    return readKey(keyPath);
  }

  function snapshot(redactor) {
    const seen = new Set();
    const list = [];
    const push = (entry) => {
      if (entry === null || typeof entry !== 'object') return;
      if (typeof entry.token !== 'string' || entry.token.length === 0) return;
      if (typeof entry.value !== 'string') return;
      if (entry.kind === 'SECRET' || entry.kind === 'BLOB') return; // never persist these
      if (seen.has(entry.token)) return;
      seen.add(entry.token);
      list.push({ token: entry.token, kind: String(entry.kind), value: entry.value });
    };
    entries.forEach((entry, token) => push({ token, kind: entry.kind, value: entry.value }));
    if (redactor !== null && redactor !== undefined && typeof redactor._entries === 'function') {
      const redactorEntries = redactor._entries();
      for (let i = 0; i < redactorEntries.length; i++) push(redactorEntries[i]);
    }
    return list;
  }

  const vault = {
    /** Path of the encrypted vault file. */
    path: filePath,

    /** Stage a token -> value mapping in memory (persisted by save()). */
    put(token, kind, value) {
      if (typeof token !== 'string' || token.length === 0) throw new TypeError('vault.put: token must be a non-empty string');
      if (typeof value !== 'string') throw new TypeError('vault.put: value must be a string');
      entries.set(token, { kind: String(kind), value });
      return vault;
    },

    /** Look up a value for a token (in memory only; null when unknown). */
    get(token) {
      const entry = entries.get(token);
      return entry === undefined ? undefined : entry.value;
    },

    /** Encrypt the in-memory map plus (optionally) a redactor's tokens to disk. */
    save(redactor) {
      const list = snapshot(redactor);
      const blob = encrypt(key(), JSON.stringify({ version: 1, entries: list }));
      const tmpPath = filePath + '.tmp';
      writeFileSync(tmpPath, blob, { mode: 0o600 });
      chmod600(tmpPath);
      renameSync(tmpPath, filePath);
      chmod600(filePath);
      return vault;
    },

    /** Decrypt a saved vault into memory. Optionally re-hydrates a redactor. */
    load(redactor) {
      if (!existsSync(filePath)) return vault;
      const blob = readFileSync(filePath);
      const parsed = JSON.parse(decrypt(key(), blob));
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
        throw new Error('vault: vault file has an unexpected structure');
      }
      const loaded = [];
      for (let i = 0; i < parsed.entries.length; i++) {
        const entry = parsed.entries[i];
        if (entry === null || typeof entry !== 'object') continue;
        if (typeof entry.token !== 'string' || typeof entry.value !== 'string') continue;
        entries.set(entry.token, { kind: String(entry.kind), value: entry.value });
        loaded.push({ token: entry.token, kind: String(entry.kind), value: entry.value });
      }
      if (redactor !== null && redactor !== undefined && typeof redactor._hydrate === 'function') {
        redactor._hydrate(loaded);
      }
      return vault;
    },

    /** Wipe in-memory values and securely delete the vault + key files. */
    wipe() {
      entries.clear();
      secureDelete(filePath);
      secureDelete(keyPath);
      return vault;
    },
  };

  return vault;
}

export default { createVault };
