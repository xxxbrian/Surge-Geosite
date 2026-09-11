// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			context?: {
				waitUntil(promise: Promise<unknown>): void;
			};
			env: {
				ASSETS: {
					fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
				};
				GEOSITE_API: {
					fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
				};
			};
		}
	}
}

export {};
