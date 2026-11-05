import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The renderer evaluates the client entry itself; this harness gives it the same
 * `window.__ModuleLoader__` wrapper the core client packages expect, plus a stub React, so the
 * registration can be checked without a browser.
 */
async function loadClient() {
  const registered = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  let exports
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        assert.equal(id, '@shypie_privacy/dsh-privacy-gate')
        exports = factory((name) => {
          if (name === 'react') return react
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }
  await import(`../lib/client.js?${Date.now()}`)
  const ctx = {
    slots: {
      inject: (slot, run) => run(),
      register: (options, component) => {
        registered.push({ slot: options.name, options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  return { exports, registered }
}

test('the client half exports apply/inject and registers the section', async () => {
  const { exports, registered } = await loadClient()
  try {
    assert.equal(typeof exports.apply, 'function')
    // Only `slots` may be required: anything else can leave the web-boot entry pending, which DSH
    // treats as a failed start.
    assert.deepEqual(exports.inject, ['slots'])
    assert.equal(exports.name, 'privacy-gate')

    const section = registered.find((entry) => entry.slot === 'settings.section')
    assert.equal(section.options.id, 'privacy-gate')
    assert.equal(section.options.order, 70)
    assert.equal(typeof section.options.label(), 'string')
    assert.equal(typeof section.component, 'function')
    // No settings namespace: the page talks to the host over its own route instead.
    assert.equal(section.options.inject, undefined)
  } finally {
    delete globalThis.window
  }
})

test('the section renders a loading state before its fetch settles', async () => {
  const { registered } = await loadClient()
  try {
    const section = registered.find((entry) => entry.slot === 'settings.section')
    const tree = section.component({})
    assert.equal(tree.type, 'p')
    assert.match(JSON.stringify(tree), /Loading the privacy gate settings/)
  } finally {
    delete globalThis.window
  }
})
