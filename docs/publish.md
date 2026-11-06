# Publish and marketplace listing

Current state and repeatable checklist for the ShyPie packages and the two plugin markets.

## Current state (2026-11-06)

| Artifact | Distribution | Marketplace |
|---|---|---|
| PII core | source `0.3.0`; npm `0.1.0` still published | library only |
| Local extractor | source `0.3.0`; npm `0.1.0` still published | library only |
| DSH bundle | source `0.3.0` (filter mode, image/PDF extraction); npm `0.2.0` published | DSH catalog [PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308) **merged** |
| Legacy Magpie middleware | source `0.3.0`; npm `0.1.0` still published | retired in docs |
| Community Magpie middleware | upstream `0.1.0` at `28108dd`; `0.3.0` release branch in the ShyPie fork (`9f6f9ad`), not merged; npm not published | community registry [PR #685](https://github.com/magpie-community/plugins/pull/685) **merged** |

The legacy `@shypie_privacy/magpie-privacy-gate@0.1.0` package is no longer referenced and is being
retired. Its staged `0.1.1` (`a9792716-3890-46a2-ae6f-c92e0fcf3aae`) will be rejected as part of the
cleanup; the published version will be deprecated with a pointer to the community package.

Known open issue in the merged Magpie package:
[guide-mode MIME metadata validation #795](https://github.com/magpie-community/plugins/issues/795).

- Tag `v0.2.0` is the latest published tag; `v0.1.1` is the previous tag. A `v0.3.0` tag is not created until the coordinated publish.
- The DSH catalog entry was merged as [PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308).
- The Magpie registry entry was merged in [PR #685](https://github.com/magpie-community/plugins/pull/685)
  at `28108dd`.

## 1. ShyPie npm releases

All four ShyPie source packages are at `0.3.0`. npm still carries `pii-core`/`local-extract`/legacy
Magpie at `0.1.0` and DSH at `0.2.0`; the coordinated `0.3.0` publish is pending an authenticated
npm session. `npm pack --dry-run` in each directory checks the `files` allowlist. After publishing,
tag `v0.3.0` and update this page.

npm's staged publishing is the path used here:

```bash
# from each package directory
npm stage publish
npm stage list
npm stage approve <stage-id>       # 2FA prompt / web auth
```

`npm publish --otp=<code>` is the direct alternative. Publish in this order:

```text
packages/pii-core → packages/local-extract → plugins/dsh-privacy-gate
```

When publishing the source `0.3.0` packages, verify and tag:

```bash
npm view @shypie_privacy/dsh-privacy-gate version dsh.bundle.patch
git tag -a v0.3.0 -m "ShyPie 0.3.0" && git push origin v0.3.0
```

The current published release is `v0.2.0`; `v0.1.1` is the previous tag. `0.3.0` is source-only until
all four packages are staged, approved and tagged `v0.3.0`.

## 2. Magpie middleware (merged in-tree)

The middleware source is in
[`packages/privacy-gate`](https://github.com/magpie-community/plugins/tree/main/packages/privacy-gate)
in magpie-community/plugins, with `cases.json` and a `privacy-gate.test.mjs` using
`scripts/middleware.mjs`. The registry entry points at
`@magpie-community/middleware-privacy-gate` with `"community": true`.

The submission [PR #685](https://github.com/magpie-community/plugins/pull/685) is merged at
`28108dd`. The community npm publish is still pending; until it lands, install the merged package
from a checkout:

```bash
git clone https://github.com/magpie-community/plugins
magpie plugin add <clone>/packages/privacy-gate
magpie plugin options privacy-gate '{"binaryPolicy":"guide"}'
```

After the community package publishes:

```bash
magpie plugin add @magpie-community/middleware-privacy-gate
magpie plugin options privacy-gate '{ … }'   # same JSON as config/magpie-gate.options.json
magpie plugin
```

The merged middleware has **62 cases**; `binaryPolicy: fail` is the default and `guide` is the
withhold-and-prompt mode. Do not point users at the legacy ShyPie
`plugins/magpie-privacy-gate` copy now that the in-tree package exists.

### Retiring the legacy npm package

```bash
npm stage reject a9792716-3890-46a2-ae6f-c92e0fcf3aae
npm deprecate "@shypie_privacy/magpie-privacy-gate@*" \
  "Moved to @magpie-community/middleware-privacy-gate (magpie-community/plugins); this package is retired."
```

Both need an authenticated npm session with 2FA.

## 3. DeepSeek Harness: bundle and catalog

The catalog is [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin);
the same data feeds `dsh-market` and the `Plugins → Discover` index sources. The DSH entry was
merged as [PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308).

The submission source is
[`marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml`](../marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml).
The `url`/`name` pair uses the monorepo form: the URL points at the subdirectory and the name is
`owner/repo#subpackage`.

Install the current source features from the checkout:

```bash
dsh plugin --profile <name> add "$repo/plugins/dsh-privacy-gate"
```

Install the published npm release (`0.2.0`, without filter/PDF extraction):

```bash
dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate
```

`engines.dsh` is `>=0.2.0 <0.3.0` (verified against `0.2.1-rc.5`). Widen it only after testing.

## 4. Checklist

- [x] `pii-core`/`local-extract`/DSH previously published; source is now `0.3.0`.
- [x] DSH bundle installs into a profile and runs a live session.
- [x] Magpie middleware source, `cases.json` and test are in-tree.
- [x] Magpie registry PR merged ([PR #685](https://github.com/magpie-community/plugins/pull/685), `28108dd`).
- [x] Local Magpie checks: `bun test packages/privacy-gate` (62/62) and `bun scripts/check.mjs`.
- [ ] All four `@shypie_privacy` packages published at `0.3.0` (needs npm auth/2FA).
- [ ] Community Magpie package published to npm (not ShyPie-controlled).
- [ ] Known guide-MIME issue fixed ([#795](https://github.com/magpie-community/plugins/issues/795)).
- [x] DSH catalog entry merged ([PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308)).
- [ ] DSH source `0.3.0` (filter mode, image/PDF extraction) included in the coordinated publish and tagged.
- [x] `0.3.0` version bump applied to all ShyPie packages and the community release branch.
- [ ] Legacy `@shypie_privacy/magpie-privacy-gate` stage rejected and package deprecated.
- [x] GitHub release created from tag `v0.2.0`.
- [x] Previous release created from tag `v0.1.1`.

## 5. Version strategy

`0.1.0` was the first coordinated release; the DSH bundle shipped `0.2.0` separately with the egress
guard. The current `0.3.0` unifies all four ShyPie source packages (filter mode, image/PDF extraction,
composer switch, guide-mode-era gate) pending npm publication. The community middleware is
versioned separately by magpie-community/plugins; its upstream is `0.1.0`, while a `0.3.0` release
branch is prepared in the ShyPie fork but cannot be merged or published from ShyPie. The registries
read versions from npm, so submission files only change on a package rename.
