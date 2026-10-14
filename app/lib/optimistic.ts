import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "./format.ts";
import { toast } from "../components/toast.tsx";
import { optimisticMutation, type OptimisticOptions } from "./optimistic-cache.ts";

export { optimisticPending, patch, type Patch } from "./optimistic-cache.ts";

/**
 * A mutation that shows its result before the server answers: `apply` edits the cache at once and a
 * failure says so in a toast. Requests go out one at a time in the order they were made (a quick
 * star-unstar can't land reversed). Once the last of the overlapping calls settles, the queries they
 * edited are rebuilt without the failed calls' edits (so a failure is undone even offline) and
 * refetched, so nothing refetches over an edit that is still pending.
 */
export function useOptimistic<TVars = void, TData = unknown>(
	options: OptimisticOptions<TVars, TData> & {
		/** What failed, for the toast: "Couldn't <action>". */
		action: string;
	},
) {
	const queryClient = useQueryClient();
	return useMutation(
		optimisticMutation<TVars, TData>(queryClient, {
			...options,
			onError: (error, vars) => {
				toast.error(`Couldn't ${options.action}: ${errorMessage(error)}`);
				options.onError?.(error, vars);
			},
		}),
	);
}
