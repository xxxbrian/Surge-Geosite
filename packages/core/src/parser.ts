import { GeositeParseError } from "./errors.js";
import type { DomainRule, DomainRuleType, IncludeRule, SourceEntry } from "./types.js";

const VALID_DOMAIN_CHAR = /^[a-z0-9.-]+$/;
const VALID_ATTR_CHAR = /^[a-z0-9!-]+$/;
const VALID_SITE_NAME = /^[A-Z0-9!-]+$/;

export function parseListText(listName: string, content: string): SourceEntry[] {
  const normalizedList = normalizeListName(listName);
  const entries: SourceEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const stripped = stripComment(lines[index] ?? "").trim();
    if (stripped.length === 0) {
      continue;
    }

    try {
      entries.push(parseEntryLine(normalizedList, stripped, lineNo));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GeositeParseError(`error in ${normalizedList} at line ${lineNo}: ${message}`);
    }
  }

  return entries;
}

export function parseListsFromText(input: Record<string, string>): Record<string, SourceEntry[]> {
  const parsed: Record<string, SourceEntry[]> = {};

  for (const [listName, content] of Object.entries(input)) {
    parsed[normalizeListName(listName)] = parseListText(listName, content);
  }

  return parsed;
}

export function normalizeListName(name: string): string {
  const normalized = name.trim().toUpperCase();
  if (!VALID_SITE_NAME.test(normalized)) {
    throw new GeositeParseError(`invalid list name: ${JSON.stringify(name)}`);
  }
  return normalized;
}

function parseEntryLine(listName: string, line: string, lineNo: number): SourceEntry {
  const parts = line.split(/\s+/);
  if (parts.length === 0) {
    throw new GeositeParseError("empty line");
  }

  const token = parts[0];
  if (!token) {
    throw new GeositeParseError("empty line");
  }
  const colonIndex = token.indexOf(":");

  const attrs: string[] = [];
  const affiliations: string[] = [];

  for (const part of parts.slice(1)) {
    if (part.startsWith("@")) {
      const attr = part.slice(1).toLowerCase();
      if (!VALID_ATTR_CHAR.test(attr)) {
        throw new GeositeParseError(`invalid attribute: ${JSON.stringify(attr)}`);
      }
      attrs.push(attr);
      continue;
    }

    if (part.startsWith("&")) {
      const affiliation = part.slice(1).toUpperCase();
      if (!VALID_SITE_NAME.test(affiliation)) {
        throw new GeositeParseError(`invalid affiliation: ${JSON.stringify(affiliation)}`);
      }
      affiliations.push(affiliation);
      continue;
    }

    throw new GeositeParseError(`invalid attribute/affiliation: ${JSON.stringify(part)}`);
  }

  attrs.sort();

  if (colonIndex === -1) {
    return makeDomainRule(listName, lineNo, "domain", token.toLowerCase(), attrs, affiliations);
  }

  const type = token.slice(0, colonIndex).toLowerCase();
  const value = token.slice(colonIndex + 1);

  if (type === "include") {
    if (affiliations.length > 0) {
      throw new GeositeParseError(`affiliation is not allowed for include:${JSON.stringify(value)}`);
    }

    const sourceList = value.toUpperCase();
    if (!VALID_SITE_NAME.test(sourceList)) {
      throw new GeositeParseError(`invalid include list name: ${JSON.stringify(value)}`);
    }

    return makeIncludeRule(listName, lineNo, sourceList, attrs);
  }

  if (type === "regexp") {
    validateRegex(value);
    return makeDomainRule(listName, lineNo, "regexp", value, attrs, affiliations);
  }

  if (type === "domain" || type === "full" || type === "keyword") {
    return makeDomainRule(listName, lineNo, type, value.toLowerCase(), attrs, affiliations);
  }

  throw new GeositeParseError(`invalid type: ${JSON.stringify(type)}`);
}

function makeDomainRule(
  listName: string,
  lineNo: number,
  type: DomainRuleType,
  value: string,
  attrs: string[],
  affiliations: string[]
): DomainRule {
  if (type !== "regexp" && !VALID_DOMAIN_CHAR.test(value)) {
    throw new GeositeParseError(`invalid domain: ${JSON.stringify(value)}`);
  }

  const plain = buildPlain(type, value, attrs);

  return {
    type,
    value,
    attrs,
    affiliations,
    plain,
    source: {
      list: listName,
      line: lineNo
    }
  };
}

function makeIncludeRule(listName: string, lineNo: number, sourceList: string, attrs: string[]): IncludeRule {
  const mustAttrs: string[] = [];
  const banAttrs: string[] = [];

  for (const attr of attrs) {
    if (attr.startsWith("-")) {
      banAttrs.push(attr.slice(1));
      continue;
    }

    mustAttrs.push(attr);
  }

  return {
    type: "include",
    sourceList,
    attrs,
    mustAttrs,
    banAttrs,
    source: {
      list: listName,
      line: lineNo
    }
  };
}

function buildPlain(type: DomainRuleType, value: string, attrs: string[]): string {
  if (attrs.length === 0) {
    return `${type}:${value}`;
  }

  return `${type}:${value}:${attrs.map((attr) => `@${attr}`).join(",")}`;
}

function stripComment(input: string): string {
  const commentIndex = input.indexOf("#");
  if (commentIndex === -1) {
    return input;
  }
  return input.slice(0, commentIndex);
}

function validateRegex(pattern: string): void {
  try {
    void new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GeositeParseError(`invalid regexp ${JSON.stringify(pattern)}: ${message}`);
  }
}
