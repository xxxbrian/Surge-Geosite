import type { GeositeIndex } from './types';

const RETRY_DELAYS_MS = [400, 1200];

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, delay);
		function abort() {
			clearTimeout(timer);
			reject(signal.reason);
		}
		signal.addEventListener('abort', abort, { once: true });
	});
}

function parseIndex(value: unknown): GeositeIndex {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		!Object.values(value).every((tags) => Array.isArray(tags) && tags.every((tag) => typeof tag === 'string'))) {
		throw new Error('Invalid geosite index');
	}
	return value as GeositeIndex;
}

/** Retry transient startup/network failures, then let the user choose when to try again. */
export async function loadPanelIndex(fetchFn: typeof fetch, signal: AbortSignal): Promise<GeositeIndex> {
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		let response: Response | undefined;
		try {
			response = await fetchFn('/geosite', { headers: { accept: 'application/json' }, signal });
		} catch (error) {
			signal.throwIfAborted();
			if (attempt >= RETRY_DELAYS_MS.length) throw error;
		}
		if (response?.ok) return parseIndex(await response.json());
		const retryable = !response || response.status === 429 || response.status >= 500;
		if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
			throw new Error(`${response?.status} ${response?.statusText}`.trim());
		}
		await response?.body?.cancel();
		await waitForRetry(RETRY_DELAYS_MS[attempt], signal);
	}
}
