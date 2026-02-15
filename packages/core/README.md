# @surge-geosite/core

Core library for converting geosite-style lists into Surge ruleset lines.

## Design

The package is intentionally split into four pure stages:

1. `parser`: parse list text into typed entries (`domain/full/keyword/regexp/include`) with source locations.
2. `resolver`: apply affiliation and include graph resolution, attribute filters, dedupe and redundancy polish.
3. `regex`: convert regex rules to Surge-compatible rules under explicit modes (`strict`, `balanced`, `full`).
4. `surge`: emit final `DOMAIN-SUFFIX / DOMAIN / DOMAIN-KEYWORD / DOMAIN-WILDCARD` lines with conversion report.

No filesystem or network access is required in core APIs.

## API

- `parseListText(listName, content)`
- `parseListsFromText(record)`
- `resolveAllLists(parsed)`
- `resolveOneList(parsed, listName)`
- `transpileRegexToSurge(pattern, mode)`
- `emitSurgeRuleset(resolvedList, options)`
- `buildResolvedListsFromText(record)`

## Regex Modes

- `strict`: only lossless conversion is allowed.
- `balanced`: allows heuristic wildcard conversion and reports widened matches.
- `full`: balanced behavior plus permissive fallback for hard regex cases.

Every emit call returns `report` with counts and itemized widened/unsupported entries.
