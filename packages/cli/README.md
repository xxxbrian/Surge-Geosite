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
