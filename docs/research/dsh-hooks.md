# DSH hooks — evidence for the privacy gate

Scope: where a DSH plugin can (a) redact tool output before it is logged, (b) redact or
reject user input, (c) deny reads of binary documents, and (d) why it cannot mask the
outbound LLM request. Every claim carries `path:line` from the extracted install.

**Notation.** `<repo>` = this repository's checkout root, used to anchor repo-relative paths below;
`$DSH_INSTALL` = the DeepSeek Harness installation directory (on Windows, typically
`%USERPROFILE%\AppData\Local\Programs\DeepSeek Harness`). DSH ships its compiled code inside
`app.asar` under `$DSH_INSTALL/resources/`, so the source tree is inspected by extracting it, e.g.
`npx asar extract "$DSH_INSTALL/resources/app.asar" "$DSH_SRC"`; `%USERPROFILE%` (`$HOME` on POSIX)
= the user's home directory. Here `EXT` is `$DSH_SRC\dsh\node_modules\@deepseek-ai\`.

Paths below are relative to `EXT`. Line numbers are from the shipped `lib/index.js`
(compiled JS) of each package, plus `lib/types/api-catalog.js` in `dsh-tool-cordis`, which is a
generated, verbatim catalogue of the public event/method signatures and declarations — it is the
closest thing the install ships to `.d.ts` files (`dsh-tools` ships no type declarations).

Sources read for this note: `dsh-agent-preset/skills/cordis-plugin-development/` (SKILL.md,
references/host-plugin.md, references/practices.md), `dsh-tools/README.md`, `dsh-tools/lib/index.js`,
`dsh-agent-loop/lib/index.js`, `dsh-agent/lib/index.js`, `dsh-llm/lib/index.js`, `dsh-session/lib/index.js`,
`dsh-tool-fs/lib/index.js`, `dsh-tool-jobs/lib/index.js`, `dsh-attachment/lib/index.js`,
`dsh-api-session-controller/lib/index.js`, `dsh-compaction-tool-result-pruner/lib/index.js`,
`cordis/lib/index.js`, `dsh-util-values/lib/index.js`, `dsh-tool-cordis/lib/types/api-catalog.js`.

---

## 1. `tools/post-execute` — the tool-ingress seam (Gate 1)

| Claim | Evidence |
|---|---|
| Signature: `tools/post-execute`(this: `Scoped<ToolRuntime>`, exec: `ToolExecution`, result: `Readonly<ToolExecutionResult>`, next: () => `Promise<PostToolDecision>`) => `Promise<PostToolDecision>`; mode `waterfall`; summary "Accept, replace, enrich, or block a normalized dispatch result" | `dsh-tool-cordis/lib/types/api-catalog.js:4228-4232` |
| `PostToolDecision` is exactly `{kind:'accept', content?: ContentBlock[]}` \| `{kind:'accept', value: JsonValue, content?: never}` \| `{kind:'block', feedback: ContentBlock[], additionalContexts?: UserMessage[]}` | `dsh-tool-cordis/lib/types/api-catalog.js:5911-5912` |
| The dispatch is `ctx.waterfall(scopeTarget(this, exec.agent), 'tools/post-execute', exec, result, () => ({kind:'accept'}))`; `next()` therefore means "accept unchanged" | `dsh-tools/lib/index.js:3504` |
| `block` turns the call into `isError` whose content is the corrective `feedback`; `accept` replaces `content` when the decision owns it; `accept` may replace `value` only for a **successful** result | `dsh-tools/lib/index.js:3506-3531` (block 3506-3513, both-value-and-content rejected 3515, value only for success 3517-3525) |
| Pipeline order: `tools/pre-execute` → monotonic guards → `tools/execute` → `tools/post-execute` → definition `finalizeContent` → `tools/result` (observe-only) | `dsh-tools/README.md:105`; implementation `dsh-tools/lib/index.js:3368` then `3382-3397` |
| A waterfall listener that does not own the decision must return `next()` (registration order matters; a listener that returns without calling `next()` vetoes the rest of the chain and the built-in default) | `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:16`; mechanics `cordis/lib/index.js:307-325` (`waterfall`: last arg is innermost `next`; outermost-first; not calling `next()` vetoes the chain) |
| Consequence for a redactor: `next` is zero-argument and closes over the *original* args, so a listener **cannot** hand a modified result downstream. The supported shape is `const decision = await next()` and then return a modified `decision` (or return `next()` untouched when nothing changed). | `cordis/lib/index.js:317-325` (args popped into a fixed `next` closure) |
| Thrown tool errors also reach this waterfall ("thrown tools still reach this waterfall as errors") | `dsh-tool-cordis/lib/types/api-catalog.js:4230`; `dsh-tools/lib/index.js:3320-3323` |
| Scope filter: dispatched with `scopeTarget(this, exec.agent)`, so a listener registered on a plain (global) context sees every agent; one on `agent.ctx` sees only that agent | `dsh-tools/lib/index.js:3504`; `cordis/lib/index.js:258-264` |
| `decision.value` is re-validated against the tool's declared `output.schema` and both `content` **and** `meta` are re-derived from it (`createSuccessResult`), which is the only supported way to sanitize `meta` | `dsh-tools/lib/index.js:3517-3525` → `createSuccessResult` `3541-3571` (`validateJsonSchemaValue` 3543, `render` 3548, `presentationMeta` 3557) |
| Tool results are appended to the log **after** post-execute, from `result.content` (and `result.meta` is logged too) — so redacting here is the last point before `tool/result` exists | `dsh-agent-loop/lib/index.js:691-707` (`createToolResultMessage({content: result.content})`, `meta: result.meta`); pipeline `dsh-agent-loop/lib/index.js:612-660` |
| `tools/result` is `emit` (observe-only) and receives an already deep-frozen final result — too late to change anything | `dsh-tool-cordis/lib/types/api-catalog.js:4252-4256`; `dsh-tools/lib/index.js:3409-3427` |

Residual gaps, honestly:

| Gap | Evidence | Consequence |
|---|---|---|
| `meta` is not replaceable by any `PostToolDecision` field; only a `value` replacement re-derives it | `dsh-tool-cordis/lib/types/api-catalog.js:5911-5912`; `dsh-tools/lib/index.js:3527-3531` (`{...result, content}` keeps `result.meta`) | For an **error** result (value replacement forbidden, `dsh-tools/lib/index.js:3518`) a tool that put plaintext into `meta` keeps it there. Our gate always redacts content; for success results it replaces `value` so meta is re-derived. |
| `finalizeContent` runs *after* post-execute and can recompute content from the (unredacted) `value` | `dsh-tools/lib/index.js:3382-3407` | In this install only `dsh-tool-jobs` defines it (`dsh-tool-jobs/lib/index.js:240-258`, `315`, `381`) and it only re-derives from `result.value.text` → falls through to `boundSingleText(result.content)` when our redaction changed the text, so it preserves our redaction. A third-party tool's `finalizeContent` could overwrite it — **residual risk**, cannot be closed from a bundle. |
| Whether nested `run_code` sub-dispatches traverse `tools/post-execute` | `dsh-tools/lib/index.js:2673-2679` (scheduler stages), `3067-3082` (`tools/ptc-dispatch-log` shapes the *durable log copy* of a sub-dispatch), `dsh-tool-cordis/lib/types/api-catalog.js:4244` | **UNVERIFIED.** The bundle therefore also listens on `tools/ptc-dispatch-log` (waterfall, returns `ContentBlock[]`) as a defensive second redaction point for PTC log copies. |

`dsh-compaction-tool-result-pruner` is *not* a hook: it is a service that rewrites the current
session surface post-hoc (`compaction/prune` shadow-price + a replacement `tool/result` event with
`surfaceOp:{op:'replace'}`) — `dsh-compaction-tool-result-pruner/lib/index.js:137-191`. It is the
deterministic-substitute reference for rewriting, not an interception point (too late: the original
plaintext `tool/result` event still exists in the log — `dsh-session/lib/index.js:1471`).

---

## 2. `ctx.tools.guard()` — synchronous, monotonic denial

| Claim | Evidence |
|---|---|
| `ToolGuard = (execution: Readonly<ToolExecution>) => string \| undefined`; a returned string denies | `dsh-tool-cordis/lib/types/api-catalog.js:7575`; `dsh-tools/lib/index.js:2911-2926` |
| Guard runs **after** the `tools/pre-execute` waterfall and only when that decision was `allow`; it cannot force-allow, and no later listener can undo a denial | `dsh-tools/lib/index.js:3241`; `dsh-tools/README.md:85`; practices.md:17 |
| A denied call becomes an `isError` result with content `Error: <reason>` and `error.message = reason` — it never dispatches | `dsh-tools/lib/index.js:3243-3257` |
| First monotonic denial wins: global layer first, then the agent scope chain | `dsh-tools/lib/index.js:2927-2936` |
| `exec.arguments` is the parsed, deep-frozen argument value; `exec.name` is the tool name; `exec.agent` the caller | `ToolExecutionInput` `dsh-tool-cordis/lib/types/api-catalog.js:7551`; freeze at `dsh-tools/lib/index.js:3163-3168` |
| Guards are **synchronous** by contract; anything that must await is `ask` from `tools/pre-execute` | practices.md:17 (verbatim: "a guard is synchronous, so a decision that must await something, such as asking the user, returns `ask` from `tools/pre-execute`") |
| `tools/pre-execute` deliberately cannot rewrite arguments, so a pre-execute listener cannot redirect a path — only allow/deny/cancel/ask | `dsh-tools/README.md:230`; `PreToolDecision` `dsh-tool-cordis/lib/types/api-catalog.js:5955-5956` |
| `ctx.tools.restrict()` is *not* usable from a global context and names must be known global tools; it hides tools rather than denying calls | `dsh-tools/lib/index.js:2895-2909` (scoped-context requirement 2897, unknown-name error 2907-2908) |
| Registration returns the exact disposer; every registration must be owned by an effect | `dsh-tools/lib/index.js:2878-2887`; host-plugin.md:54 |

---

## 3. Tool registration and the schema style

| Claim | Evidence |
|---|---|
| `register(definition: ToolDefinition): () => void`; duplicates in one layer throw; `run_code` is reserved | `dsh-tools/lib/index.js:2878-2887` |
| `ToolDefinition extends ToolSchema` (`deferLoading?`, `name`, `description`, `parameters`) with `output: ToolOutputDefinition`, `execute(args, exec)`, optional `projectContent`/`finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult`/`presentationMeta` | `dsh-tool-cordis/lib/types/api-catalog.js:7531`; `ToolOutputDefinition` `7587`; `ToolRunContext` `7619` |
| `output` is mandatory: `{schema: JsonSchemaNode, render(args, value): ContentBlock[], presentationMeta?}` — `register()` throws without `output.render` | `dsh-tools/lib/index.js:2881`; catalog `7587` |
| First-party tools are written with `defineTool({name, description, parameters: {implicit per-property spec}, output: {schema: JSON Schema, render}, execute})`; `defineTool` compiles `parameters`/`output.schema` to raw JSON Schema and wraps `execute` with argument validation (`ToolArgsError`) | `dsh-tools/lib/index.js:838-887` (compile 848-850, validate-and-throw 866-870, compile helpers `802-811`, `792-796`) |
| A **raw** `register()` bypasses that argument validation — the registry only snapshots `exec.arguments`; a raw definition must validate its own arguments | `dsh-tools/lib/index.js:3162-3168` (snapshot only); `dsh-tools/lib/index.js:2063` comment ("Reachable only through a raw `register()` whose `parameters` …") |
| Existing tool schema style to copy (implicit spec + JSON-Schema output + `render`): `read` | `dsh-tool-fs/lib/index.js:261-343` (parameters 264-278, output schema 279-315, render 316-329) |
| Host plugin export forms: `export function apply(ctx, config)` with optional `export const inject` and `export const Config` (no mixing with a default-export service class); resources are registered inside `apply` via `ctx.effect`/`ctx.on` and return cleanup | `host-plugin.md:47-54`; a plugin may also be an async function — cordis awaits the returned thenable (`cordis/lib/index.js:1145`, `200`) |
| Bundle manifest + patch format (`dsh.bundle.patch`, `- insert: [{id, name, config}]`); package specifier `@scope/name`, private, ESM; display text in `locale/en.json` | `host-plugin.md:5-27`, `29-45`; template `templates/decoration/package.json`, `templates/decoration/cordis.patch.yml` |
| Config is validated at activation from the manifest's schemastery `Config`; the row patch replaces `config` wholesale | `host-plugin.md:54`; `cordis-composition-reference/SKILL.md:15` |

---

## 4. The outbound request is frozen — why masking cannot happen on the way out

| Claim | Evidence |
|---|---|
| Every request is derived from the session log: `const boundaryMessages = session.deriveMessages()` | `dsh-agent-loop/lib/index.js:1202` (`buildRequest`), `1262` |
| Header and every boundary message are `deepFreeze`d, the message array is `Object.freeze`d, and the request object itself is `Object.freeze`d before the stream starts | `dsh-agent-loop/lib/index.js:1261` (`deepFreeze(header)`), `1263-1267` (per-message `deepFreeze`), `1268` (`Object.freeze(boundaryMessages)`), `1269-1276` (`markAgentLoopRequest(Object.freeze({...}))`) |
| `deepFreeze` is a recursive freeze over every reachable object/array | `dsh-util-values/lib/index.js:194-...` (iterative `deepFreeze`) |
| The last interception point is `llm/stream`: `ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))` — a listener owns the whole stream, it cannot rewrite `options` and still get normal dispatch | `dsh-llm/lib/index.js:2371`; catalog `dsh-tool-cordis/lib/types/api-catalog.js:4060-4062` |
| `agent/request` replaces only the *call configuration* (provider/model/effort/maxTokens), not messages | `dsh-tool-cordis/lib/types/api-catalog.js:3772-3776` (signature returns `LlmCallConfig`); practices.md:18 ("`agent/request` listeners cannot change request messages") |
| **Implication.** Masking must happen before bytes become a `session` event; anything that reaches the log is what the model sees, replayed and frozen. A plugin can only mask at ingestion. | Consequence of the four rows above; matches the conclusion recorded in [background.md](background.md). |

---

## 5. User-message / attachment ingress (Gate 3) — what actually exists

Append chain for one prompt (the real seam map):

| Step | Evidence |
|---|---|
| The Host prompt controller builds one user message: `content: await this.ctx.attachments.admitPromptContent(admission.content)`, then `agent.followup(message)` (or `agent.steer`) | `dsh-api-session-controller/lib/index.js:876-883` (in `prompt()` `850-899`); same pair for commands `dsh-api-session-controller/lib/types/commands.js:321-330` |
| `admitPromptContent` only admits/normalizes images and passes text + durable `file` refs through — it is a **service method**, not an event, and it returns plain `{type:'text'\|'image'\|'file'}` parts | `dsh-attachment/lib/index.js:242-266` |
| `followup`/`steer`/`inject` → `send()` → `inbox.splice(...)` | `dsh-agent-loop/lib/index.js:800-814` |
| `inbox.splice` durably appends `agent/inbox/spliced` whose data **contains the inserted messages** | `dsh-agent-loop/lib/index.js:180-208` (`splice` → `this.session.append("agent/inbox/spliced", splice)` at `204`, `inserted` at `200`) |
| The inbox is a projection over those events (`stateOf(session, "inbox")`) | `dsh-agent-loop/lib/index.js:174-178` |
| At the step boundary the batch is claimed and offered to `agent/pre-step`; the default decision is `{kind:'enter', messages: claimed}` (plus a runtime-context message) | `dsh-agent-loop/lib/index.js:103-111` (claim), `911-918` (waterfall + default) |
| `PreStepDecision = {kind:'reject'} \| {kind:'enter', messages: UserMessage[], startsRequestSeries?: true}`; summary "Reject a proposed step or replace the messages that enter it" | `dsh-tool-cordis/lib/types/api-catalog.js:3764-3768`, `5952` |
| The loop then appends `user/message` **from the rewritten decision** — `for (const message of decision.messages) this.session.append("user/message", message, {surfaceOp:'append'})` | `dsh-agent-loop/lib/index.js:1061` |
| The payload carries `agent` (fused by `agentEvents.waterfall`) | `dsh-agent/lib/index.js:242-246`, `268-271` |
| Rewriting a pre-step decision must spread it so `startsRequestSeries` survives | practices.md:16 |

**The finding that matters:** the `agent/pre-step` decision rewrite *does* reach the log for
`user/message` (line 1061 appends the rewritten array), so placeholders replace plaintext in the
model-visible history and in every derived request. **But it is not the first write.** By the time
pre-step runs, the raw message is already durable in the earlier `agent/inbox/spliced` event
(line 204) — the inbox must be reconstructable from the log (practices.md:7), so `followup` cannot
avoid logging the message. Consequences:

1. Gate 3's supported seam is `agent/pre-step` (redact text, reject attachment blocks). It
   guarantees the *model-visible* log and every outbound request contain placeholders only, but the
   raw prompt text remains in `agent/inbox/spliced` of that session's JSONL.
2. There is **no** waterfall/event between `admitPromptContent` and `inbox.splice`: `Session.append`
   snapshots, freezes and pushes, then emits `session/event` observe-only — it offers no rewrite
   hook. | `dsh-session/lib/index.js:1441-1481` (snapshot 1447, freeze 1453, push 1471,
   `session/event` 1466-1473); no `session/pre-append`-style hook anywhere in the file. |
3. Closing that residue would require wrapping `agent.followup`/`steer` on an object owned by
   `dsh-agent-loop` (monkey-patching) or replacing the `attachments`/`agents` services. Neither is a
   documented extension point — **UNVERIFIED / unsupported**, deliberately not done.

Attachment-specific facts:

| Claim | Evidence |
|---|---|
| A prompt image is normalized and persisted *before* the message event, and the event references the attachment (never base64) | `dsh-attachment/README.md:66-73`, `30`, `12`; `dsh-attachment/lib/index.js:242-266` |
| A non-image file is stored verbatim and the message records name/size/digest; the model gets a saved path to read | `dsh-attachment/README.md:40`, `72` |
| `ImageBlock = {type:'image', attachment: ImageAttachmentRef, offloaded?}`, `FileBlock = {type:'file', attachment: FileAttachmentRef}`; content block types are `text\|reasoning\|image\|file\|tool-call\|tool-addition\|tool-removal` | `dsh-tool-cordis/lib/types/api-catalog.js:5267`, `5115`, `4788` |
| `read_image` returns a text block **plus an `ImageBlock`** — bytes cannot be turned into text by any hook | `dsh-tool-fs/lib/index.js:955-963` (`imageReadContent`), registration `973-1057` |
| `read` returns `[{type:'text', text: formatReadOutput(...)}]` — plain text, redactable | `dsh-tool-fs/lib/index.js:316-329` |

So Gate 3 = redact text + `{kind:'reject'}` the step on image/file blocks; no seam can convert an
image to text or un-log the prompt. A rejection exposes no reason text (`PreStepDecision` has none —
`dsh-tool-cordis/lib/types/api-catalog.js:5952`) and ends the turn as `blocked`
(`dsh-agent-loop/lib/index.js:958-960`). **[UNVERIFIED]** what the UI shows for a blocked turn.

---

## 5b. Does the raw `agent/inbox/spliced` payload re-enter the request on resume / fork / replay?

**No — proved below.** The request is built from the surface fold only, and the inbox event is
structurally unable to become a surface node.

| Claim | Evidence |
|---|---|
| The model request's `messages` come from exactly one call: `const boundaryMessages = session.deriveMessages()` | `dsh-agent-loop/lib/index.js:1262`. The only other `deriveMessages()` caller in the whole install is the loop's own consistency check (`dsh-agent-loop/lib/invariant.js:26`). |
| `deriveMessages()` walks `surface.nodes` (events carrying a valid `surfaceOp`) and projects each node with `deriveEventMessage` | `dsh-session/lib/index.js:1554-1569` (doc comment: "The surface is the single source of derived history: every message-producing append records its `surfaceOp`, so a raw event with no marker … is correctly absent") |
| `deriveEventMessage` maps only five event types and returns `null` for everything else: `user/message`, `system/message`, `developer/message`, `assistant/message`, `tool/result` | `dsh-session/lib/index.js:214-227` (`case "user/message": return event.data` at 218; `default: return null` at 225) |
| Only those five types are surface-eligible (`SURFACE_EVENT_TYPES`), and a non-eligible type that carries a `surfaceOp` is **rejected** at append time | `dsh-session/lib/index.js:154-160` (`SURFACE_EVENT_TYPES`), `164-167` (`isSurfaceEligibleType`), `200-201`, `295-308` (`surfaceOpOf` throws "not surface-eligible and cannot carry surfaceOp") |
| `agent/inbox/spliced` is not one of them and is appended **without** surface metadata, so it can never be a node | type list `dsh-session/lib/types/known-event-types.js:23`; append `dsh-agent-loop/lib/index.js:204` (no third argument) |
| **Resume** loads the persisted events and seeds a Session with them plus synthetic closers, then publishes — it neither re-admits inbox content nor re-appends a `user/message`, and it does not auto-drive a turn | `dsh-agent-loop/lib/index.js:1927-1977` (cold read 1947, `interruptedTurnClosers` 1950-1951, `prepare({seed:[...persisted, ...closers]})` 1952-1957, publish 1970) |
| The synthetic resume closers are constant texts (never derived from user/tool payloads) and are `tool/result` messages | `dsh-session/lib/types/repair.js:137-176` (`text = CLOSER_TEXT[...]` 143, content 154-157, `surfaceOp: 'append'` 171) |
| Messages still *pending* in a restored inbox are re-admitted through the normal step boundary when a turn runs: `claim()` → `agent/pre-step` → append `user/message` — i.e. through Gate 3's rewrite, not around it | `dsh-agent-loop/lib/index.js:103-111` (claim), `911-918` (pre-step), `1061` (append from `decision.messages`) |
| **Fork** copies an inclusive event prefix, adds the inherited-marker event and turn closers; the child's surface fold is the copied surface (whose `user/message` events were already the redacted ones written at append time). No inbox re-derivation | `dsh-session/lib/types/fork.js:18-27` (`buildForkSeed`) |
| Every *other* consumer of `agent/inbox/spliced` is UI/API/accounting/migration, not request assembly: attachment authorization scan, client projection, ACP, consumed-work accounting, team-message dedupe, session-format migrations | `dsh-api-session-controller/lib/index.js:1096-1105` (image authorization scan only), `dsh-api-session-controller/lib/client.js:2158`, `lib/types/client/sessions/session.js:679`, `dsh-acp/lib/index.js:1107`, `dsh-agent/lib/index.js:98-104`, `dsh-experimental-agent-team/lib/index.js:271`, `dsh-session-format-v2-to-v3/lib/index.js:105-106` |
| **Caveat (not a hole in the fold, a real limit):** history that was logged *before* the gate was active (or a fork of such a session) is replayed as-is — the gate never rewrites existing `user/message` events. A retroactive scrub would need a replacement `user/message` event written on resume (supported shape: `surfaceOp` replace, `dsh-session/lib/index.js:200-201`, `306-308`), which this bundle does not do. **[UNVERIFIED]** whether such a retroactive replacement is safe for every consumer (token meters, UI transcript, forks). | |

Conclusion: the raw inbox payload is a **local-only** residue in the session JSONL; it is *not*
included in any request, on fresh, resumed, forked, or replayed sessions. The provider-visible
guarantee holds as long as the gate is active before the prompt arrives.

## 6. `read` / `read_image`: guard, block, or redact?

| Claim | Evidence |
|---|---|
| `read_image` is an ordinary registered tool (`name: "read_image"`), so a guard can deny it by name and a post-execute listener can see/block its result | `dsh-tool-fs/lib/index.js:973-997`; guard semantics §2 |
| Its result content is `[text, ImageBlock]` — a redactor can redact the text block but **cannot** redact the image block, so the only fail-closed choices are deny (pre-dispatch) or block (post-execute) | `dsh-tool-fs/lib/index.js:955-963`, `1035-1046` |
| A post-execute `block` on a result carrying an `ImageBlock` is expressible: `{kind:'block', feedback: ContentBlock[]}` | `dsh-tool-cordis/lib/types/api-catalog.js:5911-5912` |
| `read` of a document is only visible to a guard as `exec.arguments.file_path` (a string); the guard cannot stat the file (synchronous, no I/O contract) | `dsh-tool-cordis/lib/types/api-catalog.js:7575`; practices.md:17 |
| `read_image` is only registered while `attachments` is mounted and refuses non-image bytes itself | `dsh-tool-fs/lib/index.js:966-970`, `998-1011` |

Implemented rule (see `plugins/dsh-privacy-gate/`): guard denies `read_image` always; guard denies `read` when the
extension is a binary/document type and the path is outside `allowPaths`; post-execute blocks any
result whose text hits `BLOB` (base64/hex/PDF magic/ZIP magic, contiguous, line-wrapped or spaced
hex, `data:` URI) and any result carrying a non-text block. A shell (`pwsh`) `cat`/base64/`Format-Hex`
dump is caught by the BLOB rule on its result: the thresholds are 400 chars, sized so a one-page
invoice (~1.3 k base64 chars) is caught ([security review](security-review.md) B1/B2).

**Limitation of the extension rule:** it is suffix-based and case-insensitive, so a renamed copy
(`invoice.dat`) is not denied by the guard; it is still caught by the BLOB rule if its bytes are
returned as base64, and by `text` detection only if the extension is honest. This is a heuristic,
not a sandbox — the authoritative sandbox is `ctx.fs`/`dsh-sandbox`.

---

## 7. Sessions, append and events

| Claim | Evidence |
|---|---|
| `Session.append(type, data, ...opts)` snapshots `data` losslessly, deep-freezes the event, validates known event types, pushes it to the log, then dispatches `session/event` observe-only; there is no pre-append hook | `dsh-session/lib/index.js:1441-1481` |
| Known event types include `user/message`, `tool/result`, `agent/inbox/spliced`, `image/offload` — an unknown type is refused on reopen, so a plugin must not append its own type | `dsh-session/lib/types/known-event-types.js:23` (`agent/inbox/spliced`), `75` (`tool/result`), `78` (`user/message`), `43`+`84` (`image/offload`); practices.md:21 |
| The log is the source of truth for fork/resume/replay; plugin memory is a derived cache | practices.md:7 |
| A per-session projection is the supported place for derived state | practices.md:26 |

---

## 8. What this gate is and is not (summary of the seam map)

1. **Tool ingress (works):** `tools/post-execute` → redact `content` (always), replace `value` on
   success (re-derives content **and** `meta`), block on `BLOB`/non-text; `next()` returned when
   nothing changed.
2. **User ingress (partly works):** `agent/pre-step` → redact text, `reject` on image/file blocks.
   The `user/message` event and every request derived from it are clean; the earlier
   `agent/inbox/spliced` event keeps the raw text. No supported earlier seam exists.
3. **Binary reads (works by denial):** `tools.guard` denies `read_image` and document `read`
   outside `allowPaths`; `tools/post-execute` blocks smuggled blobs.
4. **Outbound request (impossible):** deep-frozen fold of the log
   (`dsh-agent-loop/lib/index.js:1261-1276`); masking there is not a supported seam.
5. **Local extraction (ours):** the plugin's own tools shell out to
   `packages/local-extract/cli.js`; a blocked CLI result throws, so nothing but redacted text can
   ever be returned as tool content.
6. **Defensive extra:** `tools/ptc-dispatch-log` redacts the durable log copy of `run_code`
   sub-dispatches (see the UNVERIFIED row in §1).

## 9. UNVERIFIED list

- Nested `run_code` sub-dispatch behaviour of `tools/post-execute` (§1) — mitigated by
  `tools/ptc-dispatch-log`; whether that covers *all* nested results is unverified.
- Whether a third-party tool's `finalizeContent` can reintroduce plaintext after our redaction (§1).
- A tool's `meta` on an **error** result cannot be rewritten by `PostToolDecision` (§1).
- What the UI renders for an `agent/pre-step` `{kind:'reject'}` turn (§5).
- Whether an `admitPromptContent`/`agents` seam can be intercepted by any documented mechanism
  (none found; treated as unsupported).
- Whether a retroactive `user/message` replacement written on resume (§5b caveat) is safe for every
  consumer (token meters, UI transcript, forks).
- Sandbox/ACL enforcement of `allowPaths`: the gate compares normalized path strings; it does not
  re-implement `dsh-fs-sandbox`.

Verified while wiring the real core (no longer open):

- `pii-core` reports BLOB hits **and** masks them as placeholders, but excludes BLOB from restore
  (`NON_RESTORABLE`, `packages/pii-core/index.js:53`; replacement loop `1266-1292`; non-restorable
  values are never cached, `1241-1254`). The gate therefore never relies on the masking: it reads
  the hit kind and blocks (`plugins/dsh-privacy-gate/lib/redact.js`).
- `redactor.restore()` resolves only values masked by that **same redactor instance**
  (`values` map `packages/pii-core/index.js:1189`, filled at `1287`, read at `1296-1305`), so
  `privacy_rehydrate` is session-scoped and refuses placeholders it cannot resolve. Cross-restart
  restore needs `pii-core`'s encrypted `vault.js` — not wired by this bundle.

## 10. What a supported plugin seam cannot do

Quoted by the "residual local exposure" section of [design.md](../design.md); each item is proved above.

1. **Cannot mask the outbound request.** It is `Object.freeze`d and deep-frozen after being derived
   from the log (§4), and `agent/request` may only change the call config (§4). Ingestion is the
   only place to mask.
2. **Cannot keep the raw prompt out of the local session log.** `followup`→`send`→`inbox.splice`
   durably logs the prompt in `agent/inbox/spliced` before `agent/pre-step` runs, and
   `Session.append` has no pre-append hook (§5). Masking at `agent/pre-step` keeps the
   *model-visible* log and every request clean; the raw text remains local plaintext.
3. **Cannot turn an image or attachment into masked text.** `read_image` returns an `ImageBlock`
   beside its text; `admitPromptContent` is a plain service method with no event/waterfall (§5, §6).
   The only fail-closed answers are deny (guard) and reject (pre-step) — this bundle does both.
4. **Cannot rewrite every field of a tool result.** `tools/post-execute` can replace `content`
   (always) and `value` (only on success, which re-derives `meta`); a failed result's `meta` has no
   replacement field (§1). A third-party `finalizeContent` runs after the gate and could
   reintroduce text (§1).
5. **Cannot scrub history.** Events appended before the gate was active are replayed unchanged on
   resume/fork; a retroactive surface replacement is technically possible but unverified for every
   consumer (§5b, §9).
6. **Cannot recognize a document by content.** The guard classifies by extension
   (`lib/paths.js`), so a renamed copy is only caught when its bytes are returned as text/base64
   (`BLOB` block). The authoritative confinement is the `dsh-fs`/`dsh-sandbox` layer, not this gate.
