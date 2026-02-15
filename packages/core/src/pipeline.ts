import { parseListsFromText } from "./parser.js";
import { resolveAllLists } from "./resolver.js";
import type { ResolvedList } from "./types.js";

export function buildResolvedListsFromText(input: Record<string, string>): Record<string, ResolvedList> {
  const parsed = parseListsFromText(input);
  return resolveAllLists(parsed);
}
