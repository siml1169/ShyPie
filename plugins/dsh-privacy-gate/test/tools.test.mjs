import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildToolDefinitions, resolveArtifactPath } from '../lib/tools.js'
import { FIXTURE, makeFakePii, makeFakeRedactor, makeGateDeps } from './helpers.mjs'

/** Build the tools with a fake local extractor and a recording artifact writer. */
function setup(overrides = {}) {
  const redactor = overrides.redactor === undefined ? makeFakeRedactor() : overrides.redactor
  const pii = overrides.pii === undefined ? makeFakePii(redactor ?? makeFakeRedactor()) : overrides.pii
  const written = []
  const calls = []
  const config = { ...makeGateDeps().config, artifactDir: 'C:/workflow/artifacts' }
  const tools = buildToolDefinitions({
    config,
    redactor,
    pii,
    runExtract: async (options) => {
      calls.push(options)
      return overrides.extract ? overrides.extract(options) : { ok: true, mode: 'pdf', engine: 'pdftotext', text: `IBAN ${FIXTURE.iban}`, pages: 2, warnings: [] }
    },
    writeArtifact: (path, content) => written.push({ path, content }),
    audit: { record() { return true } },
    hashPath: (path) => `hash:${String(path).length}`,
  })
  return { tools, byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])), written, calls, config }
}

test('the bundle registers exactly the five documented tools with raw schemas', () => {
  const { tools } = setup()
  assert.deepEqual(tools.map((tool) => tool.name), ['privacy_extract', 'privacy_ocr', 'privacy_scan', 'privacy_rehydrate', 'privacy_session'])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(tool.output.schema.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
  }
})

test('privacy_extract returns only masked text', async () => {
  const { byName } = setup()
  const value = await byName.privacy_extract.execute({ path: 'C:/workflow/fixtures/invoice.pdf', mode: 'pdf' })
  assert.equal(value.redacted, true)
  assert.ok(!value.text.includes(FIXTURE.iban), 'no plaintext may leave the tool')
  assert.match(value.text, /\{\{IBAN_[A-Z0-9]{8}\}\}/)
  assert.deepEqual(value.tokens, [{ kind: 'IBAN', count: 1, length: FIXTURE.iban.length }])
  assert.equal(value.pages, 2)
  assert.deepEqual(value.warnings, [])
})

test('privacy_extract refuses a document outside allowPaths without spawning the extractor', async () => {
  const { byName, calls } = setup()
  await assert.rejects(
    () => byName.privacy_extract.execute({ path: 'C:/Users/x/invoice.pdf' }),
    /outside allowPaths/,
  )
  assert.equal(calls.length, 0, 'no local reader may be invoked for a refused path')
})

test('privacy_extract refuses a .. traversal out of allowPaths', async () => {
  const { byName, calls } = setup()
  await assert.rejects(
    () => byName.privacy_extract.execute({ path: 'C:/workflow/../../Users/x/invoice.pdf' }),
    /outside allowPaths/,
  )
  assert.equal(calls.length, 0)
})

test('privacy_extract allows a .. that stays inside allowPaths', async () => {
  const { byName } = setup()
  await byName.privacy_extract.execute({ path: 'C:/workflow/sub/../fixtures/invoice.pdf' })
})

test('privacy_extract refuses everything when allowPaths is empty (fail closed)', async () => {
  const tools = buildToolDefinitions({
    ...makeGateDeps(),
    config: { ...makeGateDeps().config, allowPaths: [] },
    runExtract: async () => ({ ok: true, mode: 'pdf', engine: 'pdftotext', text: 'x', pages: 1, warnings: [] }),
    writeArtifact: () => {},
    pii: makeFakePii(makeFakeRedactor()),
    hashPath: () => 'h',
  })
  const tool = tools.find((entry) => entry.name === 'privacy_extract')
  await assert.rejects(() => tool.execute({ path: 'C:/workflow/fixtures/invoice.pdf' }), /outside allowPaths/)
})

test('privacy_ocr forces OCR mode at the CLI', async () => {
  const { byName, calls } = setup()
  await byName.privacy_ocr.execute({ path: 'C:/workflow/fixtures/scan.pdf', lang: 'deu+eng' })
  assert.equal(calls[0].mode, 'ocr')
  assert.equal(calls[0].lang, 'deu+eng')
  assert.equal(calls[0].timeoutMs, 1000)
})

test('a blocked local conversion is a tool error that carries no content', async () => {
  for (const reason of ['NO_LOCAL_OCR', 'NOT_A_DOCUMENT', 'ENCRYPTED_PDF']) {
    const { byName } = setup({ extract: () => ({ ok: false, blocked: true, reason }) })
    await assert.rejects(
      () => byName.privacy_extract.execute({ path: 'C:/workflow/fixtures/scan.pdf' }),
      (error) => {
        assert.match(error.message, new RegExp(`local conversion blocked \\(${reason}\\)`))
        assert.ok(!error.message.includes(FIXTURE.iban))
        return true
      },
    )
  }
})

test('an extractor that returns no result fails closed', async () => {
  const { byName } = setup({ extract: () => null })
  await assert.rejects(() => byName.privacy_extract.execute({ path: 'C:/x/a.pdf' }), /returned no result/)
})

test('extracted text carrying a binary payload is withheld', async () => {
  const { byName } = setup({ extract: () => ({ ok: true, mode: 'pdf', engine: 'x', text: 'A'.repeat(4000), warnings: [] }) })
  await assert.rejects(() => byName.privacy_extract.execute({ path: 'C:/x/a.pdf' }), /binary payload \(BLOB\)/)
})

test('privacy_scan masks and summarizes without echoing values', async () => {
  const { byName } = setup()
  const value = await byName.privacy_scan.execute({ text: `contact ${FIXTURE.email}` })
  assert.ok(!value.text.includes(FIXTURE.email))
  assert.equal(value.redacted, true)
  assert.deepEqual(value.hits, [{ kind: 'EMAIL', count: 1, length: FIXTURE.email.length }])
  assert.ok(!JSON.stringify(value).includes(FIXTURE.email))
})

test('privacy_scan rejects malformed arguments with a tool error', async () => {
  const { byName } = setup()
  await assert.rejects(() => byName.privacy_scan.execute({}), /missing required argument "text"/)
  await assert.rejects(() => byName.privacy_scan.execute({ text: 'x', extra: 1 }), /unknown argument "extra"/)
  await assert.rejects(() => byName.privacy_scan.execute({ text: 42 }), /argument "text" must be a string/)
})

test('privacy_rehydrate writes the plaintext locally and returns only path and counts', async () => {
  const redactor = makeFakeRedactor()
  const redacted = redactor.redact(`IBAN ${FIXTURE.iban}`).text
  const { byName, written } = setup({ redactor })
  const value = await byName.privacy_rehydrate.execute({ text: redacted, artifact_path: 'restored/invoice.txt' })
  assert.equal(written.length, 1)
  assert.ok(written[0].content.includes(FIXTURE.iban), 'the artifact holds the real value locally')
  assert.equal(value.replaced, 1)
  assert.deepEqual(value.kinds, ['IBAN'])
  assert.ok(!JSON.stringify(value).includes(FIXTURE.iban), 'the tool result must not carry the value')
  assert.equal(written[0].path.replace(/\\/g, '/'), 'C:/workflow/artifacts/restored/invoice.txt')
})

test('privacy_rehydrate refuses to write outside the artifact directory', async () => {
  const redactor = makeFakeRedactor()
  const redacted = redactor.redact(FIXTURE.iban).text
  const { byName, written } = setup({ redactor })
  await assert.rejects(
    () => byName.privacy_rehydrate.execute({ text: redacted, artifact_path: '../../../etc/passwd' }),
    /must stay inside the configured artifact directory/,
  )
  await assert.rejects(
    () => byName.privacy_rehydrate.execute({ text: redacted, artifact_path: 'C:/Windows/System32/x.txt' }),
    /must stay inside the configured artifact directory/,
  )
  assert.equal(written.length, 0)
})

test('privacy_rehydrate refuses when there is no placeholder to restore', async () => {
  const redactor = makeFakeRedactor()
  const { byName, written } = setup({ redactor })
  await assert.rejects(() => byName.privacy_rehydrate.execute({ text: 'plain text', artifact_path: 'a.txt' }), /no placeholders found/)
  assert.equal(written.length, 0)
})

test('every tool fails closed when the redactor is unavailable', async () => {
  const { byName } = setup({ redactor: null, pii: null })
  await assert.rejects(() => byName.privacy_extract.execute({ path: 'C:/x/a.pdf' }), /redaction is unavailable/)
  await assert.rejects(() => byName.privacy_scan.execute({ text: 'x' }), /redaction is unavailable/)
  await assert.rejects(() => byName.privacy_rehydrate.execute({ text: '{{IBAN_AAAAAAAA}}', artifact_path: 'a.txt' }), /redaction is unavailable/)
})

test('resolveArtifactPath keeps a relative name inside the directory', () => {
  const resolved = resolveArtifactPath('a/b.txt', 'C:/workflow/artifacts')
  assert.equal(resolved.replace(/\\/g, '/'), 'C:/workflow/artifacts/a/b.txt')
  assert.equal(resolveArtifactPath('C:/workflow/artifacts/c.txt', 'C:/workflow/artifacts').replace(/\\/g, '/'), 'C:/workflow/artifacts/c.txt')
  assert.throws(() => resolveArtifactPath('C:/Windows/x.txt', 'C:/workflow/artifacts'))
  assert.throws(() => resolveArtifactPath('../escape.txt', 'C:/workflow/artifacts'))
})

/** Build only the session tool with a recording registry. */
function sessionTool(configOverrides = {}) {
  const state = { enabled: false, explicit: false }
  const sessions = {
    status: () => ({ scope: 'session', enabled: state.enabled, explicit: state.explicit, sessionId: 's-1' }),
    setEnabled: (_id, value) => { state.enabled = value; state.explicit = true },
  }
  const tools = buildToolDefinitions({
    config: { ...makeGateDeps().config, ...configOverrides },
    redactor: makeFakeRedactor(),
    pii: makeFakePii(makeFakeRedactor()),
    runExtract: async () => { throw new Error('not used') },
    writeArtifact: () => {},
    audit: { record: () => true },
    hashPath: (p) => `hash:${String(p).length}`,
    sessions,
  })
  const tool = tools.find((candidate) => candidate.name === 'privacy_session')
  return { tool, state }
}

const exec = { agent: { id: 's-1' } }

test('no tool schema uses a type array (DSH rejects them)', () => {
  const { tools } = setup()
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    if (Object.hasOwn(node, 'type')) {
      assert.equal(typeof node.type, 'string', `${path}.type must be a single string, not ${JSON.stringify(node.type)}`)
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`)
  }
  for (const tool of tools) {
    walk(tool.parameters, `${tool.name}.parameters`)
    walk(tool.output.schema, `${tool.name}.output.schema`)
  }
})

test('privacy_session reports and can enable the current session', async () => {
  const { tool, state } = sessionTool()
  const before = await tool.execute({ action: 'status' }, exec)
  assert.equal(before.enabled, false)
  assert.equal(before.sessionId, 's-1')

  const after = await tool.execute({ action: 'enable' }, exec)
  assert.equal(after.enabled, true)
  assert.equal(state.explicit, true)
})

test('privacy_session refuses to disable the gate unless the deployment allows it', async () => {
  const { tool } = sessionTool()
  await assert.rejects(() => tool.execute({ action: 'disable' }, exec), /not permitted by this deployment/)

  const allowed = sessionTool({ allowAgentDisable: true })
  const status = await allowed.tool.execute({ action: 'disable' }, exec)
  assert.equal(status.enabled, false)
})

test('privacy_session needs a session context and a known action', async () => {
  const { tool } = sessionTool()
  await assert.rejects(() => tool.execute({ action: 'status' }, {}), /needs a session context/)
  await assert.rejects(() => tool.execute({ action: 'launch' }, exec), /action must be status, enable or disable/)
})
