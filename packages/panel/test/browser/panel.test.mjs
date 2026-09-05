import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

// Use an existing Playwright installation; the application does not need a browser dependency.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function openPanel(t, scenario = 'normal') {
	const server = fork(new URL('./server.mjs', import.meta.url), [], {
		env: { ...process.env, PANEL_TEST_SCENARIO: scenario }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
	});
	let serverErrors = '';
	server.stderr.on('data', (chunk) => { serverErrors += chunk; });
	t.after(() => { server.kill(); });
	const [{ port }] = await Promise.race([
		once(server, 'message'),
		once(server, 'exit').then(() => { throw new Error(`Test server exited: ${serverErrors}`); })
	]);
	const base = `http://127.0.0.1:${port}`;
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	t.after(() => page.close());
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	t.after(() => assert.deepEqual(pageErrors, []));
	await page.goto(`${base}/zh`);
	await page.getByRole('heading', { name: 'Surge Geosite', exact: true }).waitFor();
	assert.equal(await page.title(), 'Surge Geosite Panel');
	return { page, base };
}

test('locale navigation ignores an older rules response', { timeout: 30_000 }, async (t) => {
	const { page } = await openPanel(t);
	let started;
	const received = new Promise((resolve) => { started = resolve; });
	let release;
	const response = new Promise((resolve) => { release = resolve; });
	let finished;
	const handled = new Promise((resolve) => { finished = resolve; });
	await page.route('**/geosite/strict/aa', async (route) => {
		started();
		await response;
		try { await route.fulfill({ status: 200, body: 'OLD STRICT RULES' }); } finally { finished(); }
	});
	await page.getByRole('button', { name: 'strict', exact: true }).click();
	await received;
	await page.getByRole('link', { name: 'EN', exact: true }).click();
	await page.waitForURL('**/en');
	release();
	await handled;
	await page.waitForTimeout(100);
	assert.equal(await page.locator('pre').innerText(), 'DOMAIN-SUFFIX,example.com\n');
	assert.match(await page.locator('body').innerText(), /mode: balanced/);
});
