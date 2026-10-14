import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { isServer } from "./lib/ssr.ts";
import { routeTree } from "./routeTree.gen";

// Called once per server request (each render gets its own cache) and once in the browser.
export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			// A server render doesn't retry: past its deadline, the browser picks the query up anyway.
			queries: { staleTime: 10_000, retry: (count, err) => !isServer && !isClientError(err) && count < 2 },
		},
	});
	const router = createRouter({
		routeTree,
		context: { queryClient },
		defaultPreload: "intent",
		scrollRestoration: true,
	});
	// What the server fetched goes into the page, so the browser starts with it instead of fetching it
	// again; errors too, as ApiErrors (app/start.ts). Nothing's pending by then (preload drops what missed
	// the deadline), and the browser fetches whatever wasn't sent, just as the server render showed it.
	setupRouterSsrQueryIntegration({
		router,
		queryClient,
		wrapQueryClient: false,
		dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status !== "pending", shouldRedactErrors: () => false },
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
