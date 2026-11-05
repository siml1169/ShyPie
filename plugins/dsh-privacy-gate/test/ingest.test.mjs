import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collectImageBlocks, convertPromptAttachments, convertPromptImages, ocrHeader } from '../lib/ingest.js'
import { FIXTURE, fileBlock, imageBlock, makeFakeIngest, makeGateDeps } from './helpers.mjs'

const deps = (overrides = {}) => {
  const ingest = makeFakeIngest(overrides.ingest)
  return {
    ingest,
    value: {
      ...makeGateDeps(overrides.deps),
      readAttachment: overrides.readAttachment ?? ingest.readAttachment,
      runOcr: overrides.runOcr ?? ingest.runOcr,
    },
  }
}

test('collectImageBlocks finds nested image blocks with their coordinates', () => {
  const messages = [
    { id: 'm1', content: [{ type: 'text', text: 'a' }, imageBlock()] },
    { id: 'm2', content: [{ type: 'text', text: 'b' }] },
    { id: 'm3', content: [imageBlock({ attachmentId: 'att_second' })] },
  ]
  const found = collectImageBlocks(messages)
  assert.deepEqual(found.map((item) => [item.messageIndex, item.blockIndex]), [[0, 1], [2, 0]])
  assert.equal(found[1].attachment.attachmentId, 'att_second')
})

test('collectImageBlocks tolerates malformed messages', () => {
  assert.deepEqual(collectImageBlocks(undefined), [])
  assert.deepEqual(collectImageBlocks([null, {}, { content: 'x' }, { content: [{ type: 'image' }] }]).length, 1)
})

test('a text-only message list is returned untouched (identity preserved)', async () => {
  const { value } = deps()
  const messages = [{ id: 'm1', content: [{ type: 'text', text: 'hello' }] }]
  const out = await convertPromptImages(value, messages)
  assert.equal(out.ok, true)
  assert.equal(out.converted, 0)
  assert.equal(out.messages, messages)
})

test('convertPromptImages replaces the block and reports the masked char count', async () => {
  const { value } = deps({ ingest: { ocrText: `Kunde ${FIXTURE.iban}` } })
  const out = await convertPromptImages(value, [{ id: 'm1', content: [imageBlock()] }])
  assert.equal(out.ok, true)
  assert.equal(out.converted, 1)
  assert.equal(out.messages[0].content[0].type, 'text')
  assert.ok(!out.messages[0].content[0].text.includes(FIXTURE.iban))
  assert.match(out.messages[0].content[0].text, /\{\{IBAN_/)
  assert.ok(out.chars > 0)
})

test('the OCR header names the attachment metadata but never a path', () => {
  const header = ocrHeader({ mediaType: 'image/jpeg', bytes: 2048, name: 'invoice.jpg' }, 'winrt-ocr')
  assert.match(header, /image\/jpeg/)
  assert.match(header, /2048 bytes/)
  assert.match(header, /"invoice\.jpg"/)
  assert.match(header, /winrt-ocr/)
  assert.equal(ocrHeader({}, 'local').includes('undefined'), false)
})

test('an attachment reference without an id is a rejection', async () => {
  const { value, ingest } = deps()
  const out = await convertPromptImages(value, [{ id: 'm1', content: [{ type: 'image', attachment: { mediaType: 'image/png' } }] }])
  assert.deepEqual(out, { ok: false, reason: 'ATTACHMENT_UNREADABLE' })
  assert.deepEqual(ingest.calls, [])
})

test('the extractor is spawned in ocr mode with the configured language and budget', async () => {
  const seen = []
  const { value } = deps({
    deps: { config: { imageParts: 'ocr', ocrLang: 'deu', maxExtractChars: 500, toolTimeoutMs: 9000 } },
    runOcr: async (invocation) => {
      seen.push(invocation)
      return { ok: true, engine: 'fake', text: 'text' }
    },
  })
  await convertPromptImages(value, [{ id: 'm1', content: [imageBlock()] }])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].mode, 'ocr')
  assert.equal(seen[0].lang, 'deu')
  assert.equal(seen[0].maxChars, 500)
  assert.equal(seen[0].timeoutMs, 9000)
  assert.match(seen[0].filePath, /attachment\.png$/)
})

test('a missing language option is not passed through', async () => {
  const seen = []
  const { value } = deps({
    runOcr: async (invocation) => {
      seen.push(invocation)
      return { ok: true, engine: 'fake', text: 'text' }
    },
  })
  await convertPromptImages(value, [{ id: 'm1', content: [imageBlock()] }])
  assert.equal(Object.hasOwn(seen[0], 'lang'), false)
})

test('OCR output over the budget is cut and marked', async () => {
  const long = 'x'.repeat(2000)
  const { value } = deps({
    deps: { config: { imageParts: 'ocr', maxExtractChars: 100 } },
    runOcr: async () => ({ ok: true, engine: 'fake', text: long }),
  })
  const out = await convertPromptImages(value, [{ id: 'm1', content: [imageBlock()] }])
  assert.equal(out.ok, true)
  const text = out.messages[0].content[0].text
  assert.match(text, /truncated at 100 characters/)
  assert.ok(text.length < 400)
})

test('a BLOB-shaped OCR result is a rejection, not a masked prompt', async () => {
  const { value } = deps({
    deps: { config: { imageParts: 'ocr', maxExtractChars: 100_000 } },
    ingest: { ocrText: `${'A'.repeat(4096)}` },
  })
  const out = await convertPromptImages(value, [{ id: 'm1', content: [imageBlock()] }])
  assert.deepEqual(out, { ok: false, reason: 'BLOB' })
})

test('a throwing extractor or a missing runner is a rejection', async () => {
  const throwing = deps({ runOcr: async () => { throw new Error('spawn failed') } })
  assert.deepEqual(await convertPromptImages(throwing.value, [{ id: 'm1', content: [imageBlock()] }]), {
    ok: false,
    reason: 'spawn failed',
  })

  const missing = { ...makeGateDeps(), readAttachment: async () => ({ data: new Uint8Array([1]) }) }
  assert.deepEqual(await convertPromptImages(missing, [{ id: 'm1', content: [imageBlock()] }]), {
    ok: false,
    reason: 'OCR_UNAVAILABLE',
  })
})

test('policy "block" never reads the attachment', async () => {
  const { value, ingest } = deps({ deps: { config: { imageParts: 'block' } } })
  assert.deepEqual(await convertPromptImages(value, [{ id: 'm1', content: [imageBlock()] }]), {
    ok: false,
    reason: 'IMAGE_PARTS_BLOCKED',
  })
  assert.deepEqual(ingest.calls, [])
})

test('two images in one step are both converted and counted', async () => {
  const { value } = deps()
  const out = await convertPromptImages(value, [
    { id: 'm1', content: [imageBlock(), imageBlock({ attachmentId: 'att_second' })] },
  ])
  assert.equal(out.converted, 2)
  assert.equal(out.messages[0].content.every((block) => block.type === 'text'), true)
})


test('PDF attachments are extracted and kept raw in filter mode', async () => {
  const rawText = `Kunde ${FIXTURE.iban}\nMail ${FIXTURE.email}`
  const out = await convertPromptAttachments({
    config: { textPolicy: 'filter', imageParts: 'ocr', fileParts: 'extract', maxExtractChars: 1000, ocrLang: '', toolTimeoutMs: 1000 },
    redactor: makeGateDeps().redactor,
    state: { broken: null },
    readFile: async () => ({ filePath: 'C:/synthetic/scan.pdf' }),
    runExtract: async () => ({ ok: true, engine: 'fake-pdf', text: rawText }),
  }, [{ id: 'm1', content: [fileBlock()] }])
  assert.equal(out.ok, true)
  assert.equal(out.converted, 1)
  assert.equal(out.messages[0].content[0].type, 'text')
  assert.match(out.messages[0].content[0].text, /local extraction of an attached application\/pdf/)
  assert.ok(out.messages[0].content[0].text.includes(FIXTURE.iban), 'filter mode keeps raw local text')
  assert.ok(!out.messages[0].content[0].text.includes('{{IBAN_'), 'filter mode does not mask locally')
})

test('PDF attachments are masked in mask mode and blocked by fileParts', async () => {
  const rawText = `Kunde ${FIXTURE.iban}`
  const deps = {
    config: { textPolicy: 'mask', imageParts: 'ocr', fileParts: 'extract', maxExtractChars: 1000, ocrLang: '', toolTimeoutMs: 1000 },
    redactor: makeGateDeps().redactor,
    state: { broken: null },
    readFile: async () => ({ filePath: 'C:/synthetic/scan.pdf' }),
    runExtract: async () => ({ ok: true, engine: 'fake-pdf', text: rawText }),
  }
  const out = await convertPromptAttachments(deps, [{ id: 'm1', content: [fileBlock()] }])
  assert.equal(out.ok, true)
  assert.match(out.messages[0].content[0].text, /\{\{IBAN_/)
  assert.ok(!out.messages[0].content[0].text.includes(FIXTURE.iban))
  const blocked = await convertPromptAttachments({ ...deps, config: { ...deps.config, fileParts: 'block' } }, [{ id: 'm1', content: [fileBlock()] }])
  assert.deepEqual(blocked, { ok: false, reason: 'FILE_PARTS_BLOCKED' })
})
