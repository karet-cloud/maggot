import { queryOptions, useQuery, type FetchInfiniteQueryOptions, type FetchQueryOptions, type QueryClient } from "@tanstack/react-query";
import { api, keys } from "./api.ts";
import { isServer, serverWaitMs } from "./ssr.ts";

export const viewerQuery = queryOptions({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000 });
export const configQuery = queryOptions({ queryKey: keys.config, queryFn: api.config, staleTime: Infinity });
export const projectQuery = (project: string) => queryOptions({ queryKey: keys.project(project), queryFn: () => api.project(project) });
export const tasksQuery = (project: string) => queryOptions({ queryKey: keys.tasks(project), queryFn: () => api.tasks(project) });

export const useProjectTasks = (project: string) => useQuery(tasksQuery(project));

/** How long a navigation waits for data it has never fetched before rendering with spinners instead. */
const WAIT_MS = 300;

/**
 * A diff worked out between two refs, which can be big and slow: not fetched on hover, nor by a server
 * render, which it would hold up and bloat. The browser fetches it once the page is up.
 */
export const diffQuery = <T>(hover: boolean | undefined, options: T): T | false => !hover && !isServer && options;

type AnyOptions = FetchQueryOptions<any, any, any, any> | FetchInfiniteQueryOptions<any, any, any, any, any>;

/**
 * Fetches a route's queries from its loader. In the browser it warms the cache, so hovering a link
 * fetches the next page and clicking it renders at once: cached data (even stale) renders immediately
 * and refreshes behind it; uncached data holds the navigation for at most WAIT_MS. On the server it's
 * the first paint: the render waits for these until the request's deadline (app/server.ts), and what's
 * still loading then is dropped, to be fetched by the browser (a query that landed between the data sent
 * with the page and its render would hydrate differently). Never throws: the page shows errors.
 * Loaders leave out costly queries (diffs, file contents) when `preload` is set: a hover isn't a visit.
 */
export function preload(queryClient: QueryClient, ...options: (AnyOptions | false | "" | null | undefined)[]): Promise<void> | undefined {
	const waits: Promise<unknown>[] = [];
	const fetched: AnyOptions[] = [];
	for (const o of options) {
		if (!o) continue;
		// Cached data (or a cached error, such as a person's profile asked for as an organization) is left
		// to the page, which refreshes what's stale when it mounts: hovers don't refetch it.
		const state = queryClient.getQueryState(o.queryKey);
		if (state?.data !== undefined || state?.status === "error") continue;
		fetched.push(o);
		waits.push("initialPageParam" in o ? queryClient.prefetchInfiniteQuery(o as FetchInfiniteQueryOptions) : queryClient.prefetchQuery(o as FetchQueryOptions));
	}
	if (!waits.length) return;
	const settled = Promise.all(waits);
	if (!isServer) return Promise.race([settled, new Promise((ok) => setTimeout(ok, WAIT_MS))]).then(() => undefined);
	return Promise.race([settled, new Promise((ok) => setTimeout(ok, serverWaitMs()))]).then(() => {
		for (const o of fetched) if (queryClient.getQueryState(o.queryKey)?.status === "pending") queryClient.removeQueries({ queryKey: o.queryKey, exact: true });
	});
}
