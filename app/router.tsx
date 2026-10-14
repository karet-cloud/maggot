import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: 10_000, retry: (count, err) => !isClientError(err) && count < 2 } },
	});
	return createRouter({
		routeTree,
		context: { queryClient },
		defaultPreload: "intent",
		// Loaders only warm the query cache, which tracks freshness itself: run them on every preload.
		defaultPreloadStaleTime: 0,
		scrollRestoration: true,
	});
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
