import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOB_KIND,
  MEDIA_BLOCK_TYPES,
  hasBlob,
  hitSummary,
  redactBlocks,
  redactMessage,
  redactMessages,
  redactStringTree,
  redactText,
  tokenSummary,
} from '../lib/redact.js'
import { FIXTURE, makeFakeRedactor } from './helpers.mjs'

test('redactText masks a value and reports a summary without the value', () => {
  const redactor = makeFakeRedactor()
  const out = redactText(redactor, `IBAN ${FIXTURE.iban} please`)
  assert.equal(out.blocked, false)
  assert.equal(out.changed, true)
  assert.ok(!out.text.includes(FIXTURE.iban), 'plaintext must be gone')
  assert.match(out.text, /\{\{IBAN_[A-Z0-9]{8}\}\}/)
  assert.deepEqual(tokenSummary(out.tokens), [{ kind: 'IBAN', count: 1, length: FIXTURE.iban.length }])
  assert.ok(!JSON.stringify(out.tokens).includes(FIXTURE.iban), 'tokens must not carry the value')
})

test('redaction is idempotent and a placeholder-only text is unchanged', () => {
  const redactor = makeFakeRedactor()
  const once = redactText(redactor, FIXTURE.email)
  const twice = redactText(redactor, once.text)
  assert.equal(twice.text, once.text)
  assert.equal(twice.changed, false)
  assert.equal(twice.blocked, false)
})

test('a BLOB hit is a block signal, never a mask target', () => {
  const redactor = makeFakeRedactor()
  const blob = 'A'.repeat(3000)
  const out = redactText(redactor, `data ${blob}`)
  assert.equal(out.blocked, true)
  assert.equal(out.reason, 'BLOB')
  assert.equal(hasBlob(out.hits), true)
  assert.equal(BLOB_KIND, 'BLOB')
})

test('redactBlocks masks text and reasoning, passes structural blocks, blocks media', () => {
  const redactor = makeFakeRedactor()
  const text = redactBlocks(redactor, [{ type: 'text', text: FIXTURE.iban }])
  assert.equal(text.blocked, false)
  assert.ok(!text.blocks[0].text.includes(FIXTURE.iban))

  const structural = redactBlocks(redactor, [{ type: 'tool-addition', toolName: 'x' }])
  assert.equal(structural.changed, false)
  assert.deepEqual(structural.blocks, [{ type: 'tool-addition', toolName: 'x' }])

  for (const type of MEDIA_BLOCK_TYPES) {
    const out = redactBlocks(redactor, [{ type, attachment: { attachmentId: 'a' } }])
    assert.equal(out.blocked, true, `${type} must be unmaskable`)
    assert.equal(out.reason, `UNMASKABLE_${type.toUpperCase()}`)
  }
})

test('redactBlocks returns the input array identity when nothing changed', () => {
  const redactor = makeFakeRedactor()
  const blocks = [{ type: 'text', text: 'no pii here' }]
  const out = redactBlocks(redactor, blocks)
  assert.equal(out.changed, false)
  assert.equal(out.blocks, blocks)
})

test('redactStringTree masks every string in a plain value', () => {
  const redactor = makeFakeRedactor()
  const value = { path: 'C:/x/a.txt', lines: [{ number: 1, text: `mail ${FIXTURE.email}` }], total: 1 }
  const out = redactStringTree(redactor, value)
  assert.equal(out.blocked, false)
  assert.equal(out.changed, true)
  assert.ok(!JSON.stringify(out.value).includes(FIXTURE.email))
  assert.equal(out.value.total, 1)
  assert.equal(out.value.lines[0].number, 1)
})

test('redactStringTree reports a BLOB in a value as blocked', () => {
  const redactor = makeFakeRedactor()
  const out = redactStringTree(redactor, { bytes: 'A'.repeat(4096) })
  assert.equal(out.blocked, true)
  assert.equal(out.reason, 'BLOB')
})

test('redactMessage preserves identity fields and flags attachments', () => {
  const redactor = makeFakeRedactor()
  const message = { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: FIXTURE.iban }] }
  const out = redactMessage(redactor, message)
  assert.equal(out.blocked, false)
  assert.equal(out.changed, true)
  assert.equal(out.message.id, 'm1')
  assert.equal(out.message.source.kind, 'user')
  assert.ok(!out.message.content[0].text.includes(FIXTURE.iban))

  const withImage = redactMessage(redactor, { id: 'm2', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] })
  assert.equal(withImage.blocked, true)
  assert.deepEqual(withImage.attachments, ['image'])
})

test('redactMessages blocks the whole batch when one message carries an attachment', () => {
  const redactor = makeFakeRedactor()
  const out = redactMessages(redactor, [
    { id: 'm1', content: [{ type: 'text', text: 'hello' }] },
    { id: 'm2', content: [{ type: 'file', attachment: { attachmentId: 'f' } }] },
  ])
  assert.equal(out.blocked, true)
  assert.deepEqual(out.attachments, ['file'])
})

test('hitSummary aggregates by kind without values', () => {
  const summary = hitSummary([
    { kind: 'IBAN', length: 22 },
    { kind: 'IBAN', length: 22 },
    { kind: 'EMAIL', length: 27 },
  ])
  assert.deepEqual(summary, [
    { kind: 'EMAIL', count: 1, length: 27 },
    { kind: 'IBAN', count: 2, length: 44 },
  ])
})
