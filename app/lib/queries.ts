import { queryOptions, useQuery, type DataTag, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { api, keys } from "./api.ts";
import { preloadQueries, type PreloadOptions } from "./preload.ts";
import { isServer, serverWaitMs } from "./ssr.ts";

export { browserOnly } from "./preload.ts";

export const viewerQuery = queryOptions({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000 });
export const configQuery = queryOptions({ queryKey: keys.config, queryFn: api.config, staleTime: Infinity });
export const projectQuery = (project: string) => queryOptions({ queryKey: keys.project(project), queryFn: () => api.project(project) });
export const tasksQuery = (project: string) => queryOptions({ queryKey: keys.tasks(project), queryFn: () => api.tasks(project) });

export const useProjectTasks = (project: string) => useQuery(tasksQuery(project));

/** How long a navigation waits for data it has never fetched before rendering with spinners instead. */
const WAIT_MS = 300;
/** The most of one file a server render reads; bigger (or binary) files load in the browser. */
export const SERVER_FILE_BYTES = 100 * 1024;

/** In a server render, forgets a fetched query too big to render and send with the page: the browser fetches it. */
export function dropIfTooBig<T>(queryClient: QueryClient, options: { queryKey: DataTag<QueryKey, T, any> }, tooBig: (data: T) => boolean) {
	const data = isServer ? queryClient.getQueryData(options.queryKey) : undefined;
	if (data !== undefined && tooBig(data as T)) queryClient.removeQueries({ queryKey: options.queryKey, exact: true });
}

/**
 * Fetches a route's queries from its loader. In the browser it warms the cache, so hovering a link
 * fetches the next page and clicking it renders at once: cached data (even stale) renders immediately
 * and refreshes behind it; uncached data holds the navigation for at most WAIT_MS. Never throws: the
 * page shows errors. Loaders leave out costly queries (diffs, file contents) when `preload` is set: a
 * hover isn't a visit.
 *
 * On the server it's the first paint: the render waits for these until the request's deadline
 * (app/server.ts), skipping browser-only ones. The page goes out with what's settled by then and the
 * browser fetches the rest (lib/ssr-policy.ts drops it before the render): what's still loading or
 * streaming and transient errors (a 5xx, a rate limit), while lasting errors (a 404) render as they will
 * in the browser. Nothing streams in after: a query that landed between the data sent with the page
 * and its render would hydrate differently.
 */
export function preload(queryClient: QueryClient, ...options: PreloadOptions[]): Promise<void> | undefined {
	return preloadQueries(queryClient, options, isServer, isServer ? serverWaitMs() : WAIT_MS);
}
