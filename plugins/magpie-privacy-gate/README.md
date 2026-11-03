# magpie-privacy-gate — structural egress firewall for magpie's gateway

A magpie **gateway middleware** plugin. It closes the one gap magpie's own masking says it cannot
close:

> **Images and file data are sent as they are.** Text inside a screenshot is not masked.
> — <https://usemagpie.ai/docs/masking#limits>

magpie's built-in Privacy masking (`redact`) is the text half of a privacy-first setup: it masks
secrets, emails, card/ID numbers and the names a local model finds, fails closed with a 503, and
never sends unmasked text. This plugin is the **structure** half, and it runs one hook earlier:

| The gate owns | magpie's masking owns |
|---|---|
| content parts that are bytes, not text (`image_url`, `input_image`, `image`, `file`, `input_file`, `document`, `audio`, `video`, `inlineData`, `fileData`, …) | every text value: secrets, personal data, masked words, found names |
| encoded payloads smuggled through a *text* field (base64 / base64url / hex / `data:` URI / `%PDF-` / ZIP magic) | placeholders and their restore path, the 503 when masking cannot run |
| the model allowlist, and failing closed on anything it cannot inspect | the Settings → Privacy switches and the per-kind **Block** action |

It **never** rejects plaintext PII in `onRequest`: that hook runs *before* magpie's redaction
("before magpie's redaction on the way out and after it on the way back",
<https://usemagpie.ai/docs/plugins#middleware>), so rejecting there would double-guess the masker.

---

## Install

Run inside `privacy-first-workflow/` (or use `./privacy-first-workflow/plugins/magpie-privacy-gate`
from the repository root). A folder plugin is **loaded where it is; nothing is installed and nothing
leaves the machine** (<https://usemagpie.ai/docs/plugins>).

```sh
magpie plugin add ./plugins/magpie-privacy-gate
magpie plugin                                    # the plugin is listed; it is middleware only (no Bun host)
```

Also make sure the built-in **Gateway middleware** plugin is on: Settings → Plugins → Built-in →
Gateway middleware. With it off, "no middleware runs and agents' requests go as they came"
(<https://raw.githubusercontent.com/yetone/magpie/main/docs/reference.md>).

The plugin declares no options itself; a middleware "runs with no options until you save some"
(<https://usemagpie.ai/docs/plugins#middleware-options>), so with no options saved this gate is at
its strictest: **every** binary/document part is rejected, on **every** model.

## Configure

Set the options as one JSON object (Settings → Plugins → Installed → the plugin's **Options**, or
the CLI; "they apply from the next request on"):

```sh
magpie plugin options magpie-privacy-gate '{
  "allowModels": [],
  "localModels": ["ollama/*", "lmstudio/*", "localhost/*"],
  "localProviders": ["ollama", "lmstudio"],
  "allowUnknownProtocol": false,
  "blobBase64Chars": 400,
  "blobHexChars": 400,
  "scanChars": 200000,
  "maxNodes": 200000,
  "maxDepth": 40,
  "logMaxLines": 40,
  "logEveryRows": 50
}'
magpie plugin options magpie-privacy-gate off     # clears them again
```

The name can be the package's, its spec, or its short name
(<https://usemagpie.ai/docs/plugins#middleware-options>). The package name is
`@privacy/magpie-privacy-gate`; if `magpie-plugin` reports an unknown name, run `magpie plugin` and
use the short name it prints (`magpie-privacy-gate`, or `privacy-gate` on magpie versions that strip
the `magpie-` prefix — that spelling is **UNVERIFIED**, see [the hooks evidence](../../docs/research/magpie-hooks.md) §7).

| Option | Default | Meaning |
|---|---|---|
| `allowModels` | `[]` | Globs against the model id as the agent asked (`<provider>/<model>` or a routing group's name, <https://usemagpie.ai/docs/integrate#gateway>). `[]` = every model passes this rule. Anything else gets a 403 naming the model and the policy. |
| `localModels` | `[]` | Globs of models that may receive binary/document parts because the endpoint is local (Ollama, LM Studio). This must mirror the providers where you turned **Send requests unmasked** on — a provider that skips masking and is not in `localModels` is exactly the case this gate exists for. `[]` = no model may receive bytes. |
| `allowUnknownProtocol` | `false` | `ctx.protocol` is one of `chat`, `responses`, `anthropic`, `gemini`. Anything else cannot be classified and is rejected. Only turn this on if you have taught yourself what the body looks like. |
| `localProviders` | `[]` | Globs of *provider* ids that may receive binary parts. Checked in `onProvider`, where the provider is known: a local-sounding model id alone is not enough (`[]` = no provider may receive bytes). |
| `blobBase64Chars` / `blobHexChars` | `400` / `400` | Longest tolerated encoded run inside a text value (contiguous, line-wrapped, or spaced hex). A one-page invoice is ~1.3 k base64 chars, so 400 is deliberate. |
| `scanChars` / `maxNodes` / `maxDepth` | `200000` / `200000` / `40` | Deterministic text-inspection budget per request (edges of long fields). Long bodies are not rejected; over budget the gate logs degraded. `maxNodes`/`maxDepth` overflow is still a rejection. |
| `logMaxLines` | `40` | Self-cap on `console.log`. magpie's own cap is 60 lines a minute (<https://usemagpie.ai/docs/plugins#middleware>). |
| `logEveryRows` | `50` | One usage line every N usage rows. |

## Turn on full masking in Settings → Privacy (the text half)

Settings → Privacy (<https://usemagpie.ai/docs/masking>):

1. **Mask secrets** → On.
2. **Mask personal data** → On. Then turn on the kinds that are off by default and matter here
   (page: *"the user name in home folders…, user and computer names (`user@host`), public IP
   addresses… and cloud storage buckets"*).
3. **Masked words** → your names, hosts, project names. **Masking rules** → your gateway keys and
   any secret shape magpie doesn't know.
4. **Find with a local model** → On, **AstrLink Guard** (local, ~39 MB; it is what finds names and
   addresses in free text).
5. **When a value is found** → choose **Block** for the kinds that must never be sent instead of
   masked. That is the text-level "block the transfer" lever; this plugin's 403 is the structural
   one.
6. **Count me as a user** → Off (and *Share the agents, providers and models I use* → Off) if you
   want magpie's own daily count gone too: `"noStats": true`, <https://usemagpie.ai/docs/privacy>.
7. Leave **Send requests unmasked on a provider** on **only** for models that are genuinely local
   (Ollama, LM Studio), and list those models in `localModels` above.

Without the window (`magpie serve`), use `magpie web`, or edit `~/.config/magpie/settings.json`
(<https://usemagpie.ai/docs/masking#on>). Only `redact`, `redactPersonal`, `redactWords` are
documented keys; this machine additionally has `redactModel: true`,
`redactModelName: "astrlink-guard"`, `redactKinds: { home, userhost }` (see the interface reference, line 82) — the UI writes those, so prefer it:

```json
{
  "redact": true,
  "redactPersonal": true,
  "redactWords": ["YourName", "your-internal-host"],
  "noStats": true
}
```

## Verify

```sh
# 1. the gate itself, no magpie needed, no network
node test/harness.mjs                      # 44 checks: all four protocols, localModels, blobs, limits

# 2. magpie sees the plugin and its hooks
magpie plugin
# Settings → Plugins → the row shows the hooks, how many calls, average time, failures
# (https://usemagpie.ai/docs/plugins#middleware)

# 3. a blocked request: expect HTTP 403 and a message starting with "privacy-gate:".
#    Replace MODEL with any NON-local id from `curl -s http://127.0.0.1:3425/v1/models`.
curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:3425/v1/chat/completions \
  -H 'Authorization: Bearer magpie-privacy-gate-selftest' \
  -H 'Content-Type: application/json' \
  -d '{"model":"MODEL","messages":[{"role":"user","content":[
        {"type":"text","text":"self test"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}'
# -> privacy-gate: a content part of type "image_url" cannot be masked locally; …
#    HTTP 403, and nothing was sent upstream (routing never happened).

# 4. the same request with a model in `localModels` is accepted (it is local by definition).

# 5. the log line (magpie's own log; paths from https://usemagpie.ai/docs/privacy#files)
#    Windows:  Select-String -Path "$env:LOCALAPPDATA\magpie\logs\app.log" -Pattern "privacy-gate:"
#    macOS:    grep privacy-gate ~/Library/Logs/magpie/app.log
#    Linux:    grep privacy-gate ~/.local/state/magpie/app.log
```

**Settings → Privacy → Try it** is the documented check for the *other* half: paste a made-up
sentence containing an email, a card-shaped number and one of your masked words; the panel shows
exactly what the vendor would get, with each value's kind (<https://usemagpie.ai/docs/masking#check>).
Try it exercises text masking only — it cannot show this gate, which is why step 3 above exists.
After the first real request, **Insights → Masking** shows each request with what was masked.

## What happens when the gate blocks

A 403 is the intended outcome, not a bug. The bytes never reach the provider. Convert the document
locally and send text instead: in this workflow the DSH side provides `privacy_extract` /
`privacy_ocr` (local `pdftotext`/OCR, redacted before it enters the conversation), so the fix is
"extract locally → send the redacted text", never "turn the gate off". A long conversation is not
rejected for size: the text scan has a deterministic character budget (`scanChars`) and the
structural part checks always run. Do not chase a timeout instead — a hook that runs out of time does
**not** block the request, magpie sends it as it was (<https://usemagpie.ai/docs/plugins#middleware>).

## Files

| File | What |
|---|---|
| `gate.middleware.js` | the whole gate — one file, standard JavaScript only, no imports, no network, no timers, no Node APIs (moejs constraint). ES5 style on purpose. |
| `package.json` | `"magpie": { "middleware": "./gate.middleware.js" }`; no `main`/`exports`, so it is middleware only and no Bun host starts. |
| `test/harness.mjs` | loads the file in `node:vm` with only `console` available (proves moejs compatibility), feeds all four protocol shapes, asserts every allow/reject decision, and asserts the source contains no `fetch(`, `require(`, timer, `process.`, `Buffer` or import statement. |

## Limits and open risks

- Text is magpie's job. This plugin does not mask, restore or inspect PII, so turning masking off
  leaves text unprotected even with this plugin on.
- Pre-uploaded files are outside every middleware: a provider's Files API / `file_id` / Gemini
  `fileUri` was uploaded by an earlier request that is not a chat body. The gate blocks the *parts*
  that reference them, not the upload.
- magpie's own side requests (thread titles, classifier, web searches, **image descriptions**) skip
  middleware (<https://usemagpie.ai/docs/plugins#middleware>). An agent that needs an image described
  still has that path; keep `localModels` accurate and masking on.
- An `onProvider` failure cannot reject (`onProvider` may only rewrite), so there the gate blanks the
  content containers and sends a text-only request instead of the bytes.
- `onUsage` from a middleware-only file is not documented; see [the hooks evidence](../../docs/research/magpie-hooks.md) §2 and §8.
