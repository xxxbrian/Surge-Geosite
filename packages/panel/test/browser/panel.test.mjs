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


test('equivalent manual tags and overridden dropdown changes preserve the preview', { timeout: 30_000 }, async (t) => {
	const { page, base } = await openPanel(t);
	const manual = page.getByPlaceholder('例如 cn');
	await manual.fill('cn');
	await page.waitForFunction(() => document.querySelector('pre')?.textContent === 'DOMAIN-SUFFIX,cn.example.com\n');
	const before = await page.request.get(`${base}/__test/stats`).then((response) => response.json());
	for (const value of ['CN', ' cn ']) {
		await manual.fill(value);
		await page.waitForTimeout(350);
		assert.equal(await page.locator('pre').innerText(), 'DOMAIN-SUFFIX,cn.example.com\n');
	}
	await page.locator('select').selectOption('us');
	assert.equal(await page.locator('pre').innerText(), 'DOMAIN-SUFFIX,cn.example.com\n');
	const after = await page.request.get(`${base}/__test/stats`).then((response) => response.json());
	assert.equal(after.ruleCalls, before.ruleCalls);
});


for (const scenario of ['initial-error', 'hydrate-error']) {
	test(`${scenario} exposes a retry and recovers after the service returns`, { timeout: 30_000 }, async (t) => {
		const { page, base } = await openPanel(t, scenario);
		const retry = page.getByRole('button', { name: '重新加载数据集', exact: true });
		await retry.waitFor();
		if (scenario === 'hydrate-error') {
			assert.equal(await page.getByText('索引补全中...', { exact: true }).count(), 0);
			assert.equal(await page.getByText('索引补全失败，已保留现有数据。', { exact: true }).count(), 1);
		}
		await page.request.get(`${base}/__test/recover`);
		await retry.click();
		await page.getByRole('button', { name: /^test49 / }).waitFor();
		await page.waitForFunction(() => document.querySelector('pre')?.textContent === 'DOMAIN-SUFFIX,example.com\n');
		assert.equal(await page.getByText('索引补全中...', { exact: true }).count(), 0);
		assert.equal(await retry.count(), 0);
		await page.getByRole('button', { name: /^test49 / }).click();
		assert.deepEqual(await page.locator('select option').allTextContents(), ['(无)', 'cn', 'us']);
	});
}
