# Marketplace submissions

Ready-to-copy files for the two plugin markets. Prerequisites, publish order and verification:
[docs/publish.md](../docs/publish.md).

| File | Destination |
|---|---|
| [`magpie/registry-entry.json`](magpie/registry-entry.json) | one entry in the `plugins` array of `registry.json` in [magpie-community/plugins](https://github.com/magpie-community/plugins) |
| [`dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml`](dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml) | `data/plugins/` in [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) |

The Magpie middleware is now **in-tree** in magpie-community/plugins and its registry entry is
[PR #685](https://github.com/magpie-community/plugins/pull/685); the legacy
`@shypie_privacy/magpie-privacy-gate` npm package is no longer referenced and is being retired. The DSH bundle is published and its
catalog entry is ready to submit.
