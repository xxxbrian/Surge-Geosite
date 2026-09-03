# @surge-geosite/cli

Development/debug helper for generating geosite artifacts locally.

## Command

- `surge-geosite build --data-dir <dir> [--list <a,b,c>] [--out-dir <dir>]`

## Output Layout

- `<out>/meta.json`
- `<out>/index/geosite.json`
- `<out>/rules/strict/<list>.txt`
- `<out>/rules/balanced/<list>.txt`
- `<out>/rules/full/<list>.txt`
- `<out>/resolved/<list>.json`
- `<out>/stats/global.json`
- `<out>/stats/lists/<list>.json`

`balanced` is the default serving mode.

`index/geosite.json` is a compact `{ [listName]: filters[] }` index.

Each build, including `--list`, replaces the generated dataset set and removes previously generated lists omitted from this build. Use separate output directories for independent subsets.
