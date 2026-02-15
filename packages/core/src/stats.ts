import type {
  DomainRule,
  EmitSurgeResult,
  GlobalStats,
  ListStats,
  ModeStats,
  RegexMode,
  ResolvedCounts,
  SourceCounts,
  SourceEntry
} from "./types.js";

const MODES: RegexMode[] = ["strict", "balanced", "full"];

export function countSourceEntries(entries: SourceEntry[]): SourceCounts {
  const counts = makeEmptySourceCounts();

  for (const entry of entries) {
    if (entry.type === "include") {
      counts.include += 1;
      counts.attributes += entry.attrs.length;
      continue;
    }

    counts[entry.type] += 1;
    counts.affiliations += entry.affiliations.length;
    counts.attributes += entry.attrs.length;
  }

  return counts;
}

export function countResolvedEntries(entries: DomainRule[]): ResolvedCounts {
  const counts = makeEmptyResolvedCounts();

  for (const entry of entries) {
    counts.rules += 1;
    counts[entry.type] += 1;
  }

  return counts;
}

export function countFilterAttrs(entries: DomainRule[]): Record<string, number> {
  const attrs: Record<string, number> = {};

  for (const entry of entries) {
    for (const attr of entry.attrs) {
      attrs[attr] = (attrs[attr] ?? 0) + 1;
    }
  }

  return attrs;
}

export function modeStatsFromEmit(result: EmitSurgeResult): ModeStats {
  return {
    rules: result.lines.length,
    bytes: byteLengthUtf8(result.text),
    regex: { ...result.report.regex },
    unsupported: [...result.report.unsupported]
  };
}

export function aggregateGlobalStats(lists: ListStats[]): GlobalStats {
  const global: GlobalStats = {
    lists: lists.length,
    source: makeEmptySourceCounts(),
    resolved: makeEmptyResolvedCounts(),
    modes: {
      strict: makeEmptyModeStats(),
      balanced: makeEmptyModeStats(),
      full: makeEmptyModeStats()
    }
  };

  for (const list of lists) {
    mergeSourceCounts(global.source, list.source);
    mergeResolvedCounts(global.resolved, list.resolved);

    for (const mode of MODES) {
      const target = global.modes[mode];
      const incoming = list.modes[mode];
      target.rules += incoming.rules;
      target.bytes += incoming.bytes;
      target.regex.total += incoming.regex.total;
      target.regex.lossless += incoming.regex.lossless;
      target.regex.widened += incoming.regex.widened;
      target.regex.unsupported += incoming.regex.unsupported;
    }
  }

  return global;
}

function byteLengthUtf8(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

function mergeSourceCounts(target: SourceCounts, incoming: SourceCounts): void {
  target.domain += incoming.domain;
  target.full += incoming.full;
  target.keyword += incoming.keyword;
  target.regexp += incoming.regexp;
  target.include += incoming.include;
  target.affiliations += incoming.affiliations;
  target.attributes += incoming.attributes;
}

function mergeResolvedCounts(target: ResolvedCounts, incoming: ResolvedCounts): void {
  target.rules += incoming.rules;
  target.domain += incoming.domain;
  target.full += incoming.full;
  target.keyword += incoming.keyword;
  target.regexp += incoming.regexp;
}

function makeEmptySourceCounts(): SourceCounts {
  return {
    domain: 0,
    full: 0,
    keyword: 0,
    regexp: 0,
    include: 0,
    affiliations: 0,
    attributes: 0
  };
}

function makeEmptyResolvedCounts(): ResolvedCounts {
  return {
    rules: 0,
    domain: 0,
    full: 0,
    keyword: 0,
    regexp: 0
  };
}

function makeEmptyModeStats(): Omit<ModeStats, "unsupported"> {
  return {
    rules: 0,
    bytes: 0,
    regex: {
      total: 0,
      lossless: 0,
      widened: 0,
      unsupported: 0
    }
  };
}
