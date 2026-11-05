/**
 * Shared test fixtures: a deterministic fake redactor with the docs/interface-contract.md
 * `createRedactor` shape, plus a fake plugin ctx that exposes only the
 * registrations the gate is documented to use.
 *
 * No network, no real documents, no PII: every value below is synthetic.
 */

/** Synthetic values used across the tests (never real data). */
export const FIXTURE = Object.freeze({
  iban: 'DE89370400440532013000',
  email: 'max.mustermann@example.test',
})

const TOKEN_PREFIX = 'ABCDEFGH'

/**
 * Build a redactor stand-in whose tokens match `{{KIND_xxxxxxxx}}` and never
 * carry the value. `blobRuns` masks like the real core: a BLOB hit is reported
 * and left unmasked, because it is a block signal, not a mask target.
 */
export function makeFakeRedactor() {
  const store = new Map()
  const counters = new Map()
  const stats = { charsScanned: 0, byKind: {} }

  const tokenFor = (kind, value) => {
    const existing = store.get(value)
    if (existing !== undefined) return existing
    const index = counters.get(kind) ?? 0
    counters.set(kind, index + 1)
    const token = `{{${kind}_${TOKEN_PREFIX[index % TOKEN_PREFIX.length]}${String(index).padStart(7, '0')}}}`
    store.set(value, token)
    store.set(`token:${token}`, value)
    return token
  }

  const detectors = [
    { kind: 'IBAN', pattern: /DE\d{20}/g },
    { kind: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
    { kind: 'BLOB', pattern: /(?:[A-Za-z0-9+/]{2048,}={0,2})|%PDF-\d\.\d|PK\u0003\u0004/g },
  ]

  return {
    store,
    scan(text) {
      const hits = []
      for (const detector of detectors) {
        detector.pattern.lastIndex = 0
        for (const match of text.matchAll(detector.pattern)) {
          hits.push({ kind: detector.kind, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, length: match[0].length, source: 'fake', valid: true })
        }
      }
      return hits
    },
    redact(text) {
      stats.charsScanned += text.length
      const hits = this.scan(text)
      let output = text
      const tokens = []
      const seen = new Set()
      for (const hit of hits) {
        if (hit.kind === 'BLOB') continue
        const value = text.slice(hit.start, hit.end)
        const token = tokenFor(hit.kind, value)
        if (!seen.has(value)) {
          seen.add(value)
          tokens.push({ token, kind: hit.kind, length: value.length, count: 1 })
          stats.byKind[hit.kind] = (stats.byKind[hit.kind] ?? 0) + 1
        }
        // Positional replacement keeps indices valid for the next detector.
        if (output.includes(value)) output = output.replace(value, token)
      }
      return { text: output, tokens, hits, changed: output !== text }
    },
    restore(text) {
      return text.replace(/\{\{[A-Z]+_[A-Z0-9]{8}\}\}/g, (token) => {
        const value = store.get(`token:${token}`)
        return value === undefined ? token : value
      })
    },
    resolve(text) {
      return this.restore(text)
    },
    hasPlaceholders(text) {
      return /\{\{[A-Z]+_[A-Z0-9]{8}\}\}/.test(text)
    },
    stats() {
      return stats
    },
  }
}

/** Minimal `pii-core` module stand-in for `privacy_rehydrate`. */
export function makeFakePii(redactor) {
  return {
    VERSION: 'fake',
    findPlaceholders(text) {
      return [...text.matchAll(/\{\{([A-Z]+)_[A-Z0-9]{8}\}\}/g)].map((match) => ({ token: match[0], kind: match[1] }))
    },
    isPlaceholderShaped(text) {
      return /^\{\{[A-Z]+_[A-Z0-9]{8}\}\}$/.test(text)
    },
    createRedactor() {
      return redactor
    },
  }
}

/**
 * Fake plugin context: records event listeners, guards, and tool definitions,
 * and hands back the disposers the gate must return.
 */
export function makeFakeCtx() {
  const listeners = new Map()
  const guards = []
  const registered = []
  let disposed = 0
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    on(event, callback) {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return () => {
        disposed += 1
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
      }
    },
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    listeners,
    guards,
    registered,
    get disposed() {
      return disposed
    },
    /** First registered listener for an event. */
    listener(event) {
      const list = listeners.get(event) ?? []
      if (list.length === 0) throw new Error(`no listener registered for ${event}`)
      return list[0]
    },
  }
  return ctx
}

/** Build one `{ config, redactor, state, audit }` dependency bundle. */
export function makeGateDeps(overrides = {}) {
  const records = []
  return {
    config: {
      // Documents are readable only from allowPaths (Gate 2's policy). Tests use these roots.
      allowPaths: ['C:/workflow', 'C:/x'],
      detectors: [],
      personWords: [],
      extractCli: 'C:/synthetic/cli.js',
      audit: { enabled: false, path: '' },
      placeholderKey: { file: 'C:/synthetic/key' },
      blockNonTextResults: true,
      artifactDir: 'C:/synthetic/artifacts',
      toolTimeoutMs: 1000,
      maxExtractChars: 1000,
      imageParts: 'ocr',
      ocrLang: '',
      ...overrides.config,
    },
    redactor: Object.hasOwn(overrides, 'redactor') ? overrides.redactor : makeFakeRedactor(),
    state: overrides.state ?? { broken: null },
    audit: {
      enabled: true,
      record(entry) {
        records.push(entry)
        return true
      },
      records,
    },
    hashPath: (path) => `hash:${String(path).length}`,
    ...(Object.hasOwn(overrides, 'readAttachment') ? { readAttachment: overrides.readAttachment } : {}),
    ...(Object.hasOwn(overrides, 'runOcr') ? { runOcr: overrides.runOcr } : {}),
  }
}

/**
 * Attachment + extractor stand-ins for the attachment-ingestion tests: a fake
 * attachment service that returns known bytes, and a fake OCR run that returns
 * fixed text (or a failure) without spawning anything.
 */
export function makeFakeIngest(options = {}) {
  const bytes = options.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  const calls = []
  return {
    bytes,
    calls,
    readAttachment: async (attachment) => {
      calls.push({ kind: 'read', id: attachment?.attachmentId })
      if (options.readError === true) throw new Error('attachment verification failed')
      if (options.empty === true) return { ref: attachment, data: new Uint8Array(0) }
      return { ref: attachment, data: bytes }
    },
    runOcr: async (invocation) => {
      calls.push({ kind: 'ocr', mode: invocation.mode })
      if (options.ocrResult !== undefined) return options.ocrResult
      return { ok: true, mode: 'ocr', engine: 'fake-ocr', text: options.ocrText ?? 'Rechnung 42', warnings: [] }
    },
  }
}

/** One `image` content block with a synthetic attachment reference. */
export function imageBlock(overrides = {}) {
  return {
    type: 'image',
    attachment: {
      attachmentId: 'att_fake0000000001',
      mediaType: 'image/png',
      bytes: 11,
      width: 10,
      height: 10,
      name: 'scan.png',
      ...overrides,
    },
  }
}


/** One `file` content block with a synthetic PDF attachment reference. */
export function fileBlock(overrides = {}) {
  return {
    type: 'file',
    attachment: {
      attachmentId: 'att_pdffake0000001',
      mediaType: 'application/pdf',
      bytes: 42,
      name: 'scan.pdf',
      ...overrides,
    },
  }
}
