export type DomainRuleType = "domain" | "full" | "keyword" | "regexp";
export type EntryType = DomainRuleType | "include";

export interface SourceLocation {
  list: string;
  line: number;
}

export interface DomainRule {
  type: DomainRuleType;
  value: string;
  attrs: string[];
  affiliations: string[];
  plain: string;
  source: SourceLocation;
}

export interface IncludeRule {
  type: "include";
  sourceList: string;
  attrs: string[];
  mustAttrs: string[];
  banAttrs: string[];
  source: SourceLocation;
}

export type SourceEntry = DomainRule | IncludeRule;

export interface ResolvedList {
  name: string;
  entries: DomainRule[];
}

export type RegexMode = "strict" | "balanced" | "full";

export type SurgeRuleType =
  | "DOMAIN-SUFFIX"
  | "DOMAIN"
  | "DOMAIN-KEYWORD"
  | "DOMAIN-WILDCARD";

export interface SurgeRule {
  type: SurgeRuleType;
  value: string;
  source: SourceLocation;
}

export interface RegexIssue {
  pattern: string;
  source: SourceLocation;
  reason: string;
  mode: RegexMode;
}

export interface EmitReport {
  regex: {
    total: number;
    lossless: number;
    widened: number;
    unsupported: number;
  };
  widened: RegexIssue[];
  unsupported: RegexIssue[];
}

export interface EmitSurgeOptions {
  regexMode?: RegexMode;
  onUnsupportedRegex?: "skip" | "error";
  dedupe?: boolean;
}

export interface EmitSurgeResult {
  lines: string[];
  text: string;
  rules: SurgeRule[];
  report: EmitReport;
}

export interface RegexTranspileResult {
  status: "lossless" | "widened" | "unsupported";
  rules: Array<Pick<SurgeRule, "type" | "value">>;
  reason?: string;
}

export interface SourceCounts {
  domain: number;
  full: number;
  keyword: number;
  regexp: number;
  include: number;
  affiliations: number;
  attributes: number;
}

export interface ResolvedCounts {
  rules: number;
  domain: number;
  full: number;
  keyword: number;
  regexp: number;
}

export interface ModeStats {
  rules: number;
  bytes: number;
  regex: EmitReport["regex"];
  unsupported: RegexIssue[];
}

export interface ListStats {
  name: string;
  source: SourceCounts;
  resolved: ResolvedCounts;
  filters: {
    attrs: Record<string, number>;
  };
  modes: Record<RegexMode, ModeStats>;
}

export interface GlobalStats {
  lists: number;
  source: SourceCounts;
  resolved: ResolvedCounts;
  modes: Record<RegexMode, Omit<ModeStats, "unsupported">>;
}
