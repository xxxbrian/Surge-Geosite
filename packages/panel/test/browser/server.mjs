import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const panelRoot = fileURLToPath(new URL('../../', import.meta.url));
const { Server } = await import(new URL('../../.svelte-kit/output/server/index.js', import.meta.url));
const { manifest } = await import(new URL('../../.svelte-kit/output/server/manifest.js', import.meta.url));
const app = new Server(manifest);
await app.init({ env: {} });
const scenario = process.env.PANEL_TEST_SCENARIO ?? 'normal';
let failed = scenario !== 'normal';
let indexCalls = 0;
let ruleCalls = 0;
const index = { aa: ['cn', 'us'], ...Object.fromEntries(
	Array.from({ length: 50 }, (_, i) => [`test${String(i).padStart(2, '0')}`, ['cn', 'us']])
) };
const upstream = {
	async fetch(input, init) {
		const url = new URL(input);
		if (url.pathname === '/geosite') {
			indexCalls++;
			if (failed && (scenario === 'initial-error' || indexCalls > 1)) {
				return new Response('temporarily unavailable', { status: 503 });
			}
			if (new Headers(init?.headers).get('if-none-match') === '"index-v1"') {
				return new Response(null, { status: 304, headers: { etag: '"index-v1"' } });
			}
			return Response.json(index, { headers: { etag: '"index-v1"', 'x-upstream-etag': '"upstream-v1"' } });
		}
		ruleCalls++;
		return new Response(`DOMAIN-SUFFIX,${decodeURIComponent(url.pathname).includes('@cn') ? 'cn.' : ''}example.com\n`, {
			headers: { 'content-type': 'text/plain', 'x-upstream-etag': '"upstream-v1"' }
		});
	}
};
const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
		if (url.pathname === '/__test/recover') { failed = false; res.end('recovered'); return; }
		if (url.pathname === '/__test/stats') {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ indexCalls, ruleCalls }));
			return;
		}
		const assets = path.join(panelRoot, '.svelte-kit/output/client');
		const file = path.resolve(assets, `.${url.pathname}`);
		if (file.startsWith(`${assets}${path.sep}`) && fs.existsSync(file) && fs.statSync(file).isFile()) {
			const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
			res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
			res.end(fs.readFileSync(file));
			return;
		}
		const response = await app.respond(new Request(url, { method: req.method, headers: req.headers }), {
			getClientAddress: () => '127.0.0.1',
			platform: { env: { GEOSITE_API: upstream }, context: { waitUntil: (task) => void task.catch(console.error) } }
		});
		res.statusCode = response.status;
		for (const [key, value] of response.headers) res.setHeader(key, value);
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch (error) { console.error(error); res.statusCode = 500; res.end(String(error)); }
});
server.listen(0, '127.0.0.1', () => process.send?.({ port: server.address().port }));
