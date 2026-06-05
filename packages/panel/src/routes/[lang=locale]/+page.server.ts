import { buildRulesPublicPath } from '$lib/panel/api';
import { SSR_INITIAL_LIST_LIMIT } from '$lib/panel/constants';
import { t } from '$lib/panel/i18n';
import { countRuleLines, normalizeEtag } from '$lib/panel/utils';

import type { GeositeIndex, PanelLocale, PanelMode } from '$lib/panel/types';
import type { PageServerLoad } from './$types';

const DEFAULT_MODE: PanelMode = 'balanced';
const RULES_CACHE_LIMIT = 64;
const INDEX_REVALIDATE_INTERVAL_MS = 20_000;

type IndexCacheEntry = {
	fullIndex: GeositeIndex;
	names: string[];
	indexEtag: string;
	upstreamEtag: string;
};

type RulesCacheEntry = {
	text: string;
	etag: string;
	stale: boolean;
	ruleLines: string;
};

let indexCache: IndexCacheEntry | null = null;
let indexRevalidateInFlight = false;
let nextIndexRevalidateAt = 0;
const rulesCache = new Map<string, RulesCacheEntry>();

function pruneRulesCache(): void {
	while (rulesCache.size > RULES_CACHE_LIMIT) {
		const firstKey = rulesCache.keys().next();
		if (firstKey.done) {
			return;
		}
		rulesCache.delete(firstKey.value);
	}
}

function getUpstreamEtagRaw(headers: Headers): string {
	return headers.get('x-upstream-etag') ?? headers.get('etag') ?? '-';
}

function getIndexEtagRaw(headers: Headers): string {
	return headers.get('etag') ?? getUpstreamEtagRaw(headers);
}

async function fetchIndexFresh(fetchFn: typeof fetch): Promise<IndexCacheEntry> {
	const response = await fetchFn('/geosite', {
		headers: {
			accept: 'application/json'
		}
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}

	const fullIndex = (await response.json()) as GeositeIndex;
	const names = Object.keys(fullIndex).sort();
	const indexEtag = getIndexEtagRaw(response.headers);
	const upstreamEtag = getUpstreamEtagRaw(response.headers);

	const next: IndexCacheEntry = {
		fullIndex,
		names,
		indexEtag,
		upstreamEtag
	};
	indexCache = next;
	return next;
}

async function maybeRevalidateIndex(fetchFn: typeof fetch): Promise<void> {
	if (!indexCache || indexRevalidateInFlight) {
		return;
	}
	if (Date.now() < nextIndexRevalidateAt) {
		return;
	}

	indexRevalidateInFlight = true;
	nextIndexRevalidateAt = Date.now() + INDEX_REVALIDATE_INTERVAL_MS;

	try {
		const response = await fetchFn('/geosite', {
			headers: {
				accept: 'application/json',
				'if-none-match': indexCache.indexEtag
			}
		});
		if (response.status === 304) {
			return;
		}
		if (!response.ok) {
			return;
		}

		const fullIndex = (await response.json()) as GeositeIndex;
		indexCache = {
			fullIndex,
			names: Object.keys(fullIndex).sort(),
			indexEtag: getIndexEtagRaw(response.headers),
			upstreamEtag: getUpstreamEtagRaw(response.headers)
		};
	} catch {
		// Keep serving existing cache on revalidation failures.
	} finally {
		indexRevalidateInFlight = false;
	}
}

export const load: PageServerLoad = async ({ params, fetch }) => {
	const locale = params.lang as PanelLocale;
	const tr = (key: string, vars: Record<string, string | number> = {}) => t(locale, key, vars);

	let index: GeositeIndex = {};
	let names: string[] = [];
	let selected: string | null = null;
	let previewText = tr('selectDataset');
	let etag = '-';
	let stale = '-';
	let ruleLines = '-';
	let rawLink = '#';
	let initError: string | null = null;

	try {
		let currentIndex = indexCache;
		if (!currentIndex) {
			currentIndex = await fetchIndexFresh(fetch);
		} else {
			void maybeRevalidateIndex(fetch);
		}

		names = currentIndex.names;
		const fullIndex = currentIndex.fullIndex;

		if (names.length === 0) {
			previewText = tr('indexEmpty');
		} else {
			selected = names[0];
			const initialIndex: GeositeIndex = {};
			for (const name of names.slice(0, SSR_INITIAL_LIST_LIMIT)) {
				const entry = fullIndex[name];
				if (entry !== undefined) {
					initialIndex[name] = entry;
				}
			}
			const selectedEntry = fullIndex[selected];
			if (selectedEntry !== undefined) {
				initialIndex[selected] = selectedEntry;
			}
			index = initialIndex;

			rawLink = buildRulesPublicPath(DEFAULT_MODE, selected, null);
			const rulesKey = `${currentIndex.upstreamEtag}:${DEFAULT_MODE}:${selected}`;
			const cachedRules = rulesCache.get(rulesKey);

			if (cachedRules) {
				previewText = cachedRules.text.length === 0 ? tr('emptyResult') : cachedRules.text;
				etag = cachedRules.etag;
				stale = cachedRules.stale ? tr('yes') : tr('no');
				ruleLines = cachedRules.ruleLines;
			} else {
				const rulesResponse = await fetch(`/geosite/${DEFAULT_MODE}/${encodeURIComponent(selected)}`, {
					headers: {
						accept: 'text/plain'
					}
				});
				const rulesText = await rulesResponse.text();

				const upstreamEtag = rulesResponse.headers.get('x-upstream-etag') ?? currentIndex.upstreamEtag;
				etag = normalizeEtag(upstreamEtag);
				stale = rulesResponse.headers.get('x-stale') === '1' ? tr('yes') : tr('no');
				if (!rulesResponse.ok) {
					previewText = `${rulesResponse.status} ${rulesResponse.statusText}\n${rulesText}`.trim();
				} else {
					previewText = rulesText.length === 0 ? tr('emptyResult') : rulesText;
					ruleLines = String(countRuleLines(rulesText));
					rulesCache.set(rulesKey, {
						text: rulesText,
						etag: normalizeEtag(upstreamEtag),
						stale: rulesResponse.headers.get('x-stale') === '1',
						ruleLines
					});
					pruneRulesCache();
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		previewText = tr('failedLoad', { message });
		initError = message;
	}

	return {
		locale,
		index,
		names,
		selected,
		mode: DEFAULT_MODE,
		previewText,
		etag,
		stale,
		ruleLines,
		rawLink,
		initError
	};
};
