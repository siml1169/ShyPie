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
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
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
    settingsScope: {
      bind: (spec) => {
        registered.push({ bound: spec })
        return {
          getSnapshot: () => ({ status: 'ready', value: {}, revision: 1, writable: true }),
          subscribe: () => () => {},
          load: async () => {},
          set: async () => {},
        }
      },
    },
    slots: {
      inject: (slot, run) => run(),
      register: (options, component) => {
        registered.push({ slot: options.name, options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  return { exports, registered, react }
}

test('the client half exports apply/inject and binds the privacy-gate namespace', async () => {
  const { exports, registered } = await loadClient()
  try {
    assert.equal(typeof exports.apply, 'function')
    assert.ok(Array.isArray(exports.inject))
    assert.ok(exports.inject.includes('settingsScope'))
    assert.equal(exports.name, 'privacy-gate')

    const bound = registered.find((entry) => entry.bound !== undefined)
    assert.deepEqual(bound.bound, { namespace: 'privacy-gate' })

    const section = registered.find((entry) => entry.slot === 'settings.section')
    assert.equal(section.options.id, 'privacy-gate')
    assert.equal(typeof section.options.label(), 'string')
    assert.equal(typeof section.component, 'function')
  } finally {
    delete globalThis.window
  }
})

test('the section component renders without a live host and reports the missing exposure', async () => {
  const { exports, registered, react } = await loadClient()
  try {
    const section = registered.find((entry) => entry.slot === 'settings.section')
    const injected = section.options.inject()
    // Simulate a host that did not expose the namespace: the component must render a message,
    // not throw.
    injected.scope.getSnapshot = () => ({ status: 'error', value: undefined, revision: undefined })
    const tree = section.component({ ...injected })
    assert.equal(tree.type, 'div')
    const text = JSON.stringify(tree)
    assert.match(text, /did not expose/)
    assert.equal(typeof react.createElement, 'function')
    assert.equal(typeof exports.apply, 'function')
  } finally {
    delete globalThis.window
  }
})
