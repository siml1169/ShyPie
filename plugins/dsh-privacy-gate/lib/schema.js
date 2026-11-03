/**
 * Minimal, dependency-free argument schema + validator for the gate's tools.
 *
 * Mirrors the host's tool-authoring contract: a tool declares an implicit
 * per-property parameter spec, which compiles to a raw object JSON Schema (the
 * registry validates `output.schema` but a raw `register()` does not validate
 * arguments — `dsh-tools` `createExecution` only snapshots `exec.arguments` —
 * so a raw definition validates its own arguments here).
 *
 * Supported property spec: { type, required?, description?, enum?, items?,
 * minLength? }. Supported types: string, integer, number, boolean, array
 * (item type string only), object.
 */

const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object'])

function fail(message) {
  throw new Error(`privacy-gate schema: ${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Compile an implicit property spec map into a raw object JSON Schema. */
export function objectSchema(spec) {
  if (!isPlainObject(spec)) fail('spec must be an object')
  const properties = {}
  const required = []
  for (const [name, rule] of Object.entries(spec)) {
    if (!isPlainObject(rule)) fail(`property "${name}" must be an object`)
    if (!TYPES.has(rule.type)) fail(`property "${name}" has unsupported type "${String(rule.type)}"`)
    const property = { type: rule.type }
    if (rule.description !== undefined) property.description = rule.description
    if (rule.enum !== undefined) {
      if (!Array.isArray(rule.enum) || rule.enum.length === 0) fail(`property "${name}" enum must be a non-empty array`)
      property.enum = [...rule.enum]
    }
    if (rule.type === 'array' && rule.items !== undefined) {
      if (!isPlainObject(rule.items) || !TYPES.has(rule.items.type)) fail(`property "${name}" items must be a type object`)
      property.items = { type: rule.items.type }
    }
    if (rule.minLength !== undefined) {
      if (!Number.isInteger(rule.minLength) || rule.minLength < 0) fail(`property "${name}" minLength must be a non-negative integer`)
      property.minLength = rule.minLength
    }
    if (rule.required === true) required.push(name)
    properties[name] = property
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * Validate one argument object against the same implicit spec.
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseArguments(spec, args) {
  if (args === undefined || args === null) args = {}
  if (!isPlainObject(args)) return { ok: false, error: 'arguments must be an object' }
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(spec, key))
  if (unknown.length > 0) {
    return { ok: false, error: `unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}` }
  }
  const value = {}
  for (const [name, rule] of Object.entries(spec)) {
    const present = Object.hasOwn(args, name) && args[name] !== undefined
    if (!present) {
      if (rule.required === true) return { ok: false, error: `missing required argument "${name}"` }
      continue
    }
    const checked = checkValue(name, rule, args[name])
    if (checked.ok === false) return checked
    value[name] = checked.value
  }
  return { ok: true, value }
}

function checkValue(name, rule, given) {
  const bad = (expected) => ({ ok: false, error: `argument "${name}" must be ${expected}` })
  switch (rule.type) {
    case 'string': {
      if (typeof given !== 'string') return bad('a string')
      if (rule.required === true && given.trim().length === 0) return bad('a non-empty string')
      if (rule.enum !== undefined && !rule.enum.includes(given)) {
        return { ok: false, error: `argument "${name}" must be one of ${rule.enum.map((v) => JSON.stringify(v)).join(', ')}` }
      }
      if (rule.minLength !== undefined && given.length < rule.minLength) return bad(`at least ${rule.minLength} characters`)
      return { ok: true, value: given }
    }
    case 'integer': {
      return Number.isInteger(given) ? { ok: true, value: given } : bad('an integer')
    }
    case 'number': {
      return typeof given === 'number' && Number.isFinite(given) ? { ok: true, value: given } : bad('a finite number')
    }
    case 'boolean': {
      return typeof given === 'boolean' ? { ok: true, value: given } : bad('a boolean')
    }
    case 'array': {
      if (!Array.isArray(given)) return bad('an array')
      if (rule.items?.type === 'string' && given.some((item) => typeof item !== 'string')) return bad('an array of strings')
      if (rule.items?.type === 'number' && given.some((item) => typeof item !== 'number')) return bad('an array of numbers')
      return { ok: true, value: [...given] }
    }
    case 'object': {
      return isPlainObject(given) ? { ok: true, value: given } : bad('an object')
    }
    default:
      return bad('a supported type')
  }
}
