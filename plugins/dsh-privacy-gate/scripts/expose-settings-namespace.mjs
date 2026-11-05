/**
 * Expose the `privacy-gate` settings namespace to the DSH Web client.
 *
 * DSH 0.2.1-rc.5 hard-codes which settings namespaces cross the api-proxy boundary:
 * `WEB_SETTINGS_NAMESPACES` in `@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.js`. A
 * namespace that is registered but absent from that list answers `settings-not-exposed`, so the
 * Settings page cannot read or write it. Until the host lets a plugin declare its own exposure
 * (the doc comment there calls that "deferred work"), the array has to be patched.
 *
 * The patch is idempotent, writes a `.bak-shypie` backup next to the file, and is lost when DSH
 * updates the package — re-run it after an update. `--revert` restores the backup.
 *
 *   node scripts/expose-settings-namespace.mjs
 *   node scripts/expose-settings-namespace.mjs --revert
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NAMESPACE = 'privacy-gate'
const RELATIVE = join('profiles', 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'types', 'api-proxy.js')

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

function main(argv) {
  const target = join(dshHome(), RELATIVE)
  const backup = `${target}.bak-shypie`
  const revert = argv.includes('--revert')

  if (!existsSync(target)) {
    console.error(`not found: ${target}`)
    console.error('Set DSH_HOME if DeepSeek Harness keeps its home somewhere else.')
    process.exitCode = 1
    return
  }

  if (revert) {
    if (!existsSync(backup)) {
      console.error(`no backup at ${backup}; nothing to revert`)
      process.exitCode = 1
      return
    }
    copyFileSync(backup, target)
    console.log(`reverted ${target} from ${backup}`)
    return
  }

  const source = readFileSync(target, 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.includes('const WEB_SETTINGS_NAMESPACES = ['))
  if (start < 0) {
    console.error('WEB_SETTINGS_NAMESPACES not found; this DSH build may already support plugin-declared exposure')
    process.exitCode = 1
    return
  }

  let end = start
  while (end < lines.length && !lines[end].includes(']')) end += 1
  if (end >= lines.length) {
    console.error('could not find the end of the allowlist array')
    process.exitCode = 1
    return
  }

  const array = lines.slice(start, end + 1)
  if (array.some((line) => line.includes(`'${NAMESPACE}'`))) {
    console.log(`${NAMESPACE} is already exposed; nothing to do`)
    return
  }

  if (!existsSync(backup)) copyFileSync(target, backup)

  const insertAt = end
  const indent = (lines[start + 1] ?? '    ').match(/^\s*/)[0]
  lines.splice(insertAt, 0, `${indent}'${NAMESPACE}',`)
  writeFileSync(target, lines.join('\n'), 'utf8')
  console.log(`exposed ${NAMESPACE} in ${target}`)
  console.log(`backup: ${backup} (re-run with --revert to restore)`)
}

main(process.argv.slice(2))
