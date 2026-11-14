# ShyPie Magpie middleware

`@shypie_privacy/magpie-privacy-gate@0.4.0` is the ShyPie mirror of the
Magpie-side gate. The canonical copy is
[`magpie-community/plugins/packages/privacy-gate`](https://github.com/magpie-community/plugins/tree/main/packages/privacy-gate).
This source is kept in the ShyPie repository so the whole workflow can be
reviewed and tested together; the community copy is what Magpie installs.

The middleware runs in Magpie's gateway before routing. It does **not** mask
text — that remains Magpie Privacy's job. It owns structure:

- binary content parts Magpie cannot mask (`image`, `file`, `audio`, `video`)
- encoded blobs smuggled through text fields
- model/provider allowlists
- bodies or protocols it cannot inspect
- per-agent bypass policy

The optional **ShyPie Filter** page, the **ShyPie protection** panel on
Magpie's Agents page, and the agent-row action are included.

## Install

From this repository:

```sh
magpie plugin add <repo>/plugins/magpie-privacy-gate
```

The canonical community package, once published, is:

```sh
magpie plugin add @magpie-community/middleware-privacy-gate
```

The legacy `@shypie_privacy/magpie-privacy-gate` npm package is still at
`0.3.0` and is no longer referenced by the canonical docs. This source tree is
at `0.4.0` so the new per-agent controls can be reviewed and tested; it has not
been published to npm as `0.4.0`.

## Per-agent controls

Magpie supplies `ctx.agent` to the gateway. The page and panel store:

```json
{
  "disabledAgents": [],
  "protectUnknownAgent": true
}
```

- Every agent, including new and plugin-added agents, is protected by default.
- Only explicit `disabledAgents` entries bypass the gate.
- `disabledAgents` supports globs; the middleware's matching is
  case-sensitive.
- An empty `ctx.agent` stays protected unless `protectUnknownAgent` is false.
- A disabled agent bypasses both `onRequest` and `onProvider`.

The page shows a **Policy patterns** section for raw/glob entries it cannot
represent as a switch and preserves them on save. Exact custom ids already in
`disabledAgents` are seeded into the catalogue.

The graphical surfaces are:

1. **ShyPie Filter** page in Magpie's Plugins sidebar.
2. **ShyPie protection** card at the bottom of Magpie's Agents page.
3. **ShyPie protection** in each agent's row menu; it opens the page focused on
   that agent.

The page uses only the released bridge (`magpie.options.get/set`,
`magpie.ready`, `magpie.theme`, `magpie.onAction`), declares no permissions, and
makes no network calls. Saving re-reads current options and changes only the
agent fields; a concurrent change to those fields is reported instead of
overwritten.

## Options

| Option | Default | Meaning |
|---|---:|---|
| `binaryPolicy` | `fail` | `fail` returns 403 for binary parts; `guide` withholds bytes and injects local-tool metadata. |
| `allowModels` | `[]` | Model globs. `[]` allows every model; a malformed value refuses every request. |
| `localModels` | `[]` | Model globs that may receive binary parts. |
| `localProviders` | `[]` | Provider-id globs checked in `onProvider`; both local lists must agree. |
| `disabledAgents` | `[]` | Agent ids or globs that bypass the gate completely. |
| `protectUnknownAgent` | `true` | Whether a request with no classified agent stays gated. |
| `extraAgents` | `[]` | Page-only custom catalogue; the middleware ignores it. |
| `guideTools` | `[]` | Tool names included in the guide prompt. |
| `blobBase64Chars` / `blobHexChars` | `400` | Encoded run at or above this is a blob. |
| `scanChars` | `200000` | Text-inspection budget. |
| `maxNodes` / `maxDepth` | `40000` / `40` | Structural bounds; overflow blocks. |
| `allowUnknownProtocol` | `false` | Reject protocols outside chat/responses/anthropic/gemini. |
| `logMaxLines` / `logEveryRows` | `40` / `50` | Log/usage counters. |

Set options with:

```sh
magpie plugin options privacy-gate '{ "disabledAgents": [] }'
```

## Tests

```sh
npm test
```

The runner executes the canonical `cases.json` under a bare moejs-style context:
72 middleware cases, including per-agent bypass and guide-mode media-class cases.

The canonical package additionally has four page/policy checks:
`bun test packages/privacy-gate` reports 76 passing there.

## Relationship to the two plugins

- **DSH bundle:** `@shypie_privacy/dsh-privacy-gate` filters what enters the DSH
  session log and extracts attachments locally.
- **Magpie middleware:** this package filters what exits through Magpie for
  agents that do not run the DSH bundle.

See the root [README](../../README.md) and [design](../../docs/design.md).
