import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guardDecision,
  installGates,
  shapePostExecute,
  shapePreStep,
  shapePtcDispatchLog,
} from '../lib/gate.js'
import { FIXTURE, imageBlock, makeFakeCtx, makeFakeIngest, makeFakeRedactor, makeGateDeps } from './helpers.mjs'

const readResult = (text) => ({
  isError: false,
  value: { path: 'C:/work/x.txt', offset: 1, lines: [{ number: 1, text }], totalLines: 1 },
  content: [{ type: 'text', text: `1\t${text}` }],
})

test('installGates registers the documented waterfall listeners and one guard', () => {
  const ctx = makeFakeCtx()
  const dispose = installGates({ ctx, ...makeGateDeps() })
  assert.equal(ctx.listeners.get('tools/post-execute').length, 1)
  assert.equal(ctx.listeners.get('agent/pre-step').length, 1)
  assert.equal(ctx.listeners.get('tools/ptc-dispatch-log').length, 1)
  assert.equal(ctx.guards.length, 1)
  dispose()
  assert.equal(ctx.listeners.get('tools/post-execute').length, 0)
  assert.equal(ctx.guards.length, 0)
})

test('post-execute redacts plaintext in both content and value', () => {
  const deps = makeGateDeps()
  const exec = { name: 'read', arguments: { file_path: 'C:/work/x.txt' } }
  const result = readResult(`mail ${FIXTURE.email}`)
  const decision = shapePostExecute(deps, exec, result, { kind: 'accept' })
  assert.equal(decision.kind, 'accept')
  assert.equal(Object.hasOwn(decision, 'value'), true, 'a success is sanitized through value so meta is re-derived')
  assert.ok(!JSON.stringify(decision).includes(FIXTURE.email))
  assert.ok(JSON.stringify(decision).includes('{{EMAIL_'))
})

test('post-execute returns the untouched decision (next() semantics) when nothing changed', () => {
  const deps = makeGateDeps()
  const result = { isError: false, value: { text: 'nothing sensitive' }, content: [{ type: 'text', text: 'nothing sensitive' }] }
  const passed = { kind: 'accept' }
  assert.equal(shapePostExecute(deps, { name: 'pwsh' }, result, passed), passed)
})

test('post-execute blocks a tool result carrying a BLOB', () => {
  const deps = makeGateDeps()
  const result = { isError: false, value: { text: 'A'.repeat(3000) }, content: [{ type: 'text', text: 'A'.repeat(3000) }] }
  const decision = shapePostExecute(deps, { name: 'pwsh' }, result, { kind: 'accept' })
  assert.equal(decision.kind, 'block')
  assert.ok(!JSON.stringify(decision).includes('AAAAAAAAAAAAAAAAAAAA'), 'block feedback must not echo the payload')
})

test('post-execute blocks an image-bearing tool result instead of forwarding bytes', () => {
  const deps = makeGateDeps()
  const result = { isError: false, value: { path: 'x.png', image: {} }, content: [{ type: 'text', text: 'x.png' }, { type: 'image', attachment: { attachmentId: 'a' } }] }
  const decision = shapePostExecute(deps, { name: 'read_image' }, result, { kind: 'accept' })
  assert.equal(decision.kind, 'block')
})

test('post-execute never overrides another policy block', () => {
  const deps = makeGateDeps()
  const own = { kind: 'block', feedback: [{ type: 'text', text: 'another gate said no' }] }
  assert.equal(shapePostExecute(deps, { name: 'read' }, readResult('x'), own), own)
})

test('post-execute redacts an error result through content (value replacement is forbidden by DSH)', () => {
  const deps = makeGateDeps()
  const result = { isError: true, error: { message: 'E' }, content: [{ type: 'text', text: `Error: ${FIXTURE.iban} rejected` }] }
  const decision = shapePostExecute(deps, { name: 'pwsh' }, result, { kind: 'accept' })
  assert.equal(decision.kind, 'accept')
  assert.ok(decision.content, 'an error result is redacted by replacing content')
  assert.ok(!JSON.stringify(decision).includes(FIXTURE.iban))
})

test('post-execute fails closed when the redactor is unavailable', () => {
  const deps = makeGateDeps({ redactor: null })
  const decision = shapePostExecute(deps, { name: 'read' }, readResult('x'), { kind: 'accept' })
  assert.equal(decision.kind, 'block')
})

test('post-execute fails closed when the redactor throws', () => {
  const deps = makeGateDeps({ redactor: { redact() { throw new Error('boom') } } })
  const decision = shapePostExecute(deps, { name: 'read' }, readResult('x'), { kind: 'accept' })
  assert.equal(decision.kind, 'block')
  assert.match(decision.feedback[0].text, /redaction failed/)
})

test('pre-step redacts user text and keeps startsRequestSeries', async () => {
  const deps = makeGateDeps()
  const decision = { kind: 'enter', messages: [{ id: 'm1', content: [{ type: 'text', text: `IBAN ${FIXTURE.iban}` }] }] }
  const shaped = await shapePreStep(deps, { agent: {} }, decision)
  assert.equal(shaped.kind, 'enter')
  assert.equal(shaped.messages[0].content[0].text.includes(FIXTURE.iban), false)
  assert.match(shaped.messages[0].content[0].text, /\{\{IBAN_/)

  const withSeries = await shapePreStep(deps, {}, { ...decision, startsRequestSeries: true })
  assert.equal(withSeries.startsRequestSeries, true)
})

test('pre-step returns the untouched decision (next() semantics) when nothing changed', async () => {
  const deps = makeGateDeps()
  const decision = { kind: 'enter', messages: [{ id: 'm1', content: [{ type: 'text', text: 'hello' }] }] }
  assert.equal(await shapePreStep(deps, {}, decision), decision)
})

test('pre-step converts an attached image into masked local OCR text', async () => {
  const ingest = makeFakeIngest({ ocrText: `Rechnung für ${FIXTURE.email}` })
  const deps = { ...makeGateDeps(), readAttachment: ingest.readAttachment, runOcr: ingest.runOcr }
  const decision = { kind: 'enter', messages: [{ id: 'm1', content: [{ type: 'text', text: 'look at this' }, imageBlock()] }] }

  const shaped = await shapePreStep(deps, {}, decision)
  assert.equal(shaped.kind, 'enter')
  const content = shaped.messages[0].content
  assert.equal(content.length, 2, 'the image block is replaced in place, not dropped')
  assert.equal(content[1].type, 'text')
  assert.match(content[1].text, /privacy-gate: local OCR of an attached image\/png "scan\.png"/)
  assert.match(content[1].text, /engine fake-ocr/)
  assert.ok(!content[1].text.includes(FIXTURE.email), 'the OCR text is masked before it can reach the request')
  assert.match(content[1].text, /\{\{EMAIL_/)
  assert.deepEqual(
    deps.audit.records.filter((entry) => entry.kind === 'attachment-ocr').map((entry) => entry.count),
    [1],
  )
  assert.deepEqual(ingest.calls.map((call) => call.kind), ['read', 'ocr'])
})

test('pre-step never mutates the decision messages it was given', async () => {
  const ingest = makeFakeIngest()
  const deps = { ...makeGateDeps(), readAttachment: ingest.readAttachment, runOcr: ingest.runOcr }
  const block = imageBlock()
  const decision = { kind: 'enter', messages: [{ id: 'm1', content: [block] }] }

  const shaped = await shapePreStep(deps, {}, decision)
  assert.equal(decision.messages[0].content[0].type, 'image')
  assert.notEqual(shaped.messages[0].content[0], block)
})

test('pre-step rejects when the image cannot be read locally', async () => {
  const cases = [
    { name: 'no attachment service', deps: () => makeGateDeps() },
    { name: 'unreadable object', deps: () => { const ingest = makeFakeIngest({ readError: true }); return { ...makeGateDeps(), readAttachment: ingest.readAttachment, runOcr: ingest.runOcr } } },
    { name: 'empty object', deps: () => { const ingest = makeFakeIngest({ empty: true }); return { ...makeGateDeps(), readAttachment: ingest.readAttachment, runOcr: ingest.runOcr } } },
    { name: 'OCR failed', deps: () => { const ingest = makeFakeIngest({ ocrResult: { ok: false, blocked: true, reason: 'NO_ENGINE' } }); return { ...makeGateDeps(), readAttachment: ingest.readAttachment, runOcr: ingest.runOcr } } },
    { name: 'OCR returned nothing', deps: () => { const ingest = makeFakeIngest(); return { ...makeGateDeps(), readAttachment: ingest.readAttachment, runOcr: async () => ({ ok: true, text: '   ', engine: 'fake' }) } } },
  ]
  for (const item of cases) {
    const deps = item.deps()
    const decision = { kind: 'enter', messages: [{ id: 'm1', content: [imageBlock()] }] }
    assert.deepEqual(await shapePreStep(deps, {}, decision), { kind: 'reject' }, item.name)
    assert.deepEqual(
      deps.audit.records.filter((entry) => entry.kind === 'attachment-blocked').map((entry) => entry.count),
      [0],
      item.name,
    )
  }
})

test('pre-step keeps the old behaviour when imageParts is "block"', async () => {
  const ingest = makeFakeIngest()
  const deps = {
    ...makeGateDeps({ config: { imageParts: 'block' } }),
    readAttachment: ingest.readAttachment,
    runOcr: ingest.runOcr,
  }
  const decision = { kind: 'enter', messages: [{ id: 'm1', content: [imageBlock()] }] }
  assert.deepEqual(await shapePreStep(deps, {}, decision), { kind: 'reject' })
  assert.deepEqual(ingest.calls, [], 'nothing is read or spawned when the policy is block')
})

test('pre-step still rejects a media type the extractor cannot read', async () => {
  const ingest = makeFakeIngest()
  const deps = { ...makeGateDeps(), readAttachment: ingest.readAttachment, runOcr: ingest.runOcr }
  for (const type of ['file', 'audio', 'video']) {
    const decision = { kind: 'enter', messages: [{ id: 'm1', content: [{ type }] }] }
    assert.deepEqual(await shapePreStep(deps, {}, decision), { kind: 'reject' }, type)
  }
})

test('pre-step passes an existing reject decision through and fails closed when broken', async () => {
  const deps = makeGateDeps()
  assert.deepEqual(await shapePreStep(deps, {}, { kind: 'reject' }), { kind: 'reject' })
  const broken = makeGateDeps({ state: { broken: new Error('no core') } })
  assert.deepEqual(await shapePreStep(broken, {}, { kind: 'enter', messages: [] }), { kind: 'reject' })
})

test('ptc-dispatch-log redacts the durable log copy and withholds an unmaskable one', () => {
  const deps = makeGateDeps()
  const blocks = [{ type: 'text', text: `mail ${FIXTURE.email}` }]
  const out = shapePtcDispatchLog(deps, blocks)
  assert.ok(!JSON.stringify(out).includes(FIXTURE.email))
  assert.ok(JSON.stringify(out).includes('{{EMAIL_'))

  const withheld = shapePtcDispatchLog(deps, [{ type: 'image', attachment: {} }])
  assert.equal(withheld.length, 1)
  assert.match(withheld[0].text, /withheld/)
})

test('the guard denies read_image always', () => {
  const deps = makeGateDeps()
  assert.match(guardDecision({ name: 'read_image', arguments: { file_path: 'C:/fixtures/a.png' } }, deps.config), /read_image is denied/)
})

test('the guard denies binary/document reads outside allowPaths only', () => {
  const config = makeGateDeps().config
  assert.match(guardDecision({ name: 'read', arguments: { file_path: 'C:/Users/x/invoice.pdf' } }, config), /binary\/document file "invoice\.pdf" is denied/)
  assert.match(guardDecision({ name: 'read', arguments: { file_path: 'C:/Users/x/invoice.PDF' } }, config), /denied/)

  const allowed = makeGateDeps({ config: { allowPaths: ['C:/fixtures'] } }).config
  assert.equal(guardDecision({ name: 'read', arguments: { file_path: 'C:/fixtures/invoice.pdf' } }, allowed), undefined)

  assert.equal(guardDecision({ name: 'read', arguments: { file_path: 'C:/Users/x/notes.txt' } }, config), undefined)
  assert.equal(guardDecision({ name: 'pwsh', arguments: { command: 'Get-ChildItem' } }, config), undefined)
  assert.equal(guardDecision({ name: 'privacy_extract', arguments: { path: 'C:/x/a.pdf' } }, config), undefined)
})

test('the guard denies a malformed execution', () => {
  const config = makeGateDeps().config
  assert.match(guardDecision(null, config), /malformed tool execution denied/)
})

test('the installed listeners compose with next() and fail closed end to end', async () => {
  const ctx = makeFakeCtx()
  const deps = makeGateDeps()
  installGates({ ctx, ...deps })

  const post = ctx.listener('tools/post-execute')
  const result = readResult(`IBAN ${FIXTURE.iban}`)
  const decision = await post({ name: 'read' }, result, async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.ok(!JSON.stringify(decision).includes(FIXTURE.iban))

  const pre = ctx.listener('agent/pre-step')
  const shaped = await pre({}, async () => ({ kind: 'enter', messages: [{ id: 'm', content: [{ type: 'text', text: FIXTURE.email }] }] }))
  assert.ok(!JSON.stringify(shaped).includes(FIXTURE.email))

  // A broken gate must reject the step rather than forward the prompt.
  const brokenCtx = makeFakeCtx()
  installGates({ ctx: brokenCtx, ...makeGateDeps({ state: { broken: new Error('no core') } }) })
  const brokenPre = brokenCtx.listener('agent/pre-step')
  assert.deepEqual(await brokenPre({}, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
  const brokenPost = brokenCtx.listener('tools/post-execute')
  assert.equal((await brokenPost({ name: 'read' }, readResult('x'), async () => ({ kind: 'accept' }))).kind, 'block')
})

test('an unchanged result passes the exact next() decision through the installed listener', async () => {
  const ctx = makeFakeCtx()
  installGates({ ctx, ...makeGateDeps() })
  const post = ctx.listener('tools/post-execute')
  const passed = { kind: 'accept' }
  const result = { isError: false, value: { text: 'clean' }, content: [{ type: 'text', text: 'clean' }] }
  assert.equal(await post({ name: 'pwsh' }, result, async () => passed), passed)
})

test('redaction never mutates the frozen tool result it was given', async () => {
  const ctx = makeFakeCtx()
  installGates({ ctx, ...makeGateDeps() })
  const post = ctx.listener('tools/post-execute')
  const result = readResult(`IBAN ${FIXTURE.iban}`)
  const before = JSON.stringify(result)
  await post({ name: 'read' }, result, async () => ({ kind: 'accept' }))
  assert.equal(JSON.stringify(result), before)
})

test('the fake redactor is the same one a real pii-core would expose', () => {
  const redactor = makeFakeRedactor()
  const out = redactor.redact(`IBAN ${FIXTURE.iban}`)
  assert.equal(typeof out.text, 'string')
  assert.ok(Array.isArray(out.tokens) && Array.isArray(out.hits))
  assert.equal(redactor.restore(out.text).includes(FIXTURE.iban), true)
})
