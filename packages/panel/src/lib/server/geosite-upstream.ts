type GeositeServiceBinding = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type PlatformWithGeosite = {
	env?: {
		GEOSITE_API?: GeositeServiceBinding;
	};
};

function getGeositeServiceBinding(platform: unknown): GeositeServiceBinding | null {
	const candidate = (platform as PlatformWithGeosite | undefined)?.env?.GEOSITE_API;
	if (candidate && typeof candidate.fetch === 'function') {
		return candidate;
	}
	return null;
}

export async function fetchGeositeUpstream({
	request,
	url,
	platform
}: {
	request: Request;
	url: URL;
	platform: unknown;
}): Promise<Response> {
	const headers = new Headers({
		accept: request.headers.get('accept') ?? '*/*'
	});
	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch) {
		headers.set('if-none-match', ifNoneMatch);
	}

	const serviceBinding = getGeositeServiceBinding(platform);

	if (!serviceBinding) {
		throw new Error('Missing required Cloudflare service binding: GEOSITE_API');
	}

	const internalUrl = `https://geosite.internal${url.pathname}${url.search}`;
	return serviceBinding.fetch(internalUrl, {
		method: request.method,
		headers
	});
}

/** Preserve upstream cache semantics without buffering the rules payload. */
export async function proxyGeositeRequest(
	args: Parameters<typeof fetchGeositeUpstream>[0]
): Promise<Response> {
	const response = await fetchGeositeUpstream(args);
	const headers = new Headers();
	for (const key of [
		'content-type', 'cache-control', 'etag', 'x-upstream-etag', 'x-stale',
		'content-disposition', 'last-modified', 'vary', 'retry-after', 'allow'
	]) {
		const value = response.headers.get(key);
		if (value !== null) headers.set(key, value);
	}

	const hasNoBody = args.request.method === 'HEAD' || [204, 205, 304].includes(response.status);
	return new Response(hasNoBody ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
