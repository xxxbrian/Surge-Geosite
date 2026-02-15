#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  aggregateGlobalStats,
  countFilterAttrs,
  countResolvedEntries,
  countSourceEntries,
  emitSurgeRuleset,
  modeStatsFromEmit,
  parseListsFromText,
  resolveAllLists,
  type ListStats,
  type RegexMode
} from "@surge-geosite/core";

import { getStringFlag, parseCliArgs } from "./args.js";
import { loadListsFromDirectory } from "./fs-loader.js";

const ALL_MODES: RegexMode[] = ["strict", "balanced", "full"];

interface BuildIndexEntry {
  name: string;
  sourceFile?: string;
  filters: string[];
  modes: Record<RegexMode, string>;
}

interface BuildMeta {
  generatedAt: string;
  defaultMode: "balanced";
  lists: number;
  modes: RegexMode[];
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);

  switch (parsed.command) {
    case "build":
      return runBuild(parsed.flags);
    case "help":
    default:
      printHelp();
      return parsed.command === "help" ? 0 : 1;
  }
}

async function runBuild(flags: Record<string, string | boolean>): Promise<number> {
  const dataDir = getStringFlag(flags, "data-dir");
  const outDir = path.resolve(process.cwd(), getStringFlag(flags, "out-dir") ?? "out");
  const listArg = getStringFlag(flags, "list");

  if (!dataDir) {
    console.error("missing required flag: --data-dir");
    return 1;
  }

  const sourceRecord = await loadListsFromDirectory(path.resolve(process.cwd(), dataDir));
  const parsed = parseListsFromText(sourceRecord);
  const resolved = resolveAllLists(parsed);

  const requestedNames = listArg
    ? splitListArg(listArg).map((name) => name.toUpperCase())
    : Object.keys(resolved).sort();

  for (const listName of requestedNames) {
    if (!resolved[listName]) {
      console.error(`list not found: ${listName}`);
      return 1;
    }
  }

  await mkdir(path.join(outDir, "rules"), { recursive: true });
  await mkdir(path.join(outDir, "resolved"), { recursive: true });
  await mkdir(path.join(outDir, "stats", "lists"), { recursive: true });
  await mkdir(path.join(outDir, "index"), { recursive: true });

  const listStats: ListStats[] = [];
  const indexRecord: Record<string, BuildIndexEntry> = {};

  for (const listName of requestedNames) {
    const resolvedList = resolved[listName]!;
    const sourceEntries = parsed[listName] ?? [];

    const emittedByMode = {
      strict: emitSurgeRuleset(resolvedList, { regexMode: "strict" }),
      balanced: emitSurgeRuleset(resolvedList, { regexMode: "balanced" }),
      full: emitSurgeRuleset(resolvedList, { regexMode: "full" })
    };

    const modes = {
      strict: modeStatsFromEmit(emittedByMode.strict),
      balanced: modeStatsFromEmit(emittedByMode.balanced),
      full: modeStatsFromEmit(emittedByMode.full)
    };

    for (const mode of ALL_MODES) {
      const emitted = emittedByMode[mode];
      const outputPath = path.join(outDir, "rules", mode, `${listName.toLowerCase()}.txt`);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${emitted.text}\n`, "utf8");
    }

    const resolvedPath = path.join(outDir, "resolved", `${listName.toLowerCase()}.json`);
    await writeFile(resolvedPath, `${JSON.stringify(resolvedList.entries, null, 2)}\n`, "utf8");

    const currentListStats: ListStats = {
      name: listName,
      source: countSourceEntries(sourceEntries),
      resolved: countResolvedEntries(resolvedList.entries),
      filters: {
        attrs: countFilterAttrs(resolvedList.entries)
      },
      modes
    };

    listStats.push(currentListStats);

    const perListStatsPath = path.join(outDir, "stats", "lists", `${listName.toLowerCase()}.json`);
    await writeFile(perListStatsPath, `${JSON.stringify(currentListStats, null, 2)}\n`, "utf8");

    const sourceFile = sourceRecord[listName.toLowerCase()] !== undefined ? listName.toLowerCase() : undefined;
    indexRecord[listName.toLowerCase()] = {
      name: listName,
      ...(sourceFile ? { sourceFile } : {}),
      filters: Object.keys(currentListStats.filters.attrs).sort(),
      modes: {
        strict: `rules/strict/${listName.toLowerCase()}.txt`,
        balanced: `rules/balanced/${listName.toLowerCase()}.txt`,
        full: `rules/full/${listName.toLowerCase()}.txt`
      }
    };
  }

  const globalStats = aggregateGlobalStats(listStats);
  const meta: BuildMeta = {
    generatedAt: new Date().toISOString(),
    defaultMode: "balanced",
    lists: listStats.length,
    modes: ALL_MODES
  };

  await writeFile(path.join(outDir, "stats", "global.json"), `${JSON.stringify(globalStats, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "index", "geosite.json"), `${JSON.stringify(indexRecord, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  console.log(`generated lists=${listStats.length} modes=${ALL_MODES.join(",")} output=${outDir}`);
  console.log(`default mode path: ${path.join(outDir, "rules", "balanced")}`);
  return 0;
}

function splitListArg(input: string): string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function printHelp(): void {
  console.log(`surge-geosite commands:
  build --data-dir <dir> [--list <a,b,c>] [--out-dir <dir>]

build output layout:
  <out>/meta.json
  <out>/index/geosite.json
  <out>/rules/strict/<list>.txt
  <out>/rules/balanced/<list>.txt
  <out>/rules/full/<list>.txt
  <out>/resolved/<list>.json
  <out>/stats/global.json
  <out>/stats/lists/<list>.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
