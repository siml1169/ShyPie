import { test } from 'node:test'
import assert from 'node:assert/strict'

import { shapePostExecute, shapePreStep } from '../lib/gate.js'
import { imageBlock, makeFakeIngest, makeGateDeps } from './helpers.mjs'

const filterConfig = (overrides = {}) => ({
  ...makeGateDeps().config,
  textPolicy: 'filter',
  imageParts: 'ocr',
  fileParts: 'extract',
  ...overrides,
})

test('filter mode leaves a tool-result text local instead of masking it', () => {
  const deps = makeGateDeps({ config: filterConfig() })
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'mail max@example.test' }] }
  const out = shapePostExecute(deps, {}, { isError: false, content: decision.content, value: { mail: 'max@example.test' } }, decision)
  assert.equal(out, decision)
  assert.match(out.content[0].text, /max@example\.test/)
})

test('filter mode still blocks a BLOB tool result', () => {
  const deps = makeGateDeps({ config: filterConfig() })
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'QUJD'.repeat(2000) }] }
  const out = shapePostExecute(deps, {}, { isError: false, content: decision.content }, decision)
  assert.equal(out.kind, 'block')
})

test('filter mode stores raw OCR text for an attachment', async () => {
  const ingest = makeFakeIngest({ ocrText: 'Kunde DE89370400440532013000' })
  const deps = makeGateDeps({
    config: filterConfig(),
    readAttachment: ingest.readAttachment,
    runOcr: ingest.runOcr,
  })
  const out = await shapePreStep(deps, { agent: {} }, { kind: 'enter', messages: [{ role: 'user', content: [imageBlock()] }] })
  assert.equal(out.kind, 'enter')
  assert.match(out.messages[0].content[0].text, /DE89370400440532013000/)
  assert.ok(!out.messages[0].content[0].text.includes('{{IBAN_'))
})
