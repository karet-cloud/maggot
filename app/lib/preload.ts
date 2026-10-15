import type { FetchInfiniteQueryOptions, FetchQueryOptions, QueryClient } from "@tanstack/react-query";
import { sendable } from "./ssr-policy.ts";

type AnyOptions = FetchQueryOptions<any, any, any, any> | FetchInfiniteQueryOptions<any, any, any, any, any>;
export type PreloadOptions = AnyOptions | false | "" | null | undefined;

/** Skip costly queries on hover; mark them so server preloading also skips them. */
export const browserOnly = <T extends AnyOptions>(hover: boolean | undefined, options: T): T | false =>
	!hover && { ...options, meta: { ...options.meta, browserOnly: true } };

/** A server render doesn't start fetches it would throw away at its deadline this soon after. */
const MIN_SERVER_WAIT_MS = 50;

/** Shared loader implementation, with the request's server/deadline policy supplied by queries.ts. */
export function preloadQueries(queryClient: QueryClient, options: PreloadOptions[], server: boolean, waitMs: number): Promise<void> | undefined {
	const cache = queryClient.getQueryCache();
	const hashes = new Set<string>();
	const waits: Promise<unknown>[] = [];
	for (const o of options) {
		if (!o) continue;
		const defaults = queryClient.defaultQueryOptions(o as FetchQueryOptions);
		const cached = cache.get(defaults.queryHash);
		if (server) {
			hashes.add(defaults.queryHash);
			if (defaults.meta?.browserOnly || cached?.meta?.browserOnly) {
				if (cached) cache.remove(cached);
				continue;
			}
			if (waitMs < MIN_SERVER_WAIT_MS) continue;
		}
		// Hovers don't refetch cached data or errors; pages refresh stale data when they mount.
		if (cached?.state.data !== undefined || cached?.state.status === "error") continue;
		waits.push("initialPageParam" in o ? queryClient.prefetchInfiniteQuery(o as FetchInfiniteQueryOptions) : queryClient.prefetchQuery(o as FetchQueryOptions));
	}
	// Only sweep this loader's queries: other route loaders may still be fetching in parallel.
	const cleanup = () => {
		if (!server) return;
		for (const hash of hashes) {
			const query = cache.get(hash);
			if (query && !sendable(query)) cache.remove(query);
		}
	};
	if (!waits.length) {
		cleanup();
		return;
	}
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([Promise.all(waits), new Promise<void>((ok) => (timer = setTimeout(ok, waitMs)))]).then(() => {
		clearTimeout(timer);
		cleanup();
	});
}
