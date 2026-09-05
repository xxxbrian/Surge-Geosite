import { describe, expect, it, vi } from 'vitest';
import { GET as indexGet } from '../src/routes/geosite/+server';
import { GET as rulesGet } from '../src/routes/geosite/[...rest]/+server';

function event(fetch: ReturnType<typeof vi.fn>, method = 'GET') {
	const request = new Request('https://panel.example/geosite/balanced/google?test=1', {
		method,
		headers: { accept: 'text/plain', 'if-none-match': '"v1"', cookie: 'private=value' }
	});
	return {
		request, url: new URL(request.url), platform: { env: { GEOSITE_API: { fetch } } }
	} as unknown as Parameters<typeof indexGet>[0];
}

describe.each([['index', indexGet], ['rules', rulesGet]] as const)('%s proxy', (_, GET) => {
	it.each([204, 205, 304])('preserves bodyless %i responses and validators', async (status) => {
		const fetch = vi.fn().mockResolvedValue(new Response(null, {
			status, headers: { etag: '"v1"', 'cache-control': 'max-age=60', 'x-stale': '1' }
		}));
		const response = await GET(event(fetch));
		expect(response.status).toBe(status);
		expect(response.body).toBeNull();
		expect(response.headers.get('etag')).toBe('"v1"');
		expect(response.headers.get('cache-control')).toBe('max-age=60');
		expect(response.headers.get('x-stale')).toBe('1');
	});

	it('returns a streaming response before the upstream body finishes', async () => {
		let finish!: () => void;
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('DOMAIN-SUFFIX,example.com\n'));
				finish = () => controller.close();
			}
		});
		const upstream = new Response(body, { headers: { 'content-type': 'text/plain', 'x-upstream-etag': 'v1' } });
		const fetch = vi.fn().mockResolvedValue(upstream);
		const response = await GET(event(fetch));
		expect(response.body).toBe(upstream.body);
		expect(response.headers.get('x-upstream-etag')).toBe('v1');
		finish();
		expect(await response.text()).toBe('DOMAIN-SUFFIX,example.com\n');
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('https://geosite.internal/geosite/balanced/google?test=1');
		expect(init.headers.get('if-none-match')).toBe('"v1"');
		expect(init.headers.get('cookie')).toBeNull();
	});

	it('forwards HEAD and error retry metadata', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response(null, {
			status: 503, headers: { 'retry-after': '10' }
		}));
		const response = await GET(event(fetch, 'HEAD'));
		expect(fetch.mock.calls[0][1].method).toBe('HEAD');
		expect(response.body).toBeNull();
		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('10');
	});
});
