# Install and verify

Two plugins and one shared core. Nothing here installs itself: both products change profile-wide
state, so the install is explicit and reversible. The guide is Windows-first (the OCR engine, path
policy and examples assume Windows); the libraries themselves are portable.

Before you start, clone the repository somewhere stable and set a variable for it:

```powershell
$repo = "C:\path\to\ShyPie"
```

## 0. Prerequisites

| Need | Check |
|---|---|
| DeepSeek Harness with a configurable plugin profile | the Harness Web UI starts and a profile is active |
| Magpie with its local gateway | `http://127.0.0.1:3425/v1` answers; the DSH provider points at it |
| Poppler tools | `pdftotext -v`, `pdftoppm -v`, `pdfinfo -v` on `PATH` |
| Local OCR | Windows 11 includes `Windows.Media.Ocr` (used through `powershell.exe`); `tesseract` is optional |
| Node.js 22+ | `node --version`; the Node bundled with DSH also works |

The shared core (`packages/pii-core`) and the middleware require no dependencies. The extractor CLI
requires only Node and the local binaries above.

## 1. Magpie: structural egress firewall + text masking

```bash
# The middleware is merged in magpie-community/plugins but not on npm yet.
git clone https://github.com/magpie-community/plugins
magpie plugin add <clone>/packages/privacy-gate

# what may go to a remote model, and what counts as local
magpie plugin options privacy-gate '{"binaryPolicy":"fail","localModels":["ollama/*","lmstudio/*"],"localProviders":["ollama","lmstudio"],"allowModels":["deepseek/*","copilot/*","gemini/*"],"blobBase64Chars":400,"blobHexChars":400}'

# confirm it is listed and on
magpie plugin
```

The canonical option names, defaults and their meaning are in
[`packages/privacy-gate/README.md`](https://github.com/magpie-community/plugins/tree/main/packages/privacy-gate/README.md).
A copy of the example options lives in [`config/magpie-gate.options.json`](../config/magpie-gate.options.json).

The middleware is **merged in-tree** in magpie-community/plugins ([`packages/privacy-gate`](https://github.com/magpie-community/plugins/tree/main/packages/privacy-gate));
its package is `@magpie-community/middleware-privacy-gate`. The registry entry is merged, but the
npm package is not published yet, so use the checkout path above for now. The legacy
`@shypie_privacy/magpie-privacy-gate` package is no longer referenced and is retired. A folder is
loaded where it is, so neither form copies anything into the Magpie config directory
([docs/publish.md](publish.md)).

Then turn text masking on — **Settings → Privacy**, or `~/.config/magpie/settings.json`:

```json
{
  "redact": true,
  "redactPersonal": true,
  "redactKinds": { "home": true, "userhost": true },
  "redactModel": true,
  "redactModelName": "astrlink-guard"
}
```

`astrlink-guard` is a local model (≈39 MB download) that runs on this computer and is what lets
Magpie mask names and addresses in free text. Do not replace it with a hosted model — that would be
another clear-text hop.

Verify: **Settings → Privacy → Try it** with a fake IBAN, e-mail and address. The preview must show
`{{IBAN_…}}`-style placeholders. Then send one chat turn and open the shield badge on the request:
the masked kinds must include the ones you tried. See
[`usemagpie.ai/docs/masking`](https://usemagpie.ai/docs/masking) for the full switch list.

## 2. DSH: ingestion gate + local extraction tools

Install the bundle **through the plugin manager**, never by editing the profile by hand:

- ask the DSH agent to call `plugin_manager` with `action: "install_bundle"` and
  `target: "$repo/plugins/dsh-privacy-gate"` (absolute path), or
- install it from the Plugins page if the build exposes a folder install.

The current release is `0.3.0`, with filter mode, image/PDF attachment extraction and the composer
switch. Install it from npm with `dsh plugin --profile <name> add
@shypie_privacy/dsh-privacy-gate`, or from the checkout for an unreleased local build. The manifest
declares `engines.dsh` `>=0.2.0 <0.3.0`, so an older host refuses it instead of failing at load time.

Then set the bundle row's config (the `cordis.patch.yml` config layer). A minimal configuration:

```yaml
# Replace %USERPROFILE% with your home directory; keep the paths absolute.
allowPaths:
  - 'C:\Users\<you>\Documents\privacy-work\working-copies'
extractCli: 'C:\Users\<you>\.dsh\privacy\local-extract\cli.js'
audit: { enabled: true, path: 'C:\Users\<you>\.dsh\privacy\audit.jsonl' }
placeholderKey: { file: 'C:\Users\<you>\.dsh\privacy\placeholder.key' }
```

Notes:

- `allowPaths` is the **only** set of directories a document may be extracted or read from.
  `[]` means no document is readable (fail closed), so set it before using `privacy_extract`.
- `extractCli` should point at a stable copy of `packages/local-extract/cli.js` (copy that folder
  somewhere outside the checkout if the agent should not read the repository). Leave it empty to let
  the bundle resolve it: the sibling checkout first, then the installed
  `@shypie_privacy/local-extract` package (`0.2.1+`). If neither exists the tools fail with an error
  that names the setting.
- `placeholderKey` and `artifactDir` default to `%USERPROFILE%\.dsh\privacy\` — never put them in
  the repository. The key file is created with owner-only permissions.
- An image or PDF/Office file you attach is read locally (OCR for images, pdftotext/Office
  extraction for files) and replaced by text before it is logged (`imageParts: 'ocr'`,
  `fileParts: 'extract'`). The default `textPolicy: 'filter'` keeps that text raw in the local
  transcript; Magpie masks it outbound. Set `textPolicy: 'mask'` to redact locally, or
  `imageParts`/`fileParts: 'block'` to reject the step.
- Full option reference: [`plugins/dsh-privacy-gate/README.md`](../plugins/dsh-privacy-gate/README.md).

> **Start a new session after installing.** The gate redacts at append time and never rewrites
> existing events, so a session created before the gate was on (or forked from one) replays its old
> plaintext on every turn. Existing session logs are not retroactively scrubbed.

### Verify

In a **new** session:

1. Ask the agent to read a text-layer PDF through `privacy_extract` — the tool result must contain
   `{{IBAN_…}}`-style placeholders and none of the original digits.
2. Ask it to `read_image` a document outside `allowPaths` — the guard must deny it.
3. Ask it to extract a scanned PDF — the tool must return text (engine `winrt-ocr` on Windows) and
   the result must be redacted. With `PRIVACY_EXTRACT_DISABLE_OCR=1` set in the environment, the
   same call must return a blocked `NO_LOCAL_OCR` error instead.
4. Ask it to `privacy_rehydrate` a placeholder into a file, then read that file back — the read must
   come back as placeholders again.
5. Check `%USERPROFILE%\.dsh\privacy\audit.jsonl`: entries carry kind/length/count and a path hash,
   never a value.

## 3. Verify the gateway firewall

With the middleware on, a request that carries an image part to a model whose provider is not
declared local gets a **403** in the default `binaryPolicy: fail` mode, with a message saying the
part cannot be masked locally. In `binaryPolicy: guide` mode the image is withheld and the model is
asked to process it locally; no image bytes are sent. Magpie → **Settings → Plugins** shows the
middleware's hook counts and failures.

Guide mode is still a structural gate, not an extractor: it advertises local tools but cannot run
them. See [issue #795](https://github.com/magpie-community/plugins/issues/795) for the open
guide-MIME metadata issue.

If a legitimate request is rejected, extract the document locally and send the redacted text — do
not turn the gate off.

## 4. Uninstall

```bash
magpie plugin rm privacy-gate
```

and in DSH remove the bundle from the Plugins page or with `plugin_manager` `remove_bundle`.
Nothing else is changed: no profile file was edited by hand, and no Magpie config was replaced.
