import { afterEach, expect, it, vi } from 'vitest';
import { loadPanelIndex } from '../src/lib/panel/load-index';

afterEach(() => vi.useRealTimers());

it('recovers from startup and network failures with bounded retries', async () => {
	vi.useFakeTimers();
	const fetch = vi.fn()
		.mockResolvedValueOnce(new Response(null, { status: 503 }))
		.mockRejectedValueOnce(new TypeError('network unavailable'))
		.mockResolvedValueOnce(Response.json({ google: ['cn'] }));
	const result = loadPanelIndex(fetch, new AbortController().signal);
	await vi.runAllTimersAsync();
	expect(await result).toEqual({ google: ['cn'] });
	expect(fetch).toHaveBeenCalledTimes(3);
});

it('stops retrying and exposes the error after three failed attempts', async () => {
	vi.useFakeTimers();
	const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));
	const result = expect(loadPanelIndex(fetch, new AbortController().signal)).rejects.toThrow('503');
	await vi.runAllTimersAsync();
	await result;
	expect(fetch).toHaveBeenCalledTimes(3);
});

it('cancels scheduled retries when the page is replaced', async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
	const result = expect(loadPanelIndex(fetch, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	await vi.advanceTimersByTimeAsync(1);
	controller.abort();
	await result;
	await vi.runAllTimersAsync();
	expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects malformed indexes instead of rendering invalid tag values', async () => {
	const fetch = vi.fn().mockResolvedValue(Response.json({ google: 'cn' }));
	await expect(loadPanelIndex(fetch, new AbortController().signal)).rejects.toThrow('Invalid geosite index');
	expect(fetch).toHaveBeenCalledTimes(1);
});
