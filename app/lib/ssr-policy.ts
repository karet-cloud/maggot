// Which queries a server-rendered page carries. The render and the data sent with it must agree, or the
// browser's first render differs from the HTML (or keeps half a result as if it were whole), so the server
// drops everything else from its cache before rendering, and the browser fetches it instead.
import type { Query, QueryClient } from "@tanstack/react-query";
import { isTerminal } from "./api-error.ts";

/**
 * Whether a query goes into the page: settled (not fetching, so not a stream still arriving) with data
 * or a lasting error (a 404), and not marked `meta: { browserOnly: true }`. What's still loading, what
 * failed transiently (a 5xx, a rate limit) and what's browser-only are fetched by the browser.
 */
export function sendable(query: Query): boolean {
	if (query.meta?.browserOnly) return false;
	if (query.state.fetchStatus !== "idle") return false;
	return query.state.status === "success" || (query.state.status === "error" && isTerminal(query.state.error));
}

/** Removes (and cancels) everything not sendable from a server render's cache, before it dehydrates and renders. */
export function keepSendable(queryClient: QueryClient) {
	const cache = queryClient.getQueryCache();
	for (const query of cache.getAll()) if (!sendable(query)) cache.remove(query);
}
