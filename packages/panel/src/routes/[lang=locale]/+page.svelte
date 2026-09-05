<svelte:options runes={false} />

<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import {
		Check,
		Cloud,
		Copy,
		Download,
		ExternalLink,
		LocateFixed,
		Network,
		RadioTower,
		Route,
		Waypoints
	} from '@lucide/svelte';

	import { buildRulesApiPath, buildRulesPublicPath } from '$lib/panel/api';
	import { SSR_INITIAL_LIST_LIMIT } from '$lib/panel/constants';
	import { t } from '$lib/panel/i18n';
	import { createLatestRequest } from '$lib/panel/latest-request';
	import SidebarLinkGroup from '$lib/panel/sidebar-link-group.svelte';
	import type { GeositeIndex, PanelLocale, PanelMode } from '$lib/panel/types';
	import { countRuleLines, normalizeEtag } from '$lib/panel/utils';

	import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import { Skeleton } from '$lib/components/ui/skeleton';

	import type { PageData } from './$types';

	const MODES: PanelMode[] = ['strict', 'balanced', 'full'];
	const NONE_FILTER = '__none__';
	const SITE_ORIGIN = 'https://surge.bojin.co';
	const IP_TOOLS_ORIGIN = 'https://ip.bojin.co';

	export let data: PageData;

	let locale: PanelLocale;
	let index: GeositeIndex;
	let names: string[];
	let selected: string | null;
	let mode: PanelMode;
	let search: string;
	let selectedFilter: string;
	let manualFilter: string;
	let debouncedManualFilter: string;
	let listCount: string;
	let previewText: string;
	let etag: string;
	let stale: string;
	let ruleLines: string;
	let rawLink: string;
	let isIndexLoading: boolean;
	let isRulesLoading: boolean;
	let initError: string | null;
	let isIndexHydrating: boolean;

	const rulesRequest = createLatestRequest();
	let lastQueryKey = '';
	let serverDataVersion = 0;
	let lastHydratedServerDataVersion = 0;
	let manualDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let copiedLinkKey: string | null = null;
	let copiedQuickLinkTimer: ReturnType<typeof setTimeout> | null = null;

	let tr: (key: string, vars?: Record<string, string | number>) => string = (key, vars = {}) =>
		t(locale, key, vars);
	$: tr = (key, vars = {}) => t(locale, key, vars);

	function applyServerData(next: PageData) {
		rulesRequest.cancel();
		clearManualDebounceTimer();
		const nextLocale = next.locale as PanelLocale;
		locale = nextLocale;
		index = next.index ?? {};
		names = next.names ?? [];
		selected = next.selected ?? null;
		mode = (next.mode as PanelMode) ?? 'balanced';
		search = '';
		selectedFilter = NONE_FILTER;
		manualFilter = '';
		debouncedManualFilter = '';
		listCount = next.initError
			? t(nextLocale, 'error')
			: t(nextLocale, 'listsCount', { count: names.length });
		previewText = next.previewText ?? t(nextLocale, 'selectDataset');
		etag = next.etag ?? '-';
		stale = next.stale ?? '-';
		ruleLines = next.ruleLines ?? '-';
		rawLink = next.rawLink ?? '#';
		isIndexLoading = false;
		isRulesLoading = false;
		isIndexHydrating = false;
		initError = next.initError ?? null;
		lastQueryKey = selected ? `${selected}|${mode}|` : '';
		serverDataVersion += 1;
	}

	applyServerData(data);
	$: applyServerData(data);

	$: availableFilters = selected ? (index[selected] ?? []) : [];
	$: filteredNames = (() => {
		const query = search.trim().toLowerCase();
		if (!query) {
			return names;
		}
		return names.filter((name) => name.includes(query));
	})();
	$: renderLimit = browser && hasFullIndex ? filteredNames.length : SSR_INITIAL_LIST_LIMIT;
	$: displayNames = filteredNames.slice(0, renderLimit);
	$: hasFullIndex = names.length > 0 && Object.keys(index).length >= names.length;

	$: liveFilter = (() => {
		const manual = manualFilter.trim().toLowerCase();
		if (manual) {
			return manual;
		}
		return selectedFilter === NONE_FILTER ? null : selectedFilter;
	})();

	$: debouncedFilter = (() => {
		const manual = debouncedManualFilter.trim().toLowerCase();
		if (manual) {
			return manual;
		}
		return selectedFilter === NONE_FILTER ? null : selectedFilter;
	})();

	$: quickLinks = (() => {
		if (!selected) {
			return [] as Array<{ mode: PanelMode; href: string }>;
		}
		return MODES.map((item) => ({
			mode: item,
			href: `${SITE_ORIGIN}${buildRulesPublicPath(item, selected as string, liveFilter)}`
		}));
	})();
	$: moreLinks = (() => {
		if (!selected) {
			return [] as Array<{ key: string; label: string; href: string }>;
		}

		const normalized = selected.trim().toLowerCase();
		return [
			{
				key: 'singbox-srs',
				label: tr('singboxSrs'),
				href: `${SITE_ORIGIN}/geosite-srs/${encodeURIComponent(normalized)}`
			},
			{
				key: 'mihono-mrs',
				label: tr('mihonoMrs'),
				href: `${SITE_ORIGIN}/geosite-mrs/${encodeURIComponent(normalized)}`
			}
		];
	})();

	$: if (initError) {
		listCount = tr('error');
	} else {
		listCount = tr('listsCount', { count: names.length });
	}
	$: canonicalPath = locale === 'en' ? '/en' : '/zh';
	$: canonicalUrl = `${SITE_ORIGIN}${canonicalPath}`;

	$: if (selected) {
		const queryKey = `${selected}|${mode}|${debouncedFilter ?? ''}`;
		if (queryKey !== lastQueryKey) {
			void loadRules(debouncedFilter);
		}
	} else {
		rawLink = '#';
	}

	$: if (
		browser &&
		serverDataVersion > 0 &&
		serverDataVersion !== lastHydratedServerDataVersion &&
		!isIndexLoading &&
		!initError &&
		names.length > 0 &&
		!hasFullIndex
	) {
		lastHydratedServerDataVersion = serverDataVersion;
		void hydrateFullIndexIfNeeded();
	}

	function resetMeta() {
		etag = '-';
		stale = '-';
		ruleLines = '-';
	}

	function clearManualDebounceTimer() {
		if (manualDebounceTimer) {
			clearTimeout(manualDebounceTimer);
			manualDebounceTimer = null;
		}
	}

	async function loadRules(filter: string | null, force = false) {
		if (!selected) {
			return;
		}

		const queryKey = `${selected}|${mode}|${filter ?? ''}`;
		if (!force && queryKey === lastQueryKey) {
			return;
		}
		lastQueryKey = queryKey;

		const request = rulesRequest.start();
		isRulesLoading = true;
		previewText = tr('loading');
		resetMeta();
		rawLink = buildRulesPublicPath(mode, selected, filter);

		try {
			const response = await fetch(buildRulesApiPath(mode, selected, filter), {
				headers: { accept: 'text/plain' },
				signal: request.signal
			});
			const body = await response.text();

			if (!request.isCurrent()) {
				return;
			}

			etag = normalizeEtag(response.headers.get('x-upstream-etag'));
			stale = response.headers.get('x-stale') === '1' ? tr('yes') : tr('no');

			if (!response.ok) {
				previewText = `${response.status} ${response.statusText}\n${body}`.trim();
				ruleLines = '-';
				return;
			}

			previewText = body.length === 0 ? tr('emptyResult') : body;
			ruleLines = String(countRuleLines(body));
		} catch (error) {
			if (!request.isCurrent()) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			previewText = tr('requestFailed', { message });
			resetMeta();
		} finally {
			if (request.isCurrent()) {
				isRulesLoading = false;
			}
		}
	}

	async function initIndex() {
		isIndexLoading = true;
		initError = null;

		try {
			let response: Response | null = null;
			for (let attempt = 0; attempt < 15; attempt += 1) {
				response = await fetch('/geosite', { headers: { accept: 'application/json' } });
				if (response.ok) {
					break;
				}

				if (response.status !== 503) {
					throw new Error(`${response.status} ${response.statusText}`);
				}

				listCount = tr('initializing');
				previewText = tr('upstreamInitializing', { current: attempt + 1, total: 15 });
				await new Promise((resolve) => setTimeout(resolve, 1200));
			}

			if (!response || !response.ok) {
				throw new Error('geosite data not ready');
			}

			index = (await response.json()) as GeositeIndex;
			names = Object.keys(index).sort();

			if (names.length === 0) {
				previewText = tr('indexEmpty');
				selected = null;
				listCount = tr('listsCount', { count: 0 });
				return;
			}

			selected = names[0] ?? null;
			selectedFilter = NONE_FILTER;
			clearManualDebounceTimer();
			manualFilter = '';
			debouncedManualFilter = '';
			previewText = tr('switchedDatasetLoading', { name: selected });
			lastQueryKey = '';
			await loadRules(null, true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			initError = message;
			listCount = tr('error');
			previewText = tr('failedLoad', { message });
		} finally {
			isIndexLoading = false;
		}
	}

	async function hydrateFullIndexIfNeeded() {
		if (isIndexHydrating || hasFullIndex || names.length === 0 || initError) {
			return;
		}

		isIndexHydrating = true;
		try {
			const response = await fetch('/geosite', {
				headers: { accept: 'application/json' }
			});
			if (!response.ok) {
				return;
			}

			const fullIndex = (await response.json()) as GeositeIndex;
			index = fullIndex;
		} catch {
			// Keep current partial index when hydration fetch fails.
		} finally {
			isIndexHydrating = false;
		}
	}

	function onSelectDataset(name: string) {
		if (name === selected) {
			return;
		}
		selected = name;
		selectedFilter = NONE_FILTER;
		clearManualDebounceTimer();
		manualFilter = '';
		debouncedManualFilter = '';
		previewText = tr('switchedDatasetLoading', { name });
		lastQueryKey = '';
	}

	function onModeChange(nextMode: PanelMode) {
		if (nextMode === mode) {
			return;
		}
		mode = nextMode;
		previewText = tr('modeSwitchLoading', { mode: nextMode });
	}

	function onFilterChange(value: string) {
		selectedFilter = value;
	}

	function onManualFilterInput(value: string) {
		manualFilter = value;
		clearManualDebounceTimer();
		manualDebounceTimer = setTimeout(() => {
			debouncedManualFilter = value;
		}, 280);
	}

	async function onCopyLink(key: string, href: string) {
		if (!browser) {
			return;
		}

		try {
			await navigator.clipboard.writeText(href);
			copiedLinkKey = key;

			if (copiedQuickLinkTimer) {
				clearTimeout(copiedQuickLinkTimer);
			}
			copiedQuickLinkTimer = setTimeout(() => {
				copiedLinkKey = null;
			}, 1200);
		} catch {
			copiedLinkKey = null;
		}
	}

	onMount(() => {
		if (names.length === 0 && !initError) {
			void initIndex();
		} else {
			void hydrateFullIndexIfNeeded();
		}

		return () => {
			rulesRequest.cancel();
			clearManualDebounceTimer();
			if (copiedQuickLinkTimer) {
				clearTimeout(copiedQuickLinkTimer);
			}
		};
	});
</script>

<svelte:head>
	<title>Surge Geosite Panel</title>
	<meta
		name="description"
		content={locale === 'zh'
			? 'Surge Geosite 面板：按模式和标签生成可直接使用的规则。'
			: 'Surge Geosite panel for generating ready-to-use rules by mode and filter.'}
	/>
	<link rel="canonical" href={canonicalUrl} />
	<link rel="alternate" hreflang="zh-CN" href={`${SITE_ORIGIN}/zh`} />
	<link rel="alternate" hreflang="en" href={`${SITE_ORIGIN}/en`} />
	<link rel="alternate" hreflang="x-default" href={`${SITE_ORIGIN}/en`} />
</svelte:head>

<main class="mx-auto box-border flex min-h-dvh w-full max-w-[1400px] flex-col gap-4 px-4 py-4 lg:h-dvh lg:overflow-hidden lg:px-8">
	<header class="border-b pb-4 text-card-foreground">
		<div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
			<div class="min-w-0 space-y-1">
				<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{tr('appTitle')}</h1>
				<p class="text-muted-foreground text-sm">{tr('appSubTitle')}</p>
			</div>

			<div class="grid w-full grid-cols-[minmax(0,1fr)_2.25rem_auto] items-center gap-2 md:flex md:w-auto">
				<a
					class="group relative inline-flex h-9 min-w-0 items-center justify-center gap-2 border border-primary bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
					href={`${IP_TOOLS_ORIGIN}/split-tunnel`}
					rel="noopener"
					target="_blank"
				>
					<Route class="size-4" strokeWidth={2} />
					<span class="truncate">{tr('ipRoutingCheck')}</span>
					<ExternalLink class="size-3.5 opacity-70" />
					<span
						class="absolute -right-px -top-2 border border-primary bg-[#ff5a36] px-1.5 py-px font-mono text-[9px] font-bold tracking-[0.12em] text-black"
					>
						NEW
					</span>
				</a>

				<a
					aria-label={tr('github')}
					class="inline-flex h-9 w-9 items-center justify-center gap-2 border text-sm font-medium transition-colors hover:bg-accent md:w-auto md:px-3"
					href="https://github.com/xxxbrian/Surge-Geosite"
					rel="noopener"
					target="_blank"
				>
					<svg class="size-4" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
						<path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.19 1.78 1.19 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.73 0-1.27.45-2.3 1.19-3.11-.12-.3-.52-1.48.11-3.08 0 0 .97-.31 3.16 1.19a10.9 10.9 0 0 1 5.76 0c2.2-1.5 3.16-1.19 3.16-1.19.63 1.6.23 2.78.11 3.08.74.81 1.19 1.84 1.19 3.11 0 4.45-2.7 5.43-5.28 5.72.42.36.79 1.07.79 2.16v3.2c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
					</svg>
					<span class="hidden lg:inline">{tr('github')}</span>
				</a>

				<div class="inline-flex h-9 overflow-hidden border">
					<a
						class={`inline-flex items-center px-3 text-sm font-medium transition-colors ${locale === 'zh' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
						href="/zh"
						data-sveltekit-preload-data="hover"
					>
						ZH
					</a>
					<a
						class={`inline-flex items-center border-l px-3 text-sm font-medium transition-colors ${locale === 'en' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
						href="/en"
						data-sveltekit-preload-data="hover"
					>
						EN
					</a>
				</div>
			</div>
		</div>
	</header>

	<section class="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[18rem_1fr]">
		<Card class="flex min-h-0 flex-col">
			<CardHeader class="pb-3">
				<div class="flex items-center justify-between">
					<CardTitle class="text-muted-foreground text-xs tracking-[0.14em]">{tr('datasets')}</CardTitle>
					<Badge variant="secondary">{listCount}</Badge>
				</div>
				<Input
					type="search"
					value={search}
					oninput={(event) => (search = (event.currentTarget as HTMLInputElement).value)}
					placeholder={tr('searchPlaceholder')}
				/>
			</CardHeader>
			<CardContent class="min-h-0 flex-1 pb-4">
				<div class="max-h-[38dvh] space-y-1 overflow-auto pr-2 lg:h-full lg:max-h-none">
					{#if isIndexLoading && names.length === 0}
						<div class="space-y-2">
							<Skeleton class="h-9 w-full" />
							<Skeleton class="h-9 w-full" />
							<Skeleton class="h-9 w-full" />
						</div>
					{:else if filteredNames.length === 0}
						<p class="text-muted-foreground px-2 py-3 text-xs">{tr('noMatch')}</p>
					{:else}
						{#each displayNames as name (name)}
							<button
								type="button"
								on:click={() => onSelectDataset(name)}
								class={`hover:border-border flex w-full items-center justify-between border px-3 py-2 text-left text-sm transition-colors ${
									selected === name ? 'border-primary text-primary bg-accent' : 'border-transparent'
								}`}
							>
								<span class="font-mono">{name}</span>
									<span class="text-muted-foreground font-mono text-xs">
										@{index[name] ? index[name].length : '-'}
									</span>
									</button>
								{/each}
						{#if browser && !hasFullIndex}
							<p class="text-muted-foreground px-2 py-3 text-xs">
								{tr('indexHydrating')}
							</p>
						{/if}
					{/if}
				</div>
			</CardContent>
		</Card>

		<Card class="flex min-h-0 flex-col">
			<CardHeader class="space-y-4">
				<div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
					<div>
						<p class="text-muted-foreground text-xs font-semibold tracking-[0.14em]">{tr('selectedDataset')}</p>
						<h2 class="mt-1 font-mono text-xl font-semibold">{selected ?? '-'}</h2>
					</div>

					<div class="grid w-full grid-cols-3 overflow-hidden border lg:inline-flex lg:w-auto">
						{#each MODES as item}
							<Button
								type="button"
								variant={mode === item ? 'default' : 'ghost'}
								size="sm"
								class="w-full rounded-none border-r last:border-r-0 lg:w-auto"
								onclick={() => onModeChange(item)}
							>
								{item}
							</Button>
						{/each}
					</div>
				</div>

				<div class="grid gap-3 md:grid-cols-[1fr_12rem_auto]">
					<label class="space-y-1">
						<span class="text-muted-foreground block text-xs font-semibold">{tr('filterTag')}</span>
						<select
							class="border-input bg-background h-9 w-full border px-3 text-sm"
							value={selectedFilter}
							on:change={(event) => onFilterChange((event.currentTarget as HTMLSelectElement).value)}
						>
							<option value={NONE_FILTER}>{tr('noneOption')}</option>
							{#each availableFilters as item}
								<option value={item}>{item}</option>
							{/each}
						</select>
					</label>

					<label class="space-y-1">
						<span class="text-muted-foreground block text-xs font-semibold">{tr('manualTag')}</span>
						<Input
							class="font-mono"
							placeholder={tr('manualTagPlaceholder')}
							value={manualFilter}
							oninput={(event) => onManualFilterInput((event.currentTarget as HTMLInputElement).value)}
						/>
					</label>

					<div class="flex items-end">
						<Button class="w-full" onclick={() => loadRules(liveFilter, true)} disabled={!selected || isRulesLoading}>
							{tr('loadRules')}
						</Button>
					</div>
				</div>

				<div class="text-muted-foreground grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
					<div>
						<span>{tr('upstreamEtag')} </span>
						<span class="font-mono">{etag}</span>
					</div>
					<div>
						<span>{tr('staleFallback')} </span>
						<span class="font-mono">{stale}</span>
					</div>
					<div>
						<span>{tr('mode')} </span>
						<span class="font-mono">{mode}</span>
					</div>
					<div>
						<span>{tr('rules')} </span>
						<span class="font-mono">{ruleLines}</span>
					</div>
				</div>
			</CardHeader>

			<CardContent class="grid min-h-0 flex-1 gap-4 pb-4 lg:grid-cols-[1fr_17rem]">
				<section class="flex min-h-0 flex-col gap-2">
					<div class="flex items-center justify-between">
						<h3 class="text-muted-foreground text-xs font-semibold tracking-[0.14em]">{tr('rulePreview')}</h3>
						<a class="text-primary text-xs font-semibold hover:underline" href={rawLink} target="_blank" rel="noreferrer">
							{tr('openRawUrl')}
						</a>
					</div>
					<pre class="border-input bg-muted/40 min-h-[14rem] max-h-[42dvh] overflow-auto border p-3 font-mono text-[12px] leading-5 lg:min-h-0 lg:max-h-none lg:flex-1">{previewText}</pre>
				</section>

				<aside class="min-h-0 space-y-3 overflow-auto lg:border-l lg:pl-3">
					{#if initError}
						<Alert variant="destructive">
							<AlertTitle>{tr('error')}</AlertTitle>
							<AlertDescription>{initError}</AlertDescription>
						</Alert>
					{/if}

					<section>
						<h4 class="text-muted-foreground mb-2 text-xs font-semibold tracking-[0.14em]">{tr('datasetInfo')}</h4>
						<div class="text-muted-foreground space-y-1 text-xs">
							<p>
								<span>{tr('filterCount')} </span>
								<span class="font-mono">{availableFilters.length}</span>
							</p>
						</div>
					</section>

					<Separator />

					<SidebarLinkGroup title={tr('quickLinks')} contentClass="divide-y">
						{#if quickLinks.length === 0}
							<p class="text-muted-foreground px-3 py-2.5">-</p>
						{:else}
							{#each quickLinks as item}
								<div class="group flex min-h-10 items-center pl-3 pr-1 transition-colors hover:bg-accent">
									<span class="min-w-0 flex-1 truncate font-mono font-medium">{item.mode}</span>
									<div class="flex shrink-0 items-center">
										<Button
											type="button"
											size="icon-sm"
											variant="ghost"
											class="text-muted-foreground h-8 w-8 shadow-none hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
											aria-label={`${copiedLinkKey === `quick:${item.mode}` ? tr('quickCopied') : tr('quickCopy')} ${item.mode}`}
											onclick={() => onCopyLink(`quick:${item.mode}`, item.href)}
										>
											{#if copiedLinkKey === `quick:${item.mode}`}
												<Check class="size-3.5" />
											{:else}
												<Copy class="size-3.5" />
											{/if}
										</Button>
										<Button
											href={item.href}
											target="_blank"
											rel="noopener"
											size="icon-sm"
											variant="ghost"
											class="text-muted-foreground h-8 w-8 shadow-none hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
											aria-label={`${tr('quickOpen')} ${item.mode}`}
										>
											<ExternalLink class="size-3.5" />
										</Button>
									</div>
								</div>
							{/each}
						{/if}
						{#if moreLinks.length === 0}
							<p class="text-muted-foreground px-3 py-2.5">-</p>
						{:else}
							{#each moreLinks as item}
								<div class="group flex min-h-10 items-center pl-3 pr-1 transition-colors hover:bg-accent">
									<span class="min-w-0 flex-1 truncate font-mono font-medium">{item.label}</span>
									<div class="flex shrink-0 items-center">
										<Button
											type="button"
											size="icon-sm"
											variant="ghost"
											class="text-muted-foreground h-8 w-8 shadow-none hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
											aria-label={`${copiedLinkKey === `more:${item.key}` ? tr('quickCopied') : tr('quickCopy')} ${item.label}`}
											onclick={() => onCopyLink(`more:${item.key}`, item.href)}
										>
											{#if copiedLinkKey === `more:${item.key}`}
												<Check class="size-3.5" />
											{:else}
												<Copy class="size-3.5" />
											{/if}
										</Button>
										<Button
											href={item.href}
											target="_blank"
											rel="noopener"
											size="icon-sm"
											variant="ghost"
											class="text-muted-foreground h-8 w-8 shadow-none hover:bg-primary hover:text-primary-foreground dark:hover:bg-primary dark:hover:text-primary-foreground"
											aria-label={`${tr('quickDownload')} ${item.label}`}
										>
											<Download class="size-3.5" />
										</Button>
									</div>
								</div>
							{/each}
						{/if}
					</SidebarLinkGroup>

					<SidebarLinkGroup title={tr('ipTools')} contentClass="divide-y">
						<a
							class="group flex min-h-10 min-w-0 items-center gap-2 px-3 font-mono transition-colors hover:bg-accent hover:text-accent-foreground"
							href={IP_TOOLS_ORIGIN}
							rel="noopener"
							target="_blank"
						>
							<LocateFixed class="text-muted-foreground size-3.5 group-hover:text-current" />
							<span class="min-w-0 flex-1 whitespace-nowrap">{tr('localIp')}</span>
						</a>
						<a
							class="group flex min-h-10 min-w-0 items-center gap-2 px-3 font-mono transition-colors hover:bg-accent hover:text-accent-foreground"
							href={`${IP_TOOLS_ORIGIN}/split-tunnel`}
							rel="noopener"
							target="_blank"
						>
							<Route class="text-muted-foreground size-3.5 group-hover:text-current" />
							<span class="min-w-0 flex-1 whitespace-nowrap">{tr('splitTunnel')}</span>
						</a>
						<a
							class="group flex min-h-10 min-w-0 items-center gap-2 px-3 font-mono transition-colors hover:bg-accent hover:text-accent-foreground"
							href={`${IP_TOOLS_ORIGIN}/multi`}
							rel="noopener"
							target="_blank"
						>
							<Network class="text-muted-foreground size-3.5 group-hover:text-current" />
							<span class="min-w-0 flex-1 whitespace-nowrap">{tr('multiEgress')}</span>
						</a>
						<a
							class="group flex min-h-10 min-w-0 items-center gap-2 px-3 font-mono transition-colors hover:bg-accent hover:text-accent-foreground"
							href={`${IP_TOOLS_ORIGIN}/cdn-node-lookup`}
							rel="noopener"
							target="_blank"
						>
							<Cloud class="text-muted-foreground size-3.5 group-hover:text-current" />
							<span class="min-w-0 flex-1 whitespace-nowrap">{tr('cdnNode')}</span>
						</a>
						<a
							class="group flex min-h-10 min-w-0 items-center gap-2 px-3 font-mono transition-colors hover:bg-accent hover:text-accent-foreground"
							href={`${IP_TOOLS_ORIGIN}/dns-exit-lookup`}
							rel="noopener"
							target="_blank"
						>
							<Waypoints class="text-muted-foreground size-3.5 group-hover:text-current" />
							<span class="min-w-0 flex-1 whitespace-nowrap">{tr('dnsExit')}</span>
						</a>
						<a
							class="group flex min-h-10 min-w-0 items-center gap-2 px-3 font-mono transition-colors hover:bg-accent hover:text-accent-foreground"
							href={`${IP_TOOLS_ORIGIN}/stun`}
							rel="noopener"
							target="_blank"
						>
							<RadioTower class="text-muted-foreground size-3.5 group-hover:text-current" />
							<span class="min-w-0 flex-1 whitespace-nowrap">{tr('webrtcUdp')}</span>
						</a>
					</SidebarLinkGroup>
				</aside>
				</CardContent>
			</Card>
		</section>
</main>
