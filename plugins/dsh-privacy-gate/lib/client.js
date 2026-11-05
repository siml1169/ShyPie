/**
 * Browser half of the DSH privacy gate.
 *
 * The renderer evaluates this file, so it registers through the same
 * `window.__ModuleLoader__.load({ id, factory })` wrapper the core client packages use.
 *
 * Configuration travels over the host's own same-origin route (`/shypie-privacy/settings`) rather
 * than a settings namespace: the host api-proxy serves only an allowlist of namespaces and a
 * third-party one answers `settings-not-exposed`. This mirrors how Plugin Hub (`dsh-plugin`) works
 * in this profile. The module injects only `slots`, so the package entry can never sit pending and
 * block web boot.
 */

window.__ModuleLoader__.load({
  id: '@shypie_privacy/dsh-privacy-gate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')

    const h = react.createElement

    /** The only service this entry needs; anything else stays out of the boot-critical inject. */
    const inject = ['slots']

    /** Section id and the routes the host half serves. */
    const NAMESPACE = 'privacy-gate'
    const ENDPOINT = '/shypie-privacy/settings'
    const SESSION_ENDPOINT = '/shypie-privacy/session'
    const ENGINES_ENDPOINT = '/shypie-privacy/engines'

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

    /** Resolved values to editable draft strings. */
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

    /** Only the fields the user actually changed. */
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

    async function readSettings() {
      const response = await fetch(ENDPOINT, { cache: 'no-store' })
      if (!response.ok) throw new Error(`settings read failed (${response.status})`)
      return await response.json()
    }

    async function writeSettings(patch) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `save failed (${response.status})`)
      return body
    }

    async function readSession(sessionId) {
      const response = await fetch(`${SESSION_ENDPOINT}?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`session read failed (${response.status})`)
      return await response.json()
    }

    async function writeSession(sessionId, enabled) {
      const response = await fetch(SESSION_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId, enabled }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `toggle failed (${response.status})`)
      return body
    }

    async function readEngines() {
      const response = await fetch(ENGINES_ENDPOINT, { cache: 'no-store' })
      if (!response.ok) throw new Error(`engine probe failed (${response.status})`)
      const body = await response.json().catch(() => ({}))
      return {
        engines: Array.isArray(body.engines) ? body.engines : [],
        note: typeof body.note === 'string' ? body.note : '',
      }
    }

    /** Local engines the extractor reports; `auto` picks the first available one. */
    function EnginesPanel() {
      const [probe, setProbe] = react.useState(null)
      react.useEffect(() => {
        let live = true
        readEngines()
          .then((body) => {
            if (live) setProbe(body)
          })
          .catch(() => {
            if (live) setProbe({ engines: [], note: '' })
          })
        return () => {
          live = false
        }
      }, [])
      if (probe === null) return h('p', { style: S.hint }, 'Probing local OCR engines…')
      if (probe.engines.length === 0) {
        return h('p', { style: S.hint }, 'No local OCR engine was detected. PDFs with a text layer still work through pdftotext.')
      }
      return h(
        'div',
        { style: S.row },
        h(
          'ul',
          { style: { ...S.hint, margin: 0, paddingLeft: '18px' } },
          ...probe.engines.map((engine) =>
            h(
              'li',
              { key: engine.name },
              `${engine.name}: available`,
              Array.isArray(engine.languages) && engine.languages.length > 0 ? ` (${engine.languages.join(', ')})` : '',
              engine.detail ? ` — ${engine.detail}` : '',
            ),
          ),
        ),
        probe.note === '' ? null : h('p', { style: S.hint }, probe.note),
      )
    }

    /** The Settings section. */
    function PrivacyGateSection() {
      const [state, setState] = react.useState({ status: 'loading', value: {}, revision: undefined })
      const [draft, setDraft] = react.useState(() => toDraft({}))
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [saved, setSaved] = react.useState('')

      const load = react.useCallback(async () => {
        setState((current) => ({ ...current, status: 'loading' }))
        try {
          const body = await readSettings()
          setState({ status: 'ready', value: body.value ?? {}, revision: body.revision })
          setDraft(toDraft(body.value ?? {}))
          setError('')
        } catch (cause) {
          setState({ status: 'error', value: {}, revision: undefined })
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      react.useEffect(() => {
        load()
      }, [load])

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
          const patch = diff(draft, state.value)
          const fields = Object.keys(patch)
          if (fields.length === 0) {
            setSaved('Nothing to save.')
          } else {
            const body = await writeSettings(patch)
            setState({ status: 'ready', value: body.value ?? {}, revision: body.revision })
            setDraft(toDraft(body.value ?? {}))
            setSaved(`Saved ${fields.length} field${fields.length === 1 ? '' : 's'}.`)
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      if (state.status === 'loading') return h('p', { style: S.note }, 'Loading the privacy gate settings…')

      return h(
        'div',
        { style: S.root },
        h(
          'p',
          { style: S.note },
          'These values layer over the profile patch and are stored in ~/.dsh/privacy/settings.json. The host applies them immediately.',
        ),
        h(
          Field,
          {
            id: 'privacy-scope',
            label: 'Scope',
            hint: 'session protects sessions created after the gate first ran; system gates every session, including history written before the gate existed.',
          },
          h(
            'select',
            { id: 'privacy-scope', style: S.input, value: draft.scope, onChange: update('scope'), disabled: busy },
            ...SCOPE_VALUES.map((option) => h('option', { key: option, value: option }, option)),
          ),
        ),
        h(
          Field,
          {
            id: 'privacy-paths',
            label: 'Allowed document paths',
            hint: 'One absolute path prefix per line. Empty denies every document (fail closed).',
          },
          h('textarea', {
            id: 'privacy-paths',
            style: S.textarea,
            value: draft.allowPaths,
            onChange: update('allowPaths'),
            disabled: busy,
            spellCheck: false,
          }),
        ),
        h(
          Field,
          {
            id: 'privacy-extract',
            label: 'Local extractor CLI',
            hint: 'cli.js of @shypie_privacy/local-extract. Empty resolves the sibling checkout, then the installed package.',
          },
          h('input', {
            id: 'privacy-extract',
            style: S.input,
            value: draft.extractCli,
            onChange: update('extractCli'),
            disabled: busy,
            spellCheck: false,
          }),
        ),
        h(
          Field,
          {
            id: 'privacy-ocr',
            label: 'OCR engine',
            hint: 'auto uses the first available local engine — Windows OCR (winrt-ocr) on this machine. Nothing leaves the machine in any mode.',
          },
          h(
            'select',
            { id: 'privacy-ocr', style: S.input, value: draft.ocrEngine, onChange: update('ocrEngine'), disabled: busy },
            ...OCR_VALUES.map((option) => h('option', { key: option, value: option }, option)),
          ),
        ),
        h(EnginesPanel),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, 'Manual OCR'),
          h(
            'ol',
            { style: { ...S.hint, margin: 0, paddingLeft: '18px' } },
            h('li', null, 'Put the document under one of the allowed paths above, or add its folder.'),
            h('li', null, 'In the conversation, ask the agent: “run privacy_ocr on <path> and summarize it”.'),
            h('li', null, 'The tool returns placeholder-masked text as the tool result; the agent reads that result as part of the prompt — you do not paste it.'),
            h('li', null, 'Nothing is sent if the local engine cannot read the file: the tool fails closed instead of returning bytes.'),
          ),
          h(
            'p',
            { style: S.hint },
            'privacy_extract handles PDFs with a text layer and Office files; privacy_ocr is for scans and images. privacy_scan checks free text without extracting anything.',
          ),
        ),
        h(
          Field,
          { id: 'privacy-vision-provider', label: 'Vision provider (unused today)' },
          h('input', {
            id: 'privacy-vision-provider',
            style: S.input,
            value: draft.visionProvider,
            onChange: update('visionProvider'),
            disabled: busy,
            spellCheck: false,
          }),
        ),
        h(
          Field,
          { id: 'privacy-vision-model', label: 'Vision model (unused today)' },
          h('input', {
            id: 'privacy-vision-model',
            style: S.input,
            value: draft.visionModel,
            onChange: update('visionModel'),
            disabled: busy,
            spellCheck: false,
          }),
        ),
        h(
          'label',
          { style: S.row },
          h(
            'span',
            { style: S.label },
            h('input', { type: 'checkbox', checked: draft.allowAgentDisable, onChange: onToggle, disabled: busy }),
            ' Allow the agent to turn the gate off for a session',
          ),
          h(
            'p',
            { style: S.hint },
            'Off by default: a prompt-injected instruction must not be able to disable the gate. privacy_session can always turn it on.',
          ),
        ),
        h(
          'div',
          { style: S.actions },
          h('button', { type: 'button', style: S.button, onClick: onSave, disabled: busy }, busy ? 'Saving…' : 'Save'),
          h(
            'button',
            {
              type: 'button',
              style: S.button,
              onClick: () => {
                setDraft(toDraft(state.value))
                setSaved('')
                setError('')
              },
              disabled: busy,
            },
            'Discard',
          ),
          saved === '' ? null : h('span', { style: S.note }, saved),
          error === '' ? null : h('span', { style: S.error }, error),
        ),
        h('p', { style: S.hint }, `namespace ${NAMESPACE} · revision ${String(state.revision ?? '-')}`),
      )
    }

    /**
     * Composer switch: on/off for the current session.
     * `conversation.input.dock` is a list slot whose `inject` receives the session id, which is
     * what the session route needs; the model selector itself is a single-slot owned by
     * `dsh-client-ui-model-selection`, so a dock chip is the additive place for a third plugin.
     */
    function PrivacyGateSwitch(props) {
      const sessionId = props.sessionId
      const [state, setState] = react.useState({ status: 'loading', enabled: false, scope: 'session' })
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')

      react.useEffect(() => {
        let live = true
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          setState({ status: 'error', enabled: false, scope: 'session' })
          return () => {
            live = false
          }
        }
        readSession(sessionId)
          .then((body) => {
            if (live) setState({ status: 'ready', enabled: body.enabled === true, scope: String(body.scope ?? 'session') })
          })
          .catch(() => {
            if (live) setState({ status: 'error', enabled: false, scope: 'session' })
          })
        return () => {
          live = false
        }
      }, [sessionId])

      const toggle = async () => {
        setBusy(true)
        setError('')
        try {
          const body = await writeSession(sessionId, !state.enabled)
          setState({ status: 'ready', enabled: body.enabled === true, scope: String(body.scope ?? 'session') })
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const label =
        state.status === 'loading' ? 'Privacy gate …' : state.status === 'error' ? 'Privacy gate ?' : `Privacy gate ${state.enabled ? 'on' : 'off'}`

      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' } },
        h(
          'button',
          {
            type: 'button',
            title:
              state.scope === 'system'
                ? 'Scope is system: the gate applies to every session and this switch does not change that.'
                : state.enabled
                  ? 'The gate is on for this session. Click to turn it off for this session.'
                  : 'The gate is off for this session. Click to turn it on.',
            disabled: busy || state.status !== 'ready' || state.scope === 'system',
            onClick: toggle,
            style: {
              ...S.button,
              padding: '3px 10px',
              fontSize: '12px',
              opacity: state.enabled ? 1 : 0.7,
              borderColor: state.enabled ? 'rgba(46,160,67,0.8)' : 'rgba(128,128,128,0.35)',
            },
          },
          `${state.enabled ? '●' : '○'} ${label}`,
        ),
        state.scope === 'system' ? h('span', { style: S.hint }, 'scope: system') : null,
        error === '' ? null : h('span', { style: S.error }, error),
      )
    }

    /**
     * Mount the settings section.
     * @param {object} ctx - browser plugin context.
     */
    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register(
              {
                name: 'settings.section',
                id: NAMESPACE,
                order: 70,
                label: () => 'Privacy gate',
              },
              PrivacyGateSection,
            )
          } catch {
            return undefined
          }
        })
      } catch {
        // A host without this slot must not fail boot over a missing page.
      }
      try {
        ctx.slots.inject('conversation.input.dock', () => {
          try {
            return ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: NAMESPACE,
                order: 30,
                inject: (sessionId) => ({ sessionId: typeof sessionId === 'string' ? sessionId : '' }),
              },
              PrivacyGateSwitch,
            )
          } catch {
            return undefined
          }
        })
      } catch {
        // No composer dock in this host: the switch is simply absent.
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = NAMESPACE
    return module.exports
  },
})
