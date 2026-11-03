# Magpie gateway middleware — evidence notes for the privacy gate

Everything below was read on **2026-11-02** from the official docs. Every claim carries a URL and
the sentence(s) it rests on (HTML/markdown escaping from the docs' own rendering normalised:
`\[` → `[`, `\_` → `_`). Anything the docs do not state is marked **UNVERIFIED**, with the reason.

Sources:

- S1 = <https://usemagpie.ai/docs/plugins#middleware> (sections *Gateway middleware*, *The hooks*,
  *How it runs*, *Ready-made middleware*, *Options*, *Tools for every agent*)
- S2 = <https://usemagpie.ai/docs/masking> (sections *Turn it on*, *What is masked*, *Check that it
  works*, *When a value is found*, *What it leaves alone, and limits*)
- S3 = <https://usemagpie.ai/docs/privacy>
- S4 = <https://usemagpie.ai/docs/integrate#gateway>
- S5 = <https://raw.githubusercontent.com/yetone/magpie/main/docs/reference.md> (*Gateway
  middleware* section, the full manual the docs site summarises)
- S6 = <https://usemagpie.ai/docs/plugins#middleware-options> (the *Options* subsection)

---

## 1. Where middleware runs, and what it may use

| # | Claim | Quoted evidence | Source |
|---|---|---|---|
| R1 | Middleware runs in moejs **inside the gateway process**, not on Bun | "Middleware isn't run on Bun. It runs inside the gateway's own process, in [moejs](https://github.com/MoeForge/moejs), a JavaScript engine written in Go, because a reply streams thousands of events and each one waits for it." | S1 |
| R2 | Compiled once; a runtime per request; `ctx.state` is the only per-request sharing | "Each middleware is compiled once, and each request gets a runtime of its own, so requests run in parallel and a request's hooks share `ctx.state`." | S1 |
| R3 | Imports only from inside the plugin, no `node_modules` | "**Imports.** Only files inside the plugin, by relative path. There is no `node_modules` here: bundle what you import into the file." | S1 |
| R4 | Standard JS + `console.log` only; **no timers, no `fetch`, no Node APIs** | "**What it has.** Standard JavaScript and `console.log` (into magpie's log, at most 60 lines a minute). There are no timers, no `fetch` and no Node APIs. A hook may be `async`, but there is nothing for it to wait on." | S1 |
| R5 | Declared by `"magpie": { "middleware": "./mw.js" }` or a `*.middleware.js` file; a package with no `main`/`exports` is middleware only | "**Declaring it.** `"magpie": { "middleware": "./mw.js" }` in `package.json`, or a single file named `*.middleware.js` (or `.mjs`). A package with no `main` and no `exports` is only middleware, and the plugin host leaves it alone; one with both is a provider plugin and middleware at once." | S1 |
| R6 | Reload by file watch, once a second | "**Changes.** magpie looks at the files and `plugins.json` once a second, and loads a middleware again when they changed." | S1 |
| R7 | **250 ms per request hook, 50 ms per event** — and a failure **fails open** | "**When a hook fails.** A hook has 250 ms for a request, a provider's try or a whole reply and 50 ms for an event; loading has a second. A hook that throws, runs out of time or returns something else goes on as if it weren't there: the request or the event is sent as it was." | S1 |
| R8 | Same fail-open rule restated in the full manual | "A hook that throws or takes too long (250 ms a request, 50 ms an event) leaves what it was given as it was." | S5 |
| R9 | The built-in `middleware` plugin must be on for any of this to run | "Middleware runs through the built-in plugin `middleware` (Gateway middleware in Plugins › Built-in), which stays on while one is on. Turned off, no middleware runs and agents' requests go as they came." | S5 |

**Consequence for this plugin (the reason `gate.middleware.js` never throws):** R7/R8 mean an
exception is **not** a blocked request — it is an *unblocked* one. Every hook therefore catches its
own errors, and a failure inside the gate is turned into `ctx.reject(403, …)`. The 250 ms budget is
the reason the body walk is bounded and a request too large to inspect is rejected instead of being
passed unscanned.

## 2. The hooks

| # | Hook | Quoted evidence | Source |
|---|---|---|---|
| H1 | `onRequest(body, ctx)` | "The request body, before routing: a new `model` routes it elsewhere." | S1 |
| H2 | `onRequest` may reject | "The body, or nothing. `ctx.reject(status, message)` turns the request away with that error, in the agent's API (403 when no status is given)." | S1 |
| H3 | `onProvider(body, ctx)` | "The request body as it is about to go to one provider; `ctx.provider` has its `id`, `name`, `account` (the subscription's kind, such as `claude` or `antigravity`; absent for an API key) and `model`. It is called again for each provider a request is tried on, each time with the body `onRequest` left, so a change for one provider reaches no other." | S1 |
| H4 | `onProvider` **cannot** reject | "The body, or nothing. The request is routed by now: it can't be turned away or sent elsewhere." | S1 |
| H5 | Bodies are in the **agent's** API, not the provider's | "Bodies and events are in the agent's own API (`ctx.protocol`), not the provider's. Return the object to send on, or nothing to send it on as it was." | S1 |
| H6 | `ctx` fields | "`ctx` has `protocol` (`anthropic`, `chat`, `responses` or `gemini`), `model` and `stream` as the agent asked, `path`, `agent` when magpie knows it, `options` (the plugin's [options](https://usemagpie.ai/docs/plugins#middleware-options)) and `state`, an object of the request's own." | S1 |
| H7 | `ctx.reject` usage shape (worked example) | "`if ((ctx.options.blocked ?? []).includes(body.model)) return ctx.reject(403, "not this model")`" — i.e. **return** the result of `ctx.reject` | S1 |
| H8 | `onUsage(row, options)` — audit only, no bodies | "**Usage.** `onUsage(row, options)` gets each request's usage row after it ends: provider, account and key, model, tokens, `ms`, `ttftMs`, status, error type and cost, never a body, prompt or error text. It runs on its own, so a request never waits for it; rows that come while it is busy past a queue are dropped and counted. It has 250 ms." | S1 |
| H9 | `onUsage` is documented next to `strategies` for `*.gateway.js` files | "The same module can also export `strategies` and `onUsage`. Such a file can be named `*.gateway.js`, and a package can say `"magpie": { "gateway": "./gw.js" }`." | S1 |
| H10 | Named export or member of `export default` | "Each is a named export or a member of `export default { … }`." | S1 |

**UNVERIFIED (H9):** whether a module declared only through `"magpie": { "middleware": … }` also has
its `onUsage` called. The docs introduce `onUsage` in the *gateway file* paragraph, and do not say a
middleware file's `onUsage` is loaded. `gate.middleware.js` exports `onUsage` anyway (harmless if
ignored); if it is ignored, the audit trail is the `onRequest` block lines plus Settings → Plugins'
per-hook call/failure counters. No test can settle this without a live gateway, which this
review does not touch.

**UNVERIFIED (H6):** the exact `row` field names for "error type" (`errorType` vs `error_type` vs
`error`). The gate therefore reads all three defensively and only ever logs counts, never the value.
`onUsage` is also written so a missing/renamed field cannot throw.

## 3. Ordering relative to masking

| # | Claim | Quoted evidence | Source |
|---|---|---|---|
| O1 | Hooks see the request **before** magpie's redaction, the reply after it | "The hooks see what the agent sent and gets back, before magpie's redaction on the way out and after it on the way back." | S1 |
| O2 | magpie's own requests skip middleware | "magpie's own requests (thread titles, the router's classifier, the web searches and image descriptions it makes for an agent's request) don't go through middleware." | S1 |
| O3 | Text masking is a separate built-in plugin (`redact`), on whenever any masking is asked for | "The work is done by the built-in plugin Privacy masking (`redact`, in Settings → Plugins), which is on whenever any masking is asked for." | S2 |
| O4 | Masking **fails closed** with 503 | "**It fails closed.** If masking is on and can't run (the Privacy masking plugin turned off by hand, or the local model you turned on can't answer), the request gets a 503 that says nothing was sent. It is never sent unmasked instead." | S2 |
| O5 | The masking block path uses **400** and never echoes the value | "Block: the request is held back with a 400, _"magpie held this request back: Settings › Privacy blocks API_KEY, and it has one (sk-…, 33 characters). Nothing was sent."_ The message never has the value." | S2 |

**Ordering, as it matters to this plugin:** `onRequest` (this gate) → routing/translation → `redact`
(masking) → provider; on the way back: provider → unmask → `onEvent`/`onResponse`. Two consequences:

1. **This gate must never reject plaintext PII.** At `onRequest` time nothing is masked yet, so a
   PII-shaped string is normal input and rejecting it would double-guess the masker (contract rule 5).
   The gate looks only at *structure* (part types) and at *encoded* payloads, which masking cannot
   read anyway.
2. **This gate is the only structural boundary.** O1 puts it before masking; O4 means masking fails
   closed for text; nothing in S1/S2 gives masking any control over binary parts (see §4).

## 4. The structural gap this plugin exists to close

| # | Claim | Quoted evidence | Source |
|---|---|---|---|
| G1 | **Masking cannot touch binary parts** | "**Images and file data are sent as they are.** Text inside a screenshot is not masked." | S2 |
| G2 | Unmaskable text content is still sent under a provider opt-out | "A provider can skip it. Send requests unmasked on a provider sends its requests as written: a model on this computer or your local network (Ollama, LM Studio), and, if you choose, any other provider, a subscription or a plugin's provider too." | S2 |
| G3 | Masking record keeps metadata, never values (matches contract I10) | "The records are kept in `~/.config/magpie/masking` for 30 days: the agent, provider, model, and each placeholder's kind, length and first characters, never the value." | S2 |
| G4 | Masking is off by default | "It runs on this computer, in magpie's gateway, and is **off by default**." | S2 |
| G5 | Masking is configured in the window or `settings.json`; no CLI | "There is no CLI command for it. Without the window (`magpie serve`, [Docker](https://usemagpie.ai/docs/docker)), open the same page with `magpie web`, or set it in `~/.config/magpie/settings.json` (`/config/magpie/settings.json` in Docker). The masker reads the file on every request:" — then the snippet `{"redact": true, "redactPersonal": true, "redactWords": ["Nightjar", "db.acme-corp.cn"]}` | S2 |
| G6 | What "personal data" covers (for the README's Settings → Privacy checklist) | "Emails, mainland China mobile numbers … Also on by default: US Social Security numbers, passport numbers (after _passport_, 护照 or パスポート), IBANs, birthdays (next to _birthday_, _DOB_ or 生日, and over a year ago, so today's date stays), MAC addresses and serial numbers (after _S/N_). Off until you turn them on … the user name in home folders …, user and computer names (`user@host`), public IP addresses … and cloud storage buckets." | S2 |
| G7 | A local model does the free-text finding; it is a local download | "It is on unless you turned it off, and AstrLink Guard downloads with the first masked request; until it is on disk, the rules mask alone." | S2 |
| G8 | "Try it" is the documented verification for masking | "**Try it** Paste a text into Try it to see exactly what the vendor would get. What you paste there isn't kept." | S2 |
| G9 | A per-kind **Block** action exists for text (not for binary) | "Under When a value is found, choose per kind: Mask (the default) … Warn … Block …" | S2 |
| G10 | magpie's own telemetry switches (README recommends them for this workflow) | "Settings → Privacy → Count me as a user off, or `"noStats": true` in `settings.json` stops the whole daily count." / "`DO_NOT_TRACK=1` or `MAGPIE_NO_STATS=1` in magpie's environment … stops the whole daily count" | S3 |
| G11 | The local request archive is off by default | "The request archive (the Request archive switch on the Usage page, above the list of requests) is **off by default**." | S3 |

## 5. Gateway surface and protocols

| # | Claim | Quoted evidence | Source |
|---|---|---|---|
| P1 | One local gateway on 127.0.0.1:3425 | "The gateway listens on `127.0.0.1:3425`, or on the port in `port` of magpie's `settings.json` … **Read that file, never write it.**" | S4 |
| P2 | The four request paths | "`/v1/chat/completions` \| OpenAI Chat Completions … `/v1/responses` \| OpenAI Responses … `/v1/messages`, `/v1/messages/count_tokens` \| Anthropic Messages … `/v1beta/models/{model}:generateContent` (and `:streamGenerateContent`) \| Google Gemini" | S4 |
| P3 | Requests may pass through or be translated, images included | "Requests go straight through when the vendor speaks your API, and are translated otherwise, streaming, tool calls, images and reasoning included." | S4 |
| P4 | Translation happens per provider, in magpie | "An agent can send in any API. The gateway translates the request into the API the model speaks (chat completions, Responses, Anthropic Messages or Gemini), hands it to the plugin's `fetch`, and streams the answer back." | S1 |
| P5 | Model ids are `<provider>/<model>` (or a routing group's name) | "`GET /v1/models` lists what the user has turned on: `id` (`provider/model`, or a routing group's name, sent as it is)" | S4 |

**Ordering detail that decides the shape table:** P4 says translation happens for the provider;
H5 + H3 say the middleware sees the body "in the agent's own API" and `ctx.protocol` tells which.
So the gate never sees magpie's translated provider body — it sees exactly what the agent sent, on
one of four APIs. `onProvider` sees that same agent-API body, "each time with the body `onRequest`
left" (H3).

## 6. Content-part shapes the firewall must walk

The Magpie docs describe **none** of these field names. They only pin down the container
(`ctx.protocol`, four APIs, `messages`/`input`/`contents` implied by H5/H6). Therefore:

- every row below is **UNVERIFIED against Magpie** (docs silent), and
- the gate is written to be right under either spelling, matching by `type` **and** by the presence
  of a marker key, camelCase **and** snake_case.

| Protocol (`ctx.protocol`) | Containers the gate walks | Part markers it treats as unmaskable bytes | Evidence |
|---|---|---|---|
| `chat` | `body.messages[].content` (string or part array); tool messages' `content`; assistant `tool_calls[].function.arguments` (string, blob-scanned) | `type`: `image_url`, `input_audio`, `file`, `audio`, `video`; keys: `image_url`, `input_image`, `input_file` | UNVERIFIED (provider API schema, not in Magpie docs) |
| `responses` | `body.input` (string or item array); `item.content[]`; `function_call_output.output[]`; `body.instructions` (string, blob-scanned) | `type`: `input_image`, `input_file`; keys: `image_url`, `input_file`, `file_data` | UNVERIFIED (same reason) |
| `anthropic` | `body.messages[].content` (string or block array); `body.system` (string or block array); `tool_result.content[]` | `type`: `image`, `document`, `audio`, `video`; key: `source` on those blocks | UNVERIFIED (same reason) |
| `gemini` | `body.contents[].parts[]`; `body.systemInstruction.parts[]` | `inlineData` / `inline_data`, `fileData` / `file_data`; `type`: `image`, `file`, `document`, `audio`, `video` | UNVERIFIED (same reason) |

Conservative matching is deliberate: the same gate sees all four dialects, and a missed spelling is
a byte that leaves the machine. The false-positive surface is controlled instead, by (a) classifying
by `type` and by unambiguous keys only, (b) only treating the weak keys `image` / `file` /
`document` / `audio` / `video` as binary on elements of a `content`/`parts`/`input`/`output` array,
and (c) never walking `tools` / `functions` / `tool_choice` / `response_format` / `input_schema` /
`parameters` / `generationConfig`, where JSON Schema property names live.

## 7. Options and commands (for the README)

| # | Claim | Quoted evidence | Source |
|---|---|---|---|
| C1 | Options come from `ctx.options` = the entry's `options` in `plugins.json` | "A middleware reads its settings from `ctx.options`, which are its entry's `options` in `plugins.json`." | S1 |
| C2 | A package may suggest defaults, but nothing is saved until the user saves | "A package can suggest options with `"magpie": { "options": { … } }` in its `package.json`: the editor starts from those when none are set, but a middleware runs with no options until you save some." | S1 |
| C3 | How to set them | "Set them in Plugins → Installed with the middleware's Options button, which edits them as JSON in its row, or with `magpie plugin options <name> '<json>'` (`off` clears them). The name can be the package's, its spec, or its short name: `model-map` for `@magpie-community/middleware-model-map`. They apply from the next request on." | S1 |
| C4 | How to add a folder plugin | "`magpie plugin add ./opencode-acme-auth` # a folder is loaded where it is; nothing is installed" | S1 |
| C5 | Example add/options pair for middleware | "`magpie plugin add @magpie-community/middleware-model-map`" / "`magpie plugin options model-map '{"mapping": {"fast": "deepseek/deepseek-chat"}}'`" | S1 |
| C6 | Where per-middleware stats show up | "Settings → Plugins shows each middleware's hooks, how many calls it had, the average time each took and how many failed, with the last error." | S1 |
| C7 | `console.log` goes to magpie's log, capped | "`console.log` (into magpie's log, at most 60 lines a minute)" | S1 |

**UNVERIFIED (C3):** whether the short name for `@shypie/magpie-privacy-gate` is
`privacy-gate` or `magpie-privacy-gate`. The docs only give one example (prefix `middleware-`
stripped). The README shows the full package name as canonical and both shorter forms as
alternatives to try; `magpie plugin options <name> off` and `magpie plugin` (list) resolve it
locally without touching anything.

## 8. What the docs do **not** answer (open questions carried into the report)

1. **`onUsage` from a middleware-only file** — see H9 above. Exported, cannot be verified locally
   without running `magpie plugin add` against the live config, which is outside the scope of this note.
2. **Uploads are not middleware-visible.** A file sent through a provider's own Files/upload
   endpoint (or a pre-uploaded `file_id` / Gemini `fileUri` reference) is not a chat body, so no
   middleware hook sees the bytes. Whether magpie exposes such endpoints at all is UNVERIFIED; the
   gate only blocks the *part shapes* that reference them.
3. **Magpie's own image-description and web-search requests skip middleware** (O2). An agent's
   request that needs an image described does reach a provider for that description through a path
   this gate cannot see. This is an accepted residual risk, not a bug in the gate.
4. **Exact `row` error field** (H6 UNVERIFIED); handled defensively.
5. **goja regex throughput** on very large bodies is unknown; the gate therefore rejects any body
   with a deterministic `scanChars` character budget rather than a wall clock, so it cannot overrun the
250 ms hook timeout, which would fail **open** (R7).
