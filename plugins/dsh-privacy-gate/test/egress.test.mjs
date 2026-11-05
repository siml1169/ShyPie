import assert from 'node:assert/strict'
import test from 'node:test'

import { createEgressGuard, inspectEgress, EGRESS_BLOCKED_CODE } from '../lib/egress.js'

const redactor = {
  scan(text) {
    if (typeof text !== 'string') throw new Error('scan requires a string')
    const hits = []
    if (text.includes('BLOB')) hits.push({ kind: 'BLOB' })
    if (text.includes('PII')) hits.push({ kind: 'EMAIL' })
    return hits
  },
}

const config = {
  egressAllowProviders: [],
  egressAllowModels: [],
  egressMaxChars: 10_000,
  egressMaxNodes: 100,
}

function deps(overrides = {}) {
  return {
    config: { ...config, ...(overrides.config ?? {}) },
    redactor: overrides.redactor === undefined ? redactor : overrides.redactor,
    state: { broken: null },
    audit: { records: [], record(entry) { this.records.push(entry) } },
  }
}

function request(messages, extra = {}) {
  return { provider: 'magpie', model: 'deepseek/deepseek-flash', messages, ...extra }
}

const text = (value) => ({ role: 'user', content: [{ type: 'text', text: value }] })

test('a text-only request passes', () => {
  assert.deepEqual(inspectEgress(request([text('hello')]), deps()), { ok: true })
})

test('image and file blocks are rejected', () => {
  for (const type of ['image', 'file', 'audio', 'video']) {
    const verdict = inspectEgress(request([{ role: 'user', content: [{ type }] }]), deps())
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reason, `MEDIA_${type.toUpperCase()}`)
  }
})

test('PII in message text is rejected', () => {
  const verdict = inspectEgress(request([text('reach me at PII')]), deps())
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'PII')
})

test('BLOB in tool-call arguments is rejected', () => {
  const verdict = inspectEgress(request([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: '{"data":"BLOB"}' }],
  }]), deps())
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'BLOB')
})

test('tool-result content is scanned, including its media blocks', () => {
  const pii = inspectEgress(request([{
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'PII' }], isError: false }],
  }]), deps())
  assert.equal(pii.ok, false)
  assert.equal(pii.reason, 'PII')

  const media = inspectEgress(request([{
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image' }], isError: false }],
  }]), deps())
  assert.equal(media.ok, false)
  assert.equal(media.reason, 'MEDIA_IMAGE')
})

test('unknown block types and malformed bodies fail closed', () => {
  assert.equal(inspectEgress(request([{ role: 'user', content: [{ type: 'mystery' }] }]), deps()).reason, 'UNKNOWN_BLOCK')
  assert.equal(inspectEgress(request([{ role: 'user', content: 'PII' }]), deps()).reason, 'PII')
  assert.equal(inspectEgress(request([{ role: 'user', content: [{ type: 'text' }] }]), deps()).reason, 'MALFORMED_TEXT')
  assert.equal(inspectEgress({ provider: 'magpie', model: 'm' }, deps()).reason, 'MALFORMED_MESSAGES')
})

test('provider and model allowlists are enforced', () => {
  const provider = inspectEgress(request([text('hello')]), deps({ config: { egressAllowProviders: ['other'] } }))
  assert.equal(provider.reason, 'PROVIDER')
  const model = inspectEgress(request([text('hello')]), deps({ config: { egressAllowModels: ['deepseek/*'] } }))
  assert.equal(model.ok, true)
  const wrong = inspectEgress(request([text('hello')]), deps({ config: { egressAllowModels: ['other/*'] } }))
  assert.equal(wrong.reason, 'MODEL')
})

test('character and node budgets reject instead of degrading', () => {
  assert.equal(inspectEgress(request([text('x'.repeat(20))]), deps({ config: { egressMaxChars: 10 } })).reason, 'LIMIT_CHARS')
  const blocks = Array.from({ length: 120 }, () => ({ type: 'text', text: 'x' }))
  assert.equal(inspectEgress(request([{ role: 'user', content: blocks }]), deps({ config: { egressMaxNodes: 20 } })).reason, 'LIMIT_NODES')
})

test('the llm/stream listener returns a terminal error stream before next', async () => {
  let nextCalls = 0
  const audit = { records: [], record(entry) { this.records.push(entry) } }
  const guard = createEgressGuard({ ...deps(), audit })
  const stream = guard(request([text('BLOB')]), () => { nextCalls += 1 })
  assert.equal(nextCalls, 0)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.message, 'privacy-gate: egress blocked (BLOB); an earlier message in this session still holds content the gate cannot mask — start a new session (the log is append-only)')
  assert.equal(chunks[0].reason.failure.code, EGRESS_BLOCKED_CODE)
  assert.equal(audit.records.length, 1)
  assert.equal(audit.records[0].kind, 'egress-blocked')
  assert.equal(JSON.stringify(audit.records[0]).includes('BLOB'), false)
})

test('a media rejection points at the local extraction path', async () => {
  const guard = createEgressGuard(deps())
  const stream = guard(request([{ role: 'user', content: [{ type: 'image' }] }]), () => {})
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  assert.equal(
    chunks[0].reason.failure.message,
    'privacy-gate: egress blocked (MEDIA_IMAGE); an attachment cannot be masked locally — extract it with privacy_ocr and send the text',
  )
})

test('the llm/stream listener calls next for an allowed request', () => {
  let nextCalls = 0
  const guard = createEgressGuard(deps())
  const sentinel = { stream: true }
  const out = guard(request([text('hello')]), () => { nextCalls += 1; return sentinel })
  assert.equal(nextCalls, 1)
  assert.equal(out, sentinel)
})

test('an unavailable redactor blocks instead of passing', () => {
  assert.equal(inspectEgress(request([text('hello')]), deps({ redactor: null })).reason, 'REDACTOR_UNAVAILABLE')
  assert.equal(inspectEgress(request([text('hello')]), deps({ config: {}, redactor: null })).reason, 'REDACTOR_UNAVAILABLE')
})

test('reused request messages are inspected only once', () => {
  let scans = 0
  const counting = { scan() { scans += 1; return [] } }
  const guard = createEgressGuard({ ...deps(), redactor: counting })
  const reused = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const req = request([reused])
  guard(req, () => {})
  guard(req, () => {})
  assert.equal(scans, 1)
  guard(request([reused, { role: 'user', content: [{ type: 'text', text: 'new' }] }]), () => {})
  assert.equal(scans, 2)
})

test('the terminal error stream carries the stable code', async () => {
  const guard = createEgressGuard(deps())
  const chunks = []
  for await (const chunk of guard(request([text('PII')]), () => {})) chunks.push(chunk)
  assert.equal(chunks[0].reason.failure.code, EGRESS_BLOCKED_CODE)
})
