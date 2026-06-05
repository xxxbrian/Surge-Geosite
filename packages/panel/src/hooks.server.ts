import type { Handle } from '@sveltejs/kit';

type Locale = 'zh' | 'en';

function detectLangFromAcceptLanguage(acceptLanguage: string | null): Locale {
	if (!acceptLanguage) {
		return 'zh';
	}

	return acceptLanguage.toLowerCase().includes('zh') ? 'zh' : 'en';
}

function detectLangFromPath(pathname: string): Locale | null {
	if (pathname === '/zh' || pathname.startsWith('/zh/')) {
		return 'zh';
	}

	if (pathname === '/en' || pathname.startsWith('/en/')) {
		return 'en';
	}

	return null;
}

function shouldAdvertiseLlms(pathname: string, response: Response): boolean {
	if (pathname === '/llms.txt' || pathname === '/llms-full.txt' || pathname.startsWith('/geosite')) {
		return false;
	}

	const contentType = response.headers.get('content-type') ?? '';
	return response.status >= 300 && response.status < 400 || contentType.includes('text/html');
}

function buildLlmsLinkHeader(origin: string): string {
	return `<${origin}/llms.txt>; rel="llms.txt"; type="text/markdown", <${origin}/llms-full.txt>; rel="llms-full.txt"; type="text/markdown"`;
}

export const handle: Handle = async ({ event, resolve }) => {
	const lang =
		detectLangFromPath(event.url.pathname) ??
		detectLangFromAcceptLanguage(event.request.headers.get('accept-language'));

	const response = await resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%lang%', lang)
	});

	if (shouldAdvertiseLlms(event.url.pathname, response)) {
		response.headers.append('link', buildLlmsLinkHeader(event.url.origin));
		response.headers.set('x-llms-txt', `${event.url.origin}/llms.txt`);
	}

	return response;
};
