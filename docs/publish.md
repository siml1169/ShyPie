# Publish and marketplace listing

Everything needed to ship the four packages and to get the two plugins listed in the Magpie and
DeepSeek Harness markets. This file is the current state and the repeatable checklist.

## Current state (2026-11-03)

| Artifact | npm | Marketplace |
|---|---|---|
| PII core | `@shypie_privacy/pii-core@0.1.0` — published | library only |
| Local extractor | `@shypie_privacy/local-extract@0.1.0` — published | library only |
| DSH bundle | `@shypie_privacy/dsh-privacy-gate@0.1.0` — published | awesome-dsh-plugin → dsh-market: entry ready, not submitted |
| Magpie middleware | `@shypie_privacy/magpie-privacy-gate@0.1.0` — published; `0.1.1` staged | magpie-community registry: [PR #685](https://github.com/magpie-community/plugins/pull/685) open |

- Tag `v0.1.1` is pushed; there is no GitHub release yet.
- `0.1.1` is staged on npm under id `a9792716-3890-46a2-ae6f-c92e0fcf3aae` (the vendor-signature,
  options and `ctx.reject` fixes). `npm view @shypie_privacy/magpie-privacy-gate version` still shows
  `0.1.0` until the stage is approved with 2FA.
- The DSH catalog submission can be opened after **2026-11-04 08:20 UTC** (repository created
  2026-11-03 08:20 UTC; the catalog requires one day).

## 1. Publishing a version

The scope, `publishConfig.access: public`, and MIT metadata are already set in all four manifests.
`npm pack --dry-run` in each directory is the check that the `files` allowlist still ships only the
intended files.

npm's staged publishing is the path used here (it defers 2FA to the approval step):

```bash
# from each package directory, in this order
npm stage publish
npm stage list                     # read the stage id
npm stage approve <stage-id>       # 2FA prompt / web auth
```

`npm publish --otp=<code>` is the direct alternative. Approve or publish in this order so the
marketplace packages resolve to versions that already exist:

```text
packages/pii-core → packages/local-extract → plugins/magpie-privacy-gate → plugins/dsh-privacy-gate
```

Verify the registry metadata after approval:

```bash
npm view @shypie_privacy/pii-core version
npm view @shypie_privacy/local-extract version
npm view @shypie_privacy/magpie-privacy-gate version magpie.middleware
npm view @shypie_privacy/dsh-privacy-gate version dsh.bundle.patch
```

Then tag the release and push the tag:

```bash
git tag -a v<version> -m "ShyPie <version>" && git push origin v<version>
```

The current tag is `v0.1.1`. A tag is not a GitHub release; create the release from the tag when the
release notes are ready.

## 2. Magpie: gateway middleware

The registry entry is [`marketplace/magpie/registry-entry.json`](../marketplace/magpie/registry-entry.json).
It has been submitted as [PR #685](https://github.com/magpie-community/plugins/pull/685); the PR branch
has the scope clarified for DeepSeek Harness + DeepSeek models, the bounded-scan caveat, and the
vendor-signature exemption.

The registry route is used because the GitHub-topic route requires a `package.json` at the repository
root and this is a monorepo. `"kind": "middleware"` puts it under **Gateway middleware**; leaving out
`"community": true` means the card shows the npm publisher instead of the community badge.

After the listing merges:

```bash
magpie plugin add @shypie_privacy/magpie-privacy-gate
magpie plugin options privacy-gate '{ … }'   # same JSON as config/magpie-gate.options.json
magpie plugin                                 # listed, middleware only
```

## 3. DeepSeek Harness: bundle

The catalog is [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin);
the same data feeds `dsh-market` and the `Plugins → Discover` index sources.

The entry is [`marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml`](../marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml).
The submission can be opened after the repository is one day old (see above). Copy the file to
`data/plugins/` in that repository and open a pull request; the READMEs there are generated and must
not be edited by hand.

The `url`/`name` pair uses the documented monorepo form: the URL points at the subdirectory and the
name is `owner/repo#subpackage`. The checks the submission must pass:

- the package declares `dsh.bundle` — yes, `plugins/dsh-privacy-gate/package.json`, together with its
  `cordis.patch.yml` next door;
- the repository is at least **1 day old**;
- the repository carries the **`dsh-plugin`** topic — set on `siml1169/ShyPie`;
- the description is accurate — it names exactly the four tools the bundle registers and the two
  guards, nothing more.

Install from npm once the entry exists:

```bash
dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate
```

`engines.dsh` is `>=0.2.0 <0.3.0` (verified against `0.2.1-rc.5`). Widen it only after testing the host
with the newer release; installation and profile startup refuse a bundle outside the range.

## 4. After publishing

- [x] `magpie plugin add @shypie_privacy/magpie-privacy-gate` loads and lists
      `gateway middleware · onRequest, onProvider · onUsage` (verified 2026-11-03, npm 0.1.0; the
      `0.1.1` code was loaded from the folder and tested live before approval).
- [x] `dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate` installs the bundle and adds
      it to `dsh.profile.bundles` (verified 2026-11-03 in the `headless` and `desktop` profiles; a
      two-turn DeepSeek session ran through the live Magpie gateway).
- [x] The MIT license is in all four npm packuments.
- [x] The `files` allowlists were re-checked with `npm pack --dry-run` before publishing.
- [x] The Magpie registry PR is open (#685).
- [ ] The Magpie registry listing is merged.
- [ ] The DSH catalog entry is submitted (after 2026-11-04 08:20 UTC) and merged.

## 5. Version strategy

`0.1.0` was the coordinated release of all four packages. `0.1.1` is a Magpie-only hotfix: the DSH
bundle, `pii-core` and `local-extract` are unchanged, so they stay at `0.1.0` while the middleware
carries the vendor-signature, option and `ctx.reject` fixes. The next coordinated release realigns all
four version fields, the interface contract in
[`docs/interface-contract.md`](interface-contract.md), and the tag. The Magpie registry entry and the
DSH catalog read the version from npm, so neither submission file changes on a patch release.
