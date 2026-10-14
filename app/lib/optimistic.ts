import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { errorMessage } from "./format.ts";
import { toast } from "../components/toast.tsx";

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

const KEY = ["optimistic"];

/** Calls in flight together: what they touched, and whether one failed while others were pending. */
interface Burst {
	touched: Map<string, { queryKey: QueryKey; exact: boolean }>;
	failed: boolean;
}
const bursts = new WeakMap<QueryClient, Burst>();
function burstOf(queryClient: QueryClient): Burst {
	let burst = bursts.get(queryClient);
	if (!burst) bursts.set(queryClient, (burst = { touched: new Map(), failed: false }));
	return burst;
}

/** Whether an optimistic call is still pending, so a refetch now could show data from before it. */
export const optimisticPending = (queryClient: QueryClient) => queryClient.isMutating({ mutationKey: KEY }) > 0;

/**
 * A mutation that shows its result before the server answers: `apply` edits the cache at once and a
 * failure says so in a toast. Requests go out one at a time in the order they were made (a quick
 * star-unstar can't land reversed), and the queries every overlapping call touched refetch once the
 * last of them settles, so nothing refetches over an edit that is still pending.
 */
export function useOptimistic<TVars = void, TData = unknown>(options: {
	mutationFn: (vars: TVars) => Promise<TData>;
	apply: (vars: TVars) => Patch[];
	/** More queries to refetch once it settles. */
	invalidate?: (vars: TVars) => QueryKey[];
	onSuccess?: (data: TData, vars: TVars) => void;
	onError?: (error: Error, vars: TVars) => void;
	/** What failed, for the toast: "Couldn't <action>". */
	action: string;
}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: KEY,
		scope: { id: "optimistic" },
		mutationFn: options.mutationFn,
		onMutate: async (vars: TVars) => {
			const patches = options.apply(vars);
			const { touched } = burstOf(queryClient);
			for (const { queryKey, exact = false } of patches) touched.set(JSON.stringify([queryKey, exact]), { queryKey, exact });
			for (const queryKey of options.invalidate?.(vars) ?? []) touched.set(JSON.stringify([queryKey, false]), { queryKey, exact: false });
			await Promise.all(patches.map((p) => queryClient.cancelQueries({ queryKey: p.queryKey, exact: p.exact })));
			const snapshots = patches.flatMap((p) => queryClient.getQueriesData({ queryKey: p.queryKey, exact: p.exact }));
			try {
				for (const p of patches) queryClient.setQueriesData({ queryKey: p.queryKey, exact: p.exact }, (old: unknown) => (old === undefined ? old : p.update(old)));
			} catch (error) {
				// A patch that didn't fit the cached shape: show the server's answer once it comes instead.
				for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
				console.error(error);
			}
			return { snapshots };
		},
		onError: (error, vars, context) => {
			const burst = burstOf(queryClient);
			// Alone, the snapshot is exactly what to put back (and works offline). With other edits pending
			// it would undo theirs, or after an earlier failure bring that back, so the refetch restores it.
			if (queryClient.isMutating({ mutationKey: KEY }) === 1 && !burst.failed) {
				for (const [key, data] of context?.snapshots ?? []) queryClient.setQueryData(key, data);
			} else burst.failed = true;
			toast.error(`Couldn't ${options.action}: ${errorMessage(error)}`);
			options.onError?.(error, vars);
		},
		onSuccess: options.onSuccess,
		onSettled: () => {
			if (queryClient.isMutating({ mutationKey: KEY }) > 1) return;
			const { touched } = burstOf(queryClient);
			bursts.delete(queryClient);
			for (const filter of touched.values()) void queryClient.invalidateQueries(filter);
		},
	});
}
