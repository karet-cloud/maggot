import type { MutationOptions, Query, QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The cache side of `useOptimistic` (./optimistic.ts), kept free of React and the toast UI so tests
 * can drive it with a real QueryClient.
 */

/** One cache edit: every cached query under `queryKey` (or exactly it) that has data. */
export interface Patch {
	queryKey: QueryKey;
	exact?: boolean;
	update: (old: any) => unknown;
}

/** A typed cache edit; `update` only sees queries that have data. */
export function patch<T>(queryKey: QueryKey, update: (old: T) => T, exact = false): Patch {
	return { queryKey, exact, update };
}

export const OPTIMISTIC_KEY = ["optimistic"];

/** One call of the burst, in the order the calls were made. `ok` is unset while it is pending. */
interface Entry {
	ok?: boolean;
}

/** A query some call of the burst edited: its data before the burst's first edit, and the edits since. */
interface Baseline {
	queryKey: QueryKey;
	data: unknown;
	steps: { entry: Entry; update: (old: any) => unknown }[];
	/** What the burst last wrote; anything else there means someone else (a refetch) wrote since. */
	written: unknown;
}

/** Calls in flight together: what they touched, what those queries held before, and each call's edits. */
interface Burst {
	touched: Map<string, { queryKey: QueryKey; exact: boolean }>;
	baselines: Map<string, Baseline>;
	entries: Entry[];
}
const bursts = new WeakMap<QueryClient, Burst>();
function burstOf(queryClient: QueryClient): Burst {
	let burst = bursts.get(queryClient);
	if (!burst) bursts.set(queryClient, (burst = { touched: new Map(), baselines: new Map(), entries: [] }));
	return burst;
}

/** Whether an optimistic call is still pending, so a refetch now could show data from before it. */
export const optimisticPending = (queryClient: QueryClient) => queryClient.isMutating({ mutationKey: OPTIMISTIC_KEY }) > 0;

/** Applies a call's patches, noting each edit against the query's burst baseline so it can be replayed. */
function applyPatches(queryClient: QueryClient, burst: Burst, entry: Entry, patches: Patch[]) {
	const cache = queryClient.getQueryCache();
	for (const p of patches) {
		for (const query of cache.findAll({ queryKey: p.queryKey, exact: p.exact }) as Query[]) {
			const old = query.state.data;
			if (old === undefined) continue;
			let baseline = burst.baselines.get(query.queryHash);
			if (!baseline) burst.baselines.set(query.queryHash, (baseline = { queryKey: query.queryKey, data: old, steps: [], written: old }));
			queryClient.setQueryData(query.queryKey, p.update(old));
			baseline.steps.push({ entry, update: p.update });
			baseline.written = query.state.data;
		}
	}
}

/**
 * Once the burst's last call settles: if any call failed, rebuild each edited query from its baseline
 * with only the successful calls' edits, in order, so the failed ones are undone even when the
 * refetch that follows fails too. A query the server already rewrote during the burst (a refetch
 * landed; rare, as live invalidations wait for `optimisticPending`) is left as it is: its data is
 * newer than the baseline, and the invalidation that follows corrects it.
 */
function reconcile(queryClient: QueryClient, burst: Burst) {
	if (burst.entries.every((e) => e.ok !== false)) return;
	const cache = queryClient.getQueryCache();
	for (const [hash, baseline] of burst.baselines) {
		const query = cache.get(hash);
		if (!query || query.state.data !== baseline.written) continue;
		let data = baseline.data;
		try {
			for (const step of baseline.steps) if (step.entry.ok) data = step.update(data);
		} catch (error) {
			// An edit that no longer fits: the data from before the burst is the safer guess.
			data = baseline.data;
			console.error(error);
		}
		queryClient.setQueryData(baseline.queryKey, data);
	}
}

export interface OptimisticOptions<TVars, TData> {
	mutationFn: (vars: TVars) => Promise<TData>;
	apply: (vars: TVars) => Patch[];
	/** More queries to refetch once it settles. */
	invalidate?: (vars: TVars) => QueryKey[];
	onSuccess?: (data: TData, vars: TVars) => void;
	onError?: (error: Error, vars: TVars) => void;
}

/**
 * Mutation options for an optimistic call. Calls share one scope, so requests go out one at a time
 * in the order they were made; the queries every overlapping call touched are rebuilt without the
 * failed calls' edits and refetched once the last of them settles.
 */
export function optimisticMutation<TVars, TData>(
	queryClient: QueryClient,
	options: OptimisticOptions<TVars, TData>,
): MutationOptions<TData, Error, TVars, { entry: Entry }> {
	return {
		mutationKey: OPTIMISTIC_KEY,
		scope: { id: "optimistic" },
		mutationFn: options.mutationFn,
		onMutate: async (vars: TVars) => {
			const burst = burstOf(queryClient);
			// Joined in call order, before the await, so edits replay in the order they were made.
			const entry: Entry = {};
			burst.entries.push(entry);
			const patches = options.apply(vars);
			for (const { queryKey, exact = false } of patches) burst.touched.set(JSON.stringify([queryKey, exact]), { queryKey, exact });
			for (const queryKey of options.invalidate?.(vars) ?? []) burst.touched.set(JSON.stringify([queryKey, false]), { queryKey, exact: false });
			await Promise.all(patches.map((p) => queryClient.cancelQueries({ queryKey: p.queryKey, exact: p.exact })));
			const snapshots = patches.flatMap((p) => queryClient.getQueriesData({ queryKey: p.queryKey, exact: p.exact }));
			const steps = new Map([...burst.baselines].map(([hash, b]) => [hash, b.steps.length]));
			try {
				applyPatches(queryClient, burst, entry, patches);
			} catch (error) {
				// A patch that didn't fit the cached shape: show the server's answer once it comes instead.
				for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
				for (const [hash, b] of burst.baselines) {
					if (b.steps.length === (steps.get(hash) ?? 0)) continue;
					b.steps.length = steps.get(hash) ?? 0;
					b.written = queryClient.getQueryCache().get(hash)?.state.data;
				}
				console.error(error);
			}
			return { entry };
		},
		onSuccess: (data, vars, context) => {
			if (context) context.entry.ok = true;
			options.onSuccess?.(data, vars);
		},
		onError: (error, vars, context) => {
			if (context) context.entry.ok = false;
			options.onError?.(error, vars);
		},
		onSettled: () => {
			// This call still counts as pending until its callbacks finish.
			if (queryClient.isMutating({ mutationKey: OPTIMISTIC_KEY }) > 1) return;
			const burst = burstOf(queryClient);
			bursts.delete(queryClient);
			// Alone, this puts back exactly what was there before the call (and works offline).
			reconcile(queryClient, burst);
			for (const filter of burst.touched.values()) void queryClient.invalidateQueries(filter);
		},
	};
}
