# Publish and marketplace listing

Everything needed to ship the four packages and to get the two plugins listed in the Magpie and
DeepSeek Harness markets. **Nothing here has been published yet** — this document is the checklist,
and [`marketplace/`](../marketplace) holds the two submission files ready to copy.

| Artifact | npm package | Directory | Marketplace |
|---|---|---|---|
| PII core | `@shypie_privacy/pii-core` | [`packages/pii-core`](../packages/pii-core) | library only |
| Local extractor | `@shypie_privacy/local-extract` | [`packages/local-extract`](../packages/local-extract) | library only |
| DSH bundle | `@shypie_privacy/dsh-privacy-gate` | [`plugins/dsh-privacy-gate`](../plugins/dsh-privacy-gate) | awesome-dsh-plugin → dsh-market |
| Magpie middleware | `@shypie_privacy/magpie-privacy-gate` | [`plugins/magpie-privacy-gate`](../plugins/magpie-privacy-gate) | magpie-community registry |

## 0. Prerequisites for the first publish

1. **Publish under the `@shypie_privacy` scope.** The npm org `shypie_privacy` exists and `siml1169`
   is its owner; a scoped package can only be published by a member of the matching org. If the
   scope ever has to change again, the four `name` fields, the `cordis.patch.yml` row and every
   `@shypie_privacy/` reference in the docs must move together — the patch row references the
   package **by name**.
2. **2FA.** npm refuses a publish from an account without 2FA unless the token has *bypass 2FA*;
   `siml1169` has `auth-and-writes` enabled, so every `npm publish` needs a one-time password —
   `--otp=<code>`, or answer npm's prompt.
3. **Check what would ship** before each first publish: `npm pack --dry-run` in the package
   directory. The `files` allowlists are already tight (no tests, no fixtures, no key material).
4. `publishConfig.access` is `public` in all four manifests, so no `--access public` flag is needed.

## 1. Publish the packages

The libraries first, so the marketplace entries can point at versions that already exist:

```bash
cd packages/pii-core        && npm publish --otp=<code>
cd ../local-extract         && npm publish --otp=<code>
cd ../../plugins/magpie-privacy-gate && npm publish --otp=<code>
cd ../dsh-privacy-gate      && npm publish --otp=<code>
```

A one-time password is valid for 30 seconds, so run one package per code — or drop `--otp` and let
npm prompt after each upload starts.

Verify each one:

```bash
npm view @shypie_privacy/pii-core version
npm view @shypie_privacy/magpie-privacy-gate magpie.middleware
npm view @shypie_privacy/dsh-privacy-gate dsh.bundle.patch
```

Then tag the repository (one tag for the coordinated 0.1.0 release):

```bash
git tag -a v0.1.0 -m "ShyPie 0.1.0" && git push origin v0.1.0
```

## 2. Magpie: gateway middleware

Install from npm once published (the plugin name is the package name):

```bash
magpie plugin add @shypie_privacy/magpie-privacy-gate
magpie plugin options privacy-gate '{ … }'   # same JSON as config/magpie-gate.options.json
magpie plugin                                 # listed, middleware only
```

### Listing

Two routes exist. This repository uses the **registry route**, because the GitHub-topic route
requires a `package.json` at the repository root and this is a monorepo.

1. **Registry (prepared).** Add [`marketplace/magpie/registry-entry.json`](../marketplace/magpie/registry-entry.json)
   as one entry in the `plugins` array of `registry.json` in
   [magpie-community/plugins](https://github.com/magpie-community/plugins) and open a pull request.
   `"kind": "middleware"` puts it under **Gateway middleware**; leaving out `"community": true`
   means the card shows the npm publisher instead of the community badge.
2. **GitHub topic (not used).** A repository tagged `magpie-plugin` appears under
   **Plugins → Discover → Unofficial, on GitHub**. That route reads `package.json` from the
   repository root; the middleware lives in `plugins/magpie-privacy-gate`, so only the registry
   route lists it correctly. The topic is still set, for GitHub search.

## 3. DeepSeek Harness: bundle

Install from npm once published:

```bash
dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate
```

`engines.dsh` is `>=0.2.0 <0.3.0` (verified against `0.2.1-rc.5`). Widen it only after testing the
host with the newer release; installation and profile startup refuse a bundle outside the range.

### Listing

The catalog is [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin);
the same data feeds `dsh-market` and the `Plugins → Discover` index sources.

1. Copy [`marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml`](../marketplace/dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml)
   to `data/plugins/` in that repository and open a pull request. One file per plugin; the READMEs
   there are generated and must not be edited by hand.
2. The `url`/`name` pair uses the documented monorepo form: the URL points at the subdirectory and
   the name is `owner/repo#subpackage`.
3. Requirements the submission is checked against:
   - the package declares `dsh.bundle` — yes, `plugins/dsh-privacy-gate/package.json`, together with
     its `cordis.patch.yml` next door;
   - the repository is at least **1 day old** — the entry can only be opened after that;
   - the repository carries the **`dsh-plugin`** topic — set on `siml1169/ShyPie`;
   - the description is accurate — it names exactly the four tools the bundle registers and the two
     guards, nothing more.

## 4. After the first publish

- [ ] `magpie plugin add @shypie_privacy/magpie-privacy-gate` loads, is listed, and shows hook counts after a
      request (Settings → Plugins).
- [ ] `dsh plugin --profile <name> add @shypie_privacy/dsh-privacy-gate` appends the bundle to
      `dsh.profile.bundles` and the patch row activates in a new session.
- [ ] Both listings render with the MIT license from [`LICENSE`](../LICENSE).
- [ ] Re-check the `files` allowlists after any layout change: `npm pack --dry-run`.

## 5. Version bumps

Bump the four `version` fields together while the packages are coupled by the interface contract in
[`docs/interface-contract.md`](interface-contract.md), commit, tag `v<version>`, then `npm publish` in
the same order as §1. The Magpie registry entry and the DSH catalog read the version from npm, so
neither file changes on a patch release.
