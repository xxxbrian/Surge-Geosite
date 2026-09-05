import { expect, it } from 'vitest';
import { createLatestRequest } from '../src/lib/panel/latest-request';

it('ignores a delayed response after navigation even if the fetch ignores abort', async () => {
	const requests = createLatestRequest();
	let finish!: (body: string) => void;
	let preview = 'loading';
	const request = requests.start();
	const response = new Promise<string>((resolve) => { finish = resolve; });
	const update = response.then((body) => { if (request.isCurrent()) preview = body; });
	requests.cancel();
	preview = 'new page balanced rules';
	finish('old page strict rules');
	await update;
	expect(request.signal.aborted).toBe(true);
	expect(preview).toBe('new page balanced rules');
});

it('supersedes older requests and accepts the next request after cancellation', () => {
	const requests = createLatestRequest();
	const old = requests.start();
	const current = requests.start();
	expect(old.signal.aborted).toBe(true);
	expect(old.isCurrent()).toBe(false);
	expect(current.isCurrent()).toBe(true);
	requests.cancel();
	expect(current.isCurrent()).toBe(false);
	expect(requests.start().isCurrent()).toBe(true);
});
