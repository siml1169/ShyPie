import { test } from 'node:test'
import assert from 'node:assert/strict'
import { objectSchema, parseArguments } from '../lib/schema.js'

const SPEC = Object.freeze({
  path: { type: 'string', required: true, description: 'file path' },
  mode: { type: 'string', enum: ['pdf', 'doc', 'auto'] },
  max_chars: { type: 'integer' },
})

test('objectSchema compiles an implicit spec to a closed raw JSON Schema', () => {
  const schema = objectSchema(SPEC)
  assert.deepEqual(schema, {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'file path' },
      mode: { type: 'string', enum: ['pdf', 'doc', 'auto'] },
      max_chars: { type: 'integer' },
    },
    required: ['path'],
  })
})

test('objectSchema rejects an unsupported declaration', () => {
  assert.throws(() => objectSchema({ x: { type: 'date' } }), /unsupported type/)
  assert.throws(() => objectSchema({ x: { type: 'string', enum: [] } }), /enum must be a non-empty array/)
})

test('parseArguments accepts valid input and drops absent optionals', () => {
  assert.deepEqual(parseArguments(SPEC, { path: 'C:/x/a.pdf' }), { ok: true, value: { path: 'C:/x/a.pdf' } })
  assert.deepEqual(parseArguments(SPEC, { path: 'C:/x/a.pdf', mode: 'pdf', max_chars: 10 }), {
    ok: true,
    value: { path: 'C:/x/a.pdf', mode: 'pdf', max_chars: 10 },
  })
})

test('parseArguments is a closed object', () => {
  const unknown = parseArguments(SPEC, { path: 'a', extra: true })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /unknown argument "extra"/)
})

test('parseArguments enforces required, types, and enums without coercing', () => {
  assert.deepEqual(parseArguments(SPEC, {}), { ok: false, error: 'missing required argument "path"' })
  assert.match(parseArguments(SPEC, { path: '  ' }).error, /non-empty string/)
  assert.match(parseArguments(SPEC, { path: 7 }).error, /must be a string/)
  assert.match(parseArguments(SPEC, { path: 'a', mode: 'magic' }).error, /must be one of "pdf", "doc", "auto"/)
  assert.match(parseArguments(SPEC, { path: 'a', max_chars: '10' }).error, /must be an integer/)
  assert.match(parseArguments(SPEC, { path: 'a', max_chars: 1.5 }).error, /must be an integer/)
})

test('parseArguments treats undefined as "argument absent" but null as invalid', () => {
  assert.equal(parseArguments(SPEC, { path: 'a', mode: undefined }).ok, true)
  assert.equal(parseArguments(SPEC, { path: null }).ok, false)
})

test('parseArguments rejects a non-object payload', () => {
  assert.match(parseArguments(SPEC, 'x').error, /must be an object/)
  assert.match(parseArguments(SPEC, ['a']).error, /must be an object/)
})
