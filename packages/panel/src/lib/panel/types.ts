export type PanelLocale = 'zh' | 'en';
export type PanelMode = 'strict' | 'balanced' | 'full';

export type GeositeIndex = Record<string, string[]>;

export interface RulesMeta {
	etag: string;
	stale: boolean;
	ruleLines: number;
}
