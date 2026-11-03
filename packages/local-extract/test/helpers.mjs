// Shared test helpers: spawn the CLI with a hard timeout and interpret results.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.join(HERE, '..', 'cli.js');
export const FIXTURES = path.join(HERE, 'fixtures');

export const fixture = (name) => path.join(FIXTURES, name);

export function runCli(args, { env = {}, timeoutMs = 240_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

export function assertBlock(result, reason) {
  assert.equal(result.code, 3, `expected exit 3, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.ok(result.json, 'block output must be JSON');
  assert.equal(result.json.ok, false);
  assert.equal(result.json.blocked, true);
  assert.equal(result.json.reason, reason);
  assert.equal(typeof result.json.detail, 'string');
  assert.deepEqual(Object.keys(result.json).sort(), ['blocked', 'detail', 'ok', 'reason']);
  // Fail closed: a block never carries extracted content.
  assert.equal(result.json.text, undefined);
}

export function assertSuccess(result, expected = {}) {
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.ok(result.json, 'success output must be JSON');
  assert.equal(result.json.ok, true);
  assert.equal(result.json.text.length > 0, true, 'success must not be empty');
  assert.equal(result.json.chars, result.json.text.length);
  assert.equal(typeof result.json.elapsedMs, 'number');
  assert.ok(Array.isArray(result.json.warnings));
  if (expected.mode) assert.equal(result.json.mode, expected.mode);
  if (expected.engine) assert.equal(result.json.engine, expected.engine);
}
