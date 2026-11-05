# Publish and marketplace listing

Current state and repeatable checklist for the ShyPie packages and the two plugin markets.

## Current state (2026-11-05)

| Artifact | Distribution | Marketplace |
|---|---|---|
| PII core | `@shypie_privacy/pii-core@0.1.0` — published | library only |
| Local extractor | `@shypie_privacy/local-extract@0.1.0` — published | library only |
| DSH bundle | `@shypie_privacy/dsh-privacy-gate@0.2.0` — published | awesome-dsh-plugin → dsh-market: entry ready to submit |
| Magpie middleware | `@magpie-community/middleware-privacy-gate` — **in-tree** in magpie-community/plugins, first publish after merge | magpie-community registry: [PR #685](https://github.com/magpie-community/plugins/pull/685) open |

The legacy `@shypie_privacy/magpie-privacy-gate@0.1.0` package is no longer referenced and is being
retired. Its staged `0.1.1` (`a9792716-3890-46a2-ae6f-c92e0fcf3aae`) will be rejected as part of the
cleanup; the published version will be deprecated with a pointer to the community package.

- Tag `v0.1.1` is pushed; there is no GitHub release yet.
- The DSH catalog entry can be submitted now (the repository is more than one day old).

## 1. ShyPie npm releases

The three remaining ShyPie packages keep the coordinated `0.1.0` release. `npm pack --dry-run` in
each directory checks the `files` allowlist.

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

Verify and tag:

```bash
npm view @shypie_privacy/pii-core version
npm view @shypie_privacy/local-extract version
npm view @shypie_privacy/dsh-privacy-gate version dsh.bundle.patch
git tag -a v<version> -m "ShyPie <version>" && git push origin v<version>
```

The current tag is `v0.1.1`. A tag is not a GitHub release; create the release from the tag when the
release notes are ready.

## 2. Magpie middleware (in-tree)

The middleware source is now in
[`packages/privacy-gate`](https://github.com/magpie-community/plugins/tree/main/packages/privacy-gate)
in magpie-community/plugins, with `cases.json` and a `privacy-gate.test.mjs` using
`scripts/middleware.mjs`. The registry entry points at
`@magpie-community/middleware-privacy-gate` with `"community": true`.

The submission is [PR #685](https://github.com/magpie-community/plugins/pull/685). After it merges,
the community workflow publishes the package (dist branch first, then npm) — no ShyPie publish step
is involved.

Until the community package publishes, install from the checkout:

```bash
magpie plugin add "$repo/plugins/magpie-privacy-gate"
```

Afterwards:

```bash
magpie plugin add @magpie-community/middleware-privacy-gate
magpie plugin options privacy-gate '{ … }'   # same JSON as config/magpie-gate.options.json
magpie plugin
```

### Retiring the legacy npm package

```bash
npm stage reject a9792716-3890-46a2-ae6f-c92e0fcf3aae
npm deprecate "@shypie_privacy/magpie-privacy-gate@*" \
  "Moved to @magpie-community/middleware-privacy-gate (magpie-community/plugins); this package is retired."
```

Both need an authenticated npm session with 2FA.

## 3. DeepSeek Harness: bundle

The catalog is [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin);
the same data feeds `dsh-market` and the `Plugins → Discover` index sources.

Copy [`marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml`](../marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml)
to `data/plugins/` and open a pull request. The `url`/`name` pair uses the monorepo form: the URL
points at the subdirectory and the name is `owner/repo#subpackage`. Checks:

- the package declares `dsh.bundle` — yes, with `cordis.patch.yml` next door;
- the repository is at least **1 day old**;
- the repository carries the **`dsh-plugin`** topic;
- the description names exactly the four tools and two guards, nothing more.

Install from npm:

```bash
dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate
```

`engines.dsh` is `>=0.2.0 <0.3.0` (verified against `0.2.1-rc.5`). Widen it only after testing.

## 4. Checklist

- [x] `pii-core` and `local-extract` published at `0.1.0`; DSH bundle at `0.2.0`.
- [x] DSH bundle installs into a profile and runs a live session.
- [x] Magpie middleware source, `cases.json` and test are in-tree (PR #685).
- [x] Local checks: `bun test packages/privacy-gate` (43/43) and `bun scripts/check.mjs`.
- [ ] Magpie registry PR merged and community package published.
- [ ] DSH catalog entry submitted and merged.
- [ ] Legacy `@shypie_privacy/magpie-privacy-gate` stage rejected and package deprecated.
- [x] DSH bundle `0.2.0` (egress guard) published.
- [ ] GitHub release created from tag `v0.1.1`.

## 5. Version strategy

`0.1.0` was the coordinated ShyPie release. The Magpie middleware is now versioned by
magpie-community/plugins; its in-tree first release carries the vendor-signature and rejection fixes.
The ShyPie packages (`pii-core`, `local-extract`, DSH bundle) realign at the next coordinated release.
The registries read versions from npm, so the submission files only change on a package rename.
