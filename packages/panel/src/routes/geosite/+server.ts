import type { RequestHandler } from './$types';
import { proxyGeositeRequest } from '$lib/server/geosite-upstream';

export const GET: RequestHandler = ({ request, url, platform }) =>
	proxyGeositeRequest({ request, url, platform });
