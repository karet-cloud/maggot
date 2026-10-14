import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { ApiError, isTerminal } from "./lib/api.ts";
import { isServer } from "./lib/ssr.ts";
import { routeTree } from "./routeTree.gen";

/** How long fetched data (and a lasting error) counts as fresh. */
const STALE_MS = 10_000;

// Called once per server request (each render gets its own cache) and once in the browser.
export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: STALE_MS,
				// A server render doesn't retry: past its deadline, the browser picks the query up anyway.
				retry: (count, err) => !isServer && !isClientError(err) && count < 2,
				// A lasting error (a 404) is fresh for as long as data would be, so a server-rendered one shows
				// as it did on the server instead of loading again; past that, a page that mounts asks again.
				retryOnMount: (q) => !(q.state.status === "error" && isTerminal(q.state.error) && Date.now() - q.state.errorUpdatedAt < STALE_MS),
			},
		},
	});
	const router = createRouter({
		routeTree,
		context: { queryClient },
		defaultPreload: "intent",
		// Loaders only warm the query cache, which tracks freshness itself: run them on every preload.
		defaultPreloadStaleTime: 0,
		scrollRestoration: true,
	});
	// What the server fetched goes into the page, so the browser starts with it instead of fetching it
	// again, and lasting errors as ApiErrors (app/start.ts: nothing else about an error, such as a stack,
	// leaves the server). preload drops what's pending or failed transiently; the browser fetches whatever
	// wasn't sent, just as the server render showed it.
	setupRouterSsrQueryIntegration({
		router,
		queryClient,
		wrapQueryClient: false,
		dehydrateOptions: {
			shouldDehydrateQuery: (q) => q.state.status === "success" || (q.state.status === "error" && isTerminal(q.state.error)),
			shouldRedactErrors: (err) => !(err instanceof ApiError),
		},
	});
	return router;
}

function isClientError(err: unknown) {
	const status = (err as { status?: number }).status;
	return status !== undefined && status >= 400 && status < 500;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
