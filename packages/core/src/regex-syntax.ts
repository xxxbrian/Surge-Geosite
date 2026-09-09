const LITERAL_DOMAIN_REGEX = /^(?:\^|\(\^\|\\\.\))[a-z0-9-]+(?:\\\.[a-z0-9-]+)+\$$/i;

/** Normalize only RE2 constructs whose meaning is exact for normalized hostnames. */
export function normalizeSimpleRe2Pattern(pattern: string): string {
  const ignoreCase = pattern.startsWith("(?i)");
  let candidate = ignoreCase ? pattern.slice(4) : pattern;
  candidate = candidate.replace(/^\\A/, "^").replace(/\\z$/, "$");
  if (!LITERAL_DOMAIN_REGEX.test(candidate)) {
    return pattern;
  }
  return ignoreCase ? candidate.toLowerCase() : candidate;
}

export function hasUnsupportedRegexSyntax(pattern: string): boolean {
  // The converter is not a Go/RE2 parser. Preserve unhandled syntax as a source
  // entry, but never reinterpret it with JavaScript's different regex semantics.
  return /\(\?[imsU-]|\(\?P|\(\?<[^=!]|\[\[:|\\(?![dDwWsS.\-])/.test(pattern);
}
