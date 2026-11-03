/**
 * Activation smoke test: import `index.js` exactly as the Loader would (bare
 * package specifiers resolved by the plugin's node_modules), validate the
 * schemastery `Config`, and run `apply()` against a fake context with the real
 * vendored core.
 *
 * Run by hand when the bundle changes:
 *   node scripts/activation-check.mjs
 * It writes no files: the artifact writer in `index.js` is never called here,
 * and the placeholder key is pointed at an existing synthetic fixture.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const { Config, apply, inject, name } = await import(new URL('../index.js', import.meta.url).href)

if (name !== 'privacy-gate') throw new Error(`unexpected plugin name ${name}`)
if (!Array.isArray(inject) || !inject.includes('tools')) throw new Error('inject must request the tools service')

const validated = Config({
  allowPaths: [],
  detectors: [],
  personWords: [],
  extractCli: '',
  audit: { enabled: false, path: '' },
  placeholderKey: { file: '' },
  blockNonTextResults: true,
  artifactDir: '',
  toolTimeoutMs: 5000,
  maxExtractChars: 1000,
})
if (validated.allowPaths.join(',') !== '') throw new Error('Config did not preserve allowPaths')

const listeners = new Map()
const guards = []
const tools = []
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  on(event, callback) {
    const list = listeners.get(event) ?? []
    list.push(callback)
    listeners.set(event, list)
    return () => {}
  },
  tools: {
    guard(fn) {
      guards.push(fn)
      return () => {}
    },
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
}

// A synthetic key file so activation never touches the real profile. The
// scratch directory stays inside this package (the check must not write
// anywhere else) and is removed again below.
const scratch = join(PLUGIN, '.scratch')
mkdirSync(scratch, { recursive: true })
const keyFile = join(scratch, 'placeholder.key')
writeFileSync(keyFile, `${'a'.repeat(64)}\n`, 'utf8')

try {
  await apply(ctx, {
      allowPaths: [],
    detectors: [],
    personWords: [],
    extractCli: join(PLUGIN, '..', '..', 'packages', 'local-extract', 'cli.js'),
    audit: { enabled: false, path: '' },
    placeholderKey: { file: keyFile },
    blockNonTextResults: true,
    artifactDir: join(scratch, 'artifacts'),
    toolTimeoutMs: 5000,
    maxExtractChars: 1000,
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const expectedListeners = ['tools/post-execute', 'agent/pre-step', 'tools/ptc-dispatch-log']
for (const event of expectedListeners) {
  if ((listeners.get(event) ?? []).length !== 1) throw new Error(`missing listener for ${event}`)
}
if (guards.length !== 1) throw new Error(`expected one tool guard, got ${guards.length}`)
const names = tools.map((tool) => tool.name).sort()
if (names.join(',') !== 'privacy_extract,privacy_ocr,privacy_rehydrate,privacy_scan') {
  throw new Error(`unexpected tools: ${names.join(',')}`)
}
console.log(`activation-check: ok — listeners ${expectedListeners.length}, guards ${guards.length}, tools ${names.length}`)
