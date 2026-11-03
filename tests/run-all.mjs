// Run every test suite in the privacy-first workflow and print one summary.
// Usage: node tests/run-all.mjs [--verbose]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const verbose = process.argv.includes('--verbose')

const suites = [
  ['pii-core', join(ROOT, 'packages', 'pii-core')],
  ['local-extract', join(ROOT, 'packages', 'local-extract')],
  ['dsh-privacy-gate', join(ROOT, 'plugins', 'dsh-privacy-gate')],
  ['magpie-privacy-gate', join(ROOT, 'plugins', 'magpie-privacy-gate')],
  ['e2e', join(ROOT, 'tests', 'e2e')],
]

function testFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === '.tmp') continue
      const p = join(d, entry)
      const s = statSync(p)
      if (s.isDirectory()) walk(p)
      else if (/\.test\.(mjs|js|cjs)$/.test(entry)) out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

let failed = 0
const rows = []
for (const [name, dir] of suites) {
  if (!existsSync(dir)) {
    rows.push({ name, status: 'MISSING', detail: `${dir} does not exist` })
    failed++
    continue
  }
  const files = testFiles(dir)
  const harness = join(dir, 'test', 'harness.mjs')
  let args
  if (files.length > 0) args = ['--test', ...files]
  else if (existsSync(harness)) args = [harness]
  else {
    rows.push({ name, status: 'NO TESTS', detail: 'nothing matched *.test.* and no test/harness.mjs' })
    continue
  }
  const t0 = Date.now()
  const run = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' })
  const ms = Date.now() - t0
  const ok = run.status === 0
  if (!ok) failed++
  const tail = (run.stdout || '').split('\n').filter((l) => /^(# pass|# fail|# tests|not ok)/.test(l)).slice(-8).join(' | ')
  rows.push({ name, status: ok ? 'PASS' : 'FAIL', detail: `${ms} ms${tail ? ' | ' + tail : ''}` })
  if (verbose || !ok) {
    console.log(`\n===== ${name} (${ok ? 'pass' : 'FAIL'}) =====`)
    console.log(run.stdout)
    if (run.stderr) console.error(run.stderr)
  }
}

console.log('\n===== privacy-first workflow: test summary =====')
for (const r of rows) console.log(`${r.status.padEnd(9)} ${r.name.padEnd(20)} ${r.detail}`)
console.log(failed === 0 ? '\nall suites passed' : `\n${failed} suite(s) failed`)
process.exit(failed === 0 ? 0 : 1)
