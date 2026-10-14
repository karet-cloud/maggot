import { queryOptions, useQuery, type FetchInfiniteQueryOptions, type FetchQueryOptions, type QueryClient } from "@tanstack/react-query";
import { api, keys } from "./api.ts";

export const viewerQuery = queryOptions({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000 });
export const configQuery = queryOptions({ queryKey: keys.config, queryFn: api.config, staleTime: Infinity });
export const projectQuery = (project: string) => queryOptions({ queryKey: keys.project(project), queryFn: () => api.project(project) });
export const tasksQuery = (project: string) => queryOptions({ queryKey: keys.tasks(project), queryFn: () => api.tasks(project) });

export const useProjectTasks = (project: string) => useQuery(tasksQuery(project));

/** How long a navigation waits for data it has never fetched before rendering with spinners instead. */
const WAIT_MS = 300;

type AnyOptions = FetchQueryOptions<any, any, any, any> | FetchInfiniteQueryOptions<any, any, any, any, any>;

/**
 * Warms the cache for a route's queries from its loader, so hovering a link fetches the next page
 * and clicking it renders at once. Cached data (even stale) renders immediately and refreshes behind
 * it; uncached data holds the navigation for at most WAIT_MS. Never throws: the page shows errors.
 * The API is same-origin and cookie-authenticated, so this runs in the browser only.
 */
export function preload(queryClient: QueryClient, ...options: (AnyOptions | false | "" | null | undefined)[]): Promise<void> | undefined {
	if (typeof window === "undefined") return;
	const waits: Promise<unknown>[] = [];
	for (const o of options) {
		if (!o) continue;
		const cached = queryClient.getQueryData(o.queryKey) !== undefined;
		const fetch = "initialPageParam" in o ? queryClient.prefetchInfiniteQuery(o as FetchInfiniteQueryOptions) : queryClient.prefetchQuery(o as FetchQueryOptions);
		if (!cached) waits.push(fetch);
	}
	if (!waits.length) return;
	return Promise.race([Promise.all(waits), new Promise((ok) => setTimeout(ok, WAIT_MS))]).then(() => undefined);
}
