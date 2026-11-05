/**
 * Browser half of the DSH privacy gate.
 *
 * The renderer evaluates this file itself, so it registers through the same
 * `window.__ModuleLoader__.load({ id, factory })` wrapper the core client packages use. It
 * registers one `settings.section` and binds it to the `privacy-gate` settings namespace the
 * host plugin registers.
 *
 * The host exposes only the namespaces listed in `WEB_SETTINGS_NAMESPACES`
 * (`@deepseek-ai/dsh-host-apiproxy`); when `privacy-gate` is missing there, reads answer
 * `settings-not-exposed` and the section renders that state instead of failing.
 */

window.__ModuleLoader__.load({
  id: '@shypie_privacy/dsh-privacy-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')

const h = react.createElement

/**
 * The plugin itself depends only on `slots`, the one service every client plugin has at boot.
 * `settingsScope` is resolved through a child injection instead: waiting on it in the plugin's own
 * `inject` leaves the web-boot entry pending, and DSH treats a pending entry as a failed start.
 */
const inject = ['slots']

/** Namespace shared with the host half. */
const NAMESPACE = 'privacy-gate'

const SCOPE_VALUES = ['session', 'system']
const OCR_VALUES = ['local', 'vision', 'auto']

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '720px' },
  row: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', opacity: 0.75, letterSpacing: '0.02em' },
  hint: { fontSize: '12px', opacity: 0.6, margin: 0 },
  input: {
    padding: '6px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  },
  textarea: {
    padding: '6px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    minHeight: '72px',
    resize: 'vertical',
  },
  actions: { display: 'flex', gap: '8px', alignItems: 'center' },
  button: {
    padding: '6px 14px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
  },
  error: { color: '#d9534f', fontSize: '13px', margin: 0 },
  note: { fontSize: '13px', opacity: 0.75, margin: 0 },
}

/** One labelled control. */
function Field(props) {
  return h(
    'div',
    { style: S.row },
    h('label', { style: S.label, htmlFor: props.id }, props.label),
    props.children,
    props.hint === undefined ? null : h('p', { style: S.hint }, props.hint),
  )
}

/**
 * Draft state seeded from the resolved value; `null` means "not touched, inherit the deployment
 * value", which is what a save of an untouched field must keep.
 */
function toDraft(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  return {
    scope: String(source.scope ?? 'session'),
    allowPaths: Array.isArray(source.allowPaths) ? source.allowPaths.join('\n') : '',
    extractCli: String(source.extractCli ?? ''),
    ocrEngine: String(source.ocrEngine ?? 'local'),
    visionProvider: String(source.visionProvider ?? ''),
    visionModel: String(source.visionModel ?? ''),
    allowAgentDisable: source.allowAgentDisable === true,
  }
}

/** Longest first, so a save reports the fields the user actually changed. */
function diff(draft, value) {
  const initial = toDraft(value)
  const patch = {}
  if (draft.scope !== initial.scope) patch.scope = draft.scope
  if (draft.extractCli !== initial.extractCli) patch.extractCli = draft.extractCli
  if (draft.ocrEngine !== initial.ocrEngine) patch.ocrEngine = draft.ocrEngine
  if (draft.visionProvider !== initial.visionProvider) patch.visionProvider = draft.visionProvider
  if (draft.visionModel !== initial.visionModel) patch.visionModel = draft.visionModel
  if (draft.allowAgentDisable !== initial.allowAgentDisable) patch.allowAgentDisable = draft.allowAgentDisable
  if (draft.allowPaths !== initial.allowPaths) {
    patch.allowPaths = draft.allowPaths
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }
  return patch
}

/** The Settings section: resolve the scope on render, then hand off to the stateful body. */
function PrivacyGateSection(props) {
  const scope = typeof props.resolveScope === 'function' ? props.resolveScope() : null
  if (scope === null) {
    return h(
      'div',
      { style: S.root },
      h('p', { style: S.error }, 'The privacy-gate settings service is not available in this window.'),
      h('p', { style: S.note }, 'Set the values in the profile patch and use the privacy_session tool until it is.'),
    )
  }
  return h(PrivacyGateBody, { scope })
}

/** The stateful body; rendered only once a controller exists. */
function PrivacyGateBody(props) {
  const scope = props.scope
  const snapshot = react.useSyncExternalStore(scope.subscribe, scope.getSnapshot)
  const [draft, setDraft] = react.useState(() => toDraft(snapshot.value))
  const [busy, setBusy] = react.useState(false)
  const [error, setError] = react.useState('')
  const [saved, setSaved] = react.useState('')

  react.useEffect(() => {
    scope.load()
  }, [scope])

  react.useEffect(() => {
    if (snapshot.status === 'ready') setDraft(toDraft(snapshot.value))
  }, [snapshot.revision, snapshot.status])

  const update = (field) => (event) => {
    const value = event && event.target ? event.target.value : event
    setDraft((current) => ({ ...current, [field]: value }))
    setSaved('')
  }

  const onToggle = (event) => {
    setDraft((current) => ({ ...current, allowAgentDisable: event.target.checked }))
    setSaved('')
  }

  const onSave = async () => {
    setBusy(true)
    setError('')
    setSaved('')
    try {
      const patch = diff(draft, snapshot.value)
      const fields = Object.keys(patch)
      if (fields.length === 0) {
        setSaved('Nothing to save.')
      } else {
        for (const field of fields) await scope.set(field, patch[field])
        setSaved(`Saved ${fields.length} field${fields.length === 1 ? '' : 's'}.`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (snapshot.status === 'loading') return h('p', { style: S.note }, 'Loading the privacy gate settings…')
  if (snapshot.status !== 'ready') {
    return h(
      'div',
      { style: S.root },
      h('p', { style: S.error }, `The host did not expose the ${NAMESPACE} settings namespace (${snapshot.status}).`),
      h(
        'p',
        { style: S.note },
        'In DSH 0.2.1-rc.5 the namespace must be listed in WEB_SETTINGS_NAMESPACES of @deepseek-ai/dsh-host-apiproxy. Until then, set the values in the profile patch and use the privacy_session tool.',
      ),
    )
  }

  const value = snapshot.value
  const writable = snapshot.writable !== false

  return h(
    'div',
    { style: S.root },
    h('p', { style: S.note }, 'These values layer over the profile patch. A field you save here stays yours across restarts.'),
    h(
      Field,
      { id: 'privacy-scope', label: 'Scope', hint: 'session protects sessions created after the gate was first activated; system gates every session, including history written before it existed.' },
      h(
        'select',
        { id: 'privacy-scope', style: S.input, value: draft.scope, onChange: update('scope'), disabled: !writable },
        ...SCOPE_VALUES.map((option) => h('option', { key: option, value: option }, option)),
      ),
    ),
    h(
      Field,
      { id: 'privacy-paths', label: 'Allowed document paths', hint: 'One absolute path prefix per line. Empty denies every document (fail closed).' },
      h('textarea', { id: 'privacy-paths', style: S.textarea, value: draft.allowPaths, onChange: update('allowPaths'), disabled: !writable, spellCheck: false }),
    ),
    h(
      Field,
      { id: 'privacy-extract', label: 'Local extractor CLI', hint: 'cli.js of @shypie_privacy/local-extract. Empty resolves the sibling checkout, then the installed package.' },
      h('input', { id: 'privacy-extract', style: S.input, value: draft.extractCli, onChange: update('extractCli'), disabled: !writable, spellCheck: false }),
    ),
    h(
      Field,
      { id: 'privacy-ocr', label: 'OCR engine', hint: 'local never leaves the machine; vision and auto are preferences only — no image is sent anywhere today.' },
      h(
        'select',
        { id: 'privacy-ocr', style: S.input, value: draft.ocrEngine, onChange: update('ocrEngine'), disabled: !writable },
        ...OCR_VALUES.map((option) => h('option', { key: option, value: option }, option)),
      ),
    ),
    h(
      Field,
      { id: 'privacy-vision-provider', label: 'Vision provider (unused today)' },
      h('input', { id: 'privacy-vision-provider', style: S.input, value: draft.visionProvider, onChange: update('visionProvider'), disabled: !writable, spellCheck: false }),
    ),
    h(
      Field,
      { id: 'privacy-vision-model', label: 'Vision model (unused today)' },
      h('input', { id: 'privacy-vision-model', style: S.input, value: draft.visionModel, onChange: update('visionModel'), disabled: !writable, spellCheck: false }),
    ),
    h(
      'label',
      { style: S.row },
      h(
        'span',
        { style: S.label },
        h('input', { type: 'checkbox', checked: draft.allowAgentDisable, onChange: onToggle, disabled: !writable }),
        ' Allow the agent to turn the gate off for a session',
      ),
      h('p', { style: S.hint }, 'Off by default: a prompt-injected instruction must not be able to disable the gate. privacy_session can always turn it on.'),
    ),
    h(
      'div',
      { style: S.actions },
      h('button', { type: 'button', style: S.button, onClick: onSave, disabled: !writable || busy }, busy ? 'Saving…' : 'Save'),
      h('button', { type: 'button', style: S.button, onClick: () => { setDraft(toDraft(value)); setSaved(''); setError('') }, disabled: !writable || busy }, 'Discard'),
      saved === '' ? null : h('span', { style: S.note }, saved),
      error === '' ? null : h('span', { style: S.error }, error),
    ),
    h('p', { style: S.hint }, `namespace ${NAMESPACE} · revision ${String(snapshot.revision)}`),
  )
}

/**
 * Mount the settings section.
 * @param {object} ctx - browser plugin context.
 */
function apply(ctx) {
  // Child injection: the section appears once the settings services are live, while the package
  // entry itself — the thing the web-boot audit counts — never reports pending.
  try {
    ctx.inject(['settingsScope', 'connection', 'remote'], (scoped) => {
      let controller
      try {
        controller = scoped.settingsScope.bind({ namespace: NAMESPACE })
      } catch {
        // The host does not expose this namespace (settings-not-exposed) — no section, no failure.
        return
      }
      const injected = () => ({ resolveScope: () => controller })
      scoped.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: NAMESPACE,
                order: 70,
                label: () => 'Privacy gate',
                inject: injected,
              },
              PrivacyGateSection,
            ),
          ),
        'privacy-gate: settings section',
      )
    })
  } catch {
    // A host whose client context has no `inject` helper must not fail boot over a missing page.
  }
}


    exports.apply = apply
    exports.inject = inject
    exports.name = NAMESPACE
    return module.exports
  },
})
