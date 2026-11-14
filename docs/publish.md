# Publish and marketplace listing

Current state and repeatable checklist for the ShyPie packages and the two plugin markets.

## Current state (2026-11-10)

| Artifact | Distribution | Marketplace |
|---|---|---|
| PII core | `@shypie_privacy/pii-core@0.3.0` — published | library only |
| Local extractor | `@shypie_privacy/local-extract@0.3.0` — published | library only |
| DSH bundle | `@shypie_privacy/dsh-privacy-gate@0.3.0` — published | DSH catalog [PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308) **merged** |
| Legacy Magpie middleware | npm `@shypie_privacy/magpie-privacy-gate@0.4.0` — published; canonical community package still in review | ShyPie mirror published; canonical remains community-controlled |
| Community Magpie middleware | upstream **`0.4.0`** in review ([PR #1111](https://github.com/magpie-community/plugins/pull/1111)); npm not published | community registry [PR #685](https://github.com/magpie-community/plugins/pull/685) **merged** |

The legacy `@shypie_privacy/magpie-privacy-gate@0.1.0` package is no longer referenced and is being
retired. Its staged `0.1.1` (`a9792716-3890-46a2-ae6f-c92e0fcf3aae`) will be rejected as part of the
cleanup; the published version will be deprecated with a pointer to the community package.

The former open issue in the merged Magpie package,
[guide-mode MIME metadata validation #795](https://github.com/magpie-community/plugins/issues/795), is
**closed**: `0.3.1` replaced `guideMime` with `guideMediaClass`, so the guide prompt names a coarse
media class instead of echoing an untrusted `media_type`.

- Tag `v0.3.0` is pushed; `v0.2.0` is the previous tag. The GitHub release is created from the tag.
- The DSH catalog entry was merged as [PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308).
- The Magpie registry entry was merged in [PR #685](https://github.com/magpie-community/plugins/pull/685)
  at `28108dd`; the in-tree package has since been released at `0.3.0` ([PR #798](https://github.com/magpie-community/plugins/pull/798))
  `0.3.1` ([PR #838](https://github.com/magpie-community/plugins/pull/838), `d34785a`), and `0.4.0`
([PR #1111](https://github.com/magpie-community/plugins/pull/1111), in review).

## 1. ShyPie npm releases

`pii-core`, `local-extract` and the DSH bundle are published at `0.3.0`; the ShyPie-scoped Magpie
mirror is published at `0.4.0`. `npm pack --dry-run` in each directory checks the `files` allowlist.
The coordinated `0.3.0` release is tagged `v0.3.0`.

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

The current release is `v0.3.0`; `v0.2.0` is the previous tag.

## 2. Magpie middleware (merged in-tree)

The middleware source is in
[`packages/privacy-gate`](https://github.com/magpie-community/plugins/tree/main/packages/privacy-gate)
in magpie-community/plugins, with `cases.json` and a `privacy-gate.test.mjs` using
`scripts/middleware.mjs`. The registry entry points at
`@magpie-community/middleware-privacy-gate` with `"community": true`.

The submission [PR #685](https://github.com/magpie-community/plugins/pull/685) is merged at
`28108dd`, and the package has since been released in-tree at **`0.3.1`** (`d34785a`): `0.3.0`
([PR #798](https://github.com/magpie-community/plugins/pull/798)) added the branded bilingual docs,
`0.3.1` ([PR #838](https://github.com/magpie-community/plugins/pull/838)) replaced `guideMime` with
`guideMediaClass`. The community npm publish is still pending; until it lands, install the merged
package from a checkout:

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

The middleware has **72 canonical cases + 4 page/policy checks (76)** at `0.4.0`; `binaryPolicy: fail` is the default and `guide`
is the withhold-and-prompt mode. The ShyPie-scoped `@shypie_privacy/magpie-privacy-gate@0.4.0` is published and now mirrors the
0.4.0 source, but the canonical explanation and issue tracker remain the community package.

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

Install the published npm release (`0.3.0`, including filter/PDF extraction):

```bash
dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate
```

`engines.dsh` is `>=0.2.0 <0.3.0` (verified against `0.2.1-rc.5`). Widen it only after testing.

## 4. Checklist

- [x] `pii-core`, `local-extract`, DSH and legacy Magpie published at `0.3.0`.
- [x] ShyPie-scoped Magpie mirror published at `0.4.0`.
- [x] DSH bundle installs into a profile and runs a live session.
- [x] Magpie middleware source, `cases.json` and test are in-tree.
- [x] Magpie registry PR merged ([PR #685](https://github.com/magpie-community/plugins/pull/685), `28108dd`).
- [x] Magpie package released in-tree at `0.3.1` (`d34785a`, PRs #798 and #838).
- [ ] Magpie `0.4.0` per-agent controls merged (PR #1111).
- [x] ShyPie mirror synchronized to `0.4.0` source.
- [x] Local Magpie checks: `bun test packages/privacy-gate` (76/76) and `bun scripts/check.mjs`; mirror `npm test` (72/72).
- [x] All four `@shypie_privacy` packages published: three at `0.3.0`, Magpie mirror at `0.4.0`.
- [ ] Community Magpie package published to npm (not ShyPie-controlled).
- [x] Guide-MIME issue fixed and closed ([#795](https://github.com/magpie-community/plugins/issues/795), by `0.3.1`).
- [x] DSH catalog entry merged ([PR #12308](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12308)).
- [x] DSH source `0.3.0` (filter mode, image/PDF extraction) published and tagged.
- [x] `0.3.0` version bump applied to all ShyPie packages; the in-tree Magpie package has since
      reached `0.3.1` upstream.
- [ ] Legacy `@shypie_privacy/magpie-privacy-gate` old `0.1.1` stage rejected and `0.3.0` deprecated.
- [x] Tag `v0.3.0` created and pushed.
- [ ] GitHub release created from tag `v0.3.0`.
- [x] Previous release created from tag `v0.2.0`.

## 5. Version strategy

`0.1.0` was the first coordinated release; the DSH bundle shipped `0.2.0` separately with the egress
guard. `0.3.0` unified the original ShyPie packages; the ShyPie-scoped Magpie mirror has since moved
to `0.4.0` for per-agent controls. The community middleware is versioned separately by
magpie-community/plugins and has its own line: `0.1.0` (initial merge), `0.3.0` (branded bilingual
docs), `0.3.1` (coarse guide media class). Those versions are released in-tree only; publishing them
to npm is the community's call, not ShyPie's. The registries read versions from npm, so submission
files only change on a package rename.
