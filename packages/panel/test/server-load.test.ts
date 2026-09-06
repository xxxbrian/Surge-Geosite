import { beforeEach, expect, it, vi } from 'vitest';
import type { load as Load } from '../src/routes/[lang=locale]/+page.server';

beforeEach(() => vi.resetModules());

function event(fetch: typeof globalThis.fetch, waitUntil?: (task: Promise<unknown>) => void) {
	return {
		params: { lang: 'zh' }, fetch,
		platform: waitUntil ? { context: { waitUntil } } : undefined
	} as unknown as Parameters<typeof Load>[0];
}

function indexResponse(version: string, index = { aa: [] as string[] }) {
	return Response.json(index, { headers: { etag: `"index-${version}"`, 'x-upstream-etag': version } });
}

it('registers background revalidation and makes refreshed data available to subsequent pages', async () => {
	const { load } = await import('../src/routes/[lang=locale]/+page.server');
	let refresh!: (response: Response) => void;
	let indexCalls = 0;
	const fetch = vi.fn().mockImplementation((url: string) => {
		if (url !== '/geosite') return Promise.resolve(new Response('DOMAIN-SUFFIX,example.com'));
		if (++indexCalls === 1) return Promise.resolve(indexResponse('v1'));
		return new Promise<Response>((resolve) => { refresh = resolve; });
	});
	await load(event(fetch));
	const tasks: Promise<unknown>[] = [];
	const cached = await load(event(fetch, (task) => tasks.push(task)));
	expect(cached).toMatchObject({ names: ['aa'] });
	expect(tasks).toHaveLength(1);
	expect(fetch.mock.calls.find(([, init]) => init?.headers?.['if-none-match'])?.[1].headers['if-none-match']).toBe('"index-v1"');
	refresh(indexResponse('v2', { aa: ['cn'] }));
	await tasks[0];
	const updated = await load(event(fetch, () => {}));
	expect(updated).toMatchObject({ index: { aa: ['cn'] } });
});

it('awaits revalidation when there is no Cloudflare execution context', async () => {
	const { load } = await import('../src/routes/[lang=locale]/+page.server');
	let refresh!: (response: Response) => void;
	let indexCalls = 0;
	const fetch = vi.fn().mockImplementation((url: string) => {
		if (url !== '/geosite') return Promise.resolve(new Response('DOMAIN-SUFFIX,example.com'));
		if (++indexCalls === 1) return Promise.resolve(indexResponse('v1'));
		return new Promise<Response>((resolve) => { refresh = resolve; });
	});
	await load(event(fetch));
	let returned = false;
	const next = Promise.resolve(load(event(fetch))).then(() => { returned = true; });
	await Promise.resolve();
	expect(returned).toBe(false);
	refresh(new Response(null, { status: 304 }));
	await next;
	expect(returned).toBe(true);
});
