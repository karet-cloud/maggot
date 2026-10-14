import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useId } from "react";
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

/**
 * A mutation that shows its result before the server answers: `apply` edits the cache at once, a
 * failure puts it back and says so in a toast, and either way the touched queries refetch once the
 * last overlapping call settles (so a quick double toggle doesn't flicker through the first answer).
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
	const mutationKey = ["optimistic", useId()];
	return useMutation({
		mutationKey,
		mutationFn: options.mutationFn,
		onMutate: async (vars: TVars) => {
			const patches = options.apply(vars);
			await Promise.all(patches.map((p) => queryClient.cancelQueries({ queryKey: p.queryKey, exact: p.exact })));
			const snapshots = patches.flatMap((p) => queryClient.getQueriesData({ queryKey: p.queryKey, exact: p.exact }));
			for (const p of patches) queryClient.setQueriesData({ queryKey: p.queryKey, exact: p.exact }, (old: unknown) => (old === undefined ? old : p.update(old)));
			return { patches, snapshots };
		},
		onError: (error, vars, context) => {
			for (const [key, data] of context?.snapshots ?? []) queryClient.setQueryData(key, data);
			toast.error(`Couldn't ${options.action}: ${errorMessage(error)}`);
			options.onError?.(error, vars);
		},
		onSuccess: options.onSuccess,
		onSettled: (_data, _error, vars, context) => {
			if (queryClient.isMutating({ mutationKey }) > 1) return;
			for (const p of context?.patches ?? []) void queryClient.invalidateQueries({ queryKey: p.queryKey, exact: p.exact });
			for (const queryKey of options.invalidate?.(vars) ?? []) void queryClient.invalidateQueries({ queryKey });
		},
	});
}
