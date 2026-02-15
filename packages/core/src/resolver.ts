import { GeositeResolveError } from "./errors.js";
import { normalizeListName } from "./parser.js";
import type { DomainRule, IncludeRule, ResolvedList, SourceEntry } from "./types.js";

interface Inclusion {
  source: string;
  mustAttrs: string[];
  banAttrs: string[];
}

interface WorkingList {
  name: string;
  inclusions: Inclusion[];
  rules: DomainRule[];
}

export function resolveAllLists(parsed: Record<string, SourceEntry[]>): Record<string, ResolvedList> {
  const workingMap = buildWorkingMap(parsed);
  const resolved = new Map<string, ResolvedList>();

  const names = Array.from(workingMap.keys()).sort();
  for (const name of names) {
    resolveList(name, workingMap, resolved, []);
  }

  const output: Record<string, ResolvedList> = {};
  for (const name of names) {
    const list = resolved.get(name);
    if (list) {
      output[name] = list;
    }
  }

  return output;
}

export function resolveOneList(parsed: Record<string, SourceEntry[]>, listName: string): ResolvedList {
  const normalized = normalizeListName(listName);
  const resolved = resolveAllLists(parsed);
  const target = resolved[normalized];
  if (!target) {
    throw new GeositeResolveError(`list does not exist: ${normalized}`);
  }
  return target;
}

function buildWorkingMap(parsed: Record<string, SourceEntry[]>): Map<string, WorkingList> {
  const map = new Map<string, WorkingList>();

  for (const listName of Object.keys(parsed)) {
    ensureWorkingList(map, normalizeListName(listName));
  }

  for (const [rawListName, entries] of Object.entries(parsed)) {
    const listName = normalizeListName(rawListName);
    const workingList = ensureWorkingList(map, listName);

    for (const entry of entries) {
      if (entry.type === "include") {
        registerInclusion(workingList, entry);
        continue;
      }

      workingList.rules.push(entry);

      for (const affiliation of entry.affiliations) {
        ensureWorkingList(map, affiliation).rules.push(entry);
      }
    }
  }

  return map;
}

function registerInclusion(list: WorkingList, includeRule: IncludeRule): void {
  list.inclusions.push({
    source: includeRule.sourceList,
    mustAttrs: includeRule.mustAttrs,
    banAttrs: includeRule.banAttrs
  });
}

function ensureWorkingList(map: Map<string, WorkingList>, name: string): WorkingList {
  const existing = map.get(name);
  if (existing) {
    return existing;
  }

  const created: WorkingList = {
    name,
    inclusions: [],
    rules: []
  };
  map.set(name, created);
  return created;
}

function resolveList(
  name: string,
  workingMap: Map<string, WorkingList>,
  resolved: Map<string, ResolvedList>,
  stack: string[]
): void {
  if (resolved.has(name)) {
    return;
  }

  if (stack.includes(name)) {
    throw new GeositeResolveError(`circular inclusion detected: ${[...stack, name].join(" -> ")}`);
  }

  const list = workingMap.get(name);
  if (!list) {
    throw new GeositeResolveError(`list does not exist: ${name}`);
  }

  const rough = new Map<string, DomainRule>();
  for (const rule of list.rules) {
    rough.set(rule.plain, rule);
  }

  for (const inclusion of list.inclusions) {
    if (!workingMap.has(inclusion.source)) {
      throw new GeositeResolveError(`list ${name} includes a non-existent list: ${inclusion.source}`);
    }

    resolveList(inclusion.source, workingMap, resolved, [...stack, name]);
    const included = resolved.get(inclusion.source);

    if (!included) {
      throw new GeositeResolveError(`failed to resolve list: ${inclusion.source}`);
    }

    for (const entry of included.entries) {
      if (matchesAttrFilters(entry, inclusion)) {
        rough.set(entry.plain, entry);
      }
    }
  }

  resolved.set(name, {
    name,
    entries: polishRules(Array.from(rough.values()))
  });
}

function matchesAttrFilters(rule: DomainRule, inclusion: Inclusion): boolean {
  if (inclusion.mustAttrs.length === 0 && inclusion.banAttrs.length === 0) {
    return true;
  }

  if (rule.attrs.length === 0) {
    return inclusion.mustAttrs.length === 0;
  }

  for (const mustAttr of inclusion.mustAttrs) {
    if (!rule.attrs.includes(mustAttr)) {
      return false;
    }
  }

  for (const banAttr of inclusion.banAttrs) {
    if (rule.attrs.includes(banAttr)) {
      return false;
    }
  }

  return true;
}

function polishRules(rules: DomainRule[]): DomainRule[] {
  const finalRules: DomainRule[] = [];
  const queuedRules: DomainRule[] = [];
  const plainDomains = new Set<string>();

  for (const rule of rules) {
    switch (rule.type) {
      case "regexp":
      case "keyword":
        finalRules.push(rule);
        break;
      case "domain":
        plainDomains.add(rule.value);
        if (rule.attrs.length === 0) {
          queuedRules.push(rule);
        } else {
          finalRules.push(rule);
        }
        break;
      case "full":
        if (rule.attrs.length === 0) {
          queuedRules.push(rule);
        } else {
          finalRules.push(rule);
        }
        break;
      default:
        break;
    }
  }

  for (const queuedRule of queuedRules) {
    let parentDomain = queuedRule.type === "full" ? `.${queuedRule.value}` : queuedRule.value;
    let redundant = false;

    while (true) {
      const dotIndex = parentDomain.indexOf(".");
      if (dotIndex === -1) {
        break;
      }

      parentDomain = parentDomain.slice(dotIndex + 1);
      if (plainDomains.has(parentDomain)) {
        redundant = true;
        break;
      }
    }

    if (!redundant) {
      finalRules.push(queuedRule);
    }
  }

  finalRules.sort((left, right) => left.plain.localeCompare(right.plain));
  return finalRules;
}
