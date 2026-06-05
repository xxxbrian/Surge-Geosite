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
		headers
	});
}
