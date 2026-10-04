# Market tools

Tools for the plugin market repo (github.com/Kljub/BothubMarketPlace). The
market repo holds only plugin folders in its root (one per plugin, named like
its id `plugin_<name>`; `Template/` is the template, id `plugin_template`) and `index.json`, which the BotHub API
reads (`BOTHUB_MARKET_INDEX`).

The market repo is found through `BOTHUB_MARKET_DIR` (default:
`../BothubMarketPlace` next to this repo). Schema and permission catalog come
from `shared/`, the test kit from `sdk/dist` (build it: `cd sdk && npx tsc`).

```
npm install
npm run create -- weather --features nodes,storage     # new folder plugin_weather/ in the market root (--list, --features all)
npm run validate [-- plugin_weather]                        # the checks of the BotHub install and more
npm test [-- plugin_weather]                                # tests of each plugin, in its own folder
npm run pack [-- plugin_weather]                            # dist/<id>-<version>.zip + SHA-256 (Template is never packed)
npm run index [-- --check]                             # index.json of the market repo
npm run sync-sdk [-- plugin_weather]                        # fresh test kit into <plugin>/test/lib/
npm run check                                          # validate + test + index --check
```

`parts/` holds the building blocks of `create`: `base/` plus one folder per
feature (see `parts/README.md`).

## Publishing a version

1. Raise `version` in the plugin's `bothub.json`, `npm run check`.
2. `npm run pack -- plugin_weather`.
3. GitHub Release `plugin_weather-<version>` in the market repo, zip as asset.
4. `npm run index` and commit `index.json` (+ the plugin folder) to the market repo.
