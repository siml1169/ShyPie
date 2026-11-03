# Marketplace submissions

Ready-to-copy files for the two plugin markets. Prerequisites, publish order and verification:
[docs/publish.md](../docs/publish.md).

| File | Destination |
|---|---|
| [`magpie/registry-entry.json`](magpie/registry-entry.json) | one entry in the `plugins` array of `registry.json` in [magpie-community/plugins](https://github.com/magpie-community/plugins) |
| [`dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml`](dsh/siml1169__ShyPie--plugins-dsh-privacy-gate.yml) | `data/plugins/` in [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) |

Both entries name the npm packages (`@shypie_privacy/magpie-privacy-gate`, `@shypie_privacy/dsh-privacy-gate`), so
publish those first — a registry row that resolves to a 404 is worse than no row.
