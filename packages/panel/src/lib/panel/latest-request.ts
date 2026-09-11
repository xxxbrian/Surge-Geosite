/** A request may update the UI only while it belongs to the current page state. */
export function createLatestRequest() {
	let current: AbortController | null = null;

	return {
		start() {
			current?.abort();
			const controller = new AbortController();
			current = controller;
			return {
				signal: controller.signal,
				isCurrent: () => current === controller && !controller.signal.aborted
			};
		},
		cancel() {
			current?.abort();
			current = null;
		}
	};
}
