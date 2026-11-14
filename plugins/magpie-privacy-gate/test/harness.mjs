// Run the canonical Magpie middleware cases under the same bare-runtime
// conditions the gateway uses: no Node APIs, only the module's exports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const source = readFileSync(join(PLUGIN, "gate.middleware.js"), "utf8").replace(/^export /gm, "");
const cases = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));

const sandbox = { console: { log() {} } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "gate.middleware.js" });

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

async function run(c) {
  let rejected;
  const ctx = {
    protocol: "anthropic", model: "", stream: false, path: "",
    ...c.ctx,
    options: c.options ?? {},
    state: {},
    reject(status, message) { rejected ??= { status, message }; },
  };
  if (!c.request) return { request: undefined, rejected };
  const out = await sandbox.onRequest(copy(c.request), ctx);
  if (!rejected && c.provider && sandbox.onProvider) {
    const p = await sandbox.onProvider(copy(out === undefined ? c.request : out), { ...ctx, provider: c.provider });
    return { request: p === undefined || p === null ? (out === undefined ? c.request : out) : copy(p), rejected };
  }
  return { request: out === undefined ? c.request : copy(out), rejected };
}

let failed = 0;
for (const c of cases) {
  const got = await run(c);
  try {
    if (c.reject) {
      assert.equal(got.rejected?.status, c.reject.status, "reject status");
      if (c.reject.message) assert.ok(String(got.rejected?.message).includes(c.reject.message), "reject message");
    } else {
      assert.equal(got.rejected, undefined, "unexpected reject");
      assert.deepEqual(got.request, c.expect_request ?? c.request);
    }
    console.log(`ok ${cases.indexOf(c) + 1}/${cases.length}: ${c.name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${c.name}: ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
