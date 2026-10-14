import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, keys } from "../lib/api.ts";

/** Branch and agent-fork names without commit counts, for pickers. */
export const branchNamesQuery = (project: string) => queryOptions({ queryKey: [...keys.branches(project), "names"], queryFn: () => api.branches(project, false) });
export const tagNamesQuery = (project: string) => queryOptions({ queryKey: keys.tagNames(project), queryFn: () => api.tags(project, false), staleTime: 60_000 });

/**
 * Picks a branch of the project repo or a task fork (`task:<id>`). An unlisted value (a commit, or
 * a branch that no longer exists) stays selectable. `undefined` means the default branch, unless
 * `placeholder` is given.
 */
export function BranchSelect({
	project,
	value,
	onChange,
	branchesOnly,
	placeholder,
}: {
	project: string;
	value?: string;
	onChange: (ref?: string) => void;
	branchesOnly?: boolean;
	placeholder?: string;
}) {
	const refs = useQuery(branchNamesQuery(project));
	const tagList = useQuery({ ...tagNamesQuery(project), enabled: !branchesOnly });
	const tags = branchesOnly ? [] : (tagList.data ?? []);
	const defaultBranch = refs.data?.defaultBranch;
	const others = (refs.data?.branches ?? []).filter((b) => !b.default);
	const agents = branchesOnly ? [] : (refs.data?.agents ?? []);
	const listed = new Set<string | undefined>([defaultBranch, ...others.map((b) => b.name), ...agents.map((a) => a.name), ...tags.map((t) => `refs/tags/${t.name}`)]);
	const current = placeholder ? value : value === defaultBranch ? undefined : value;
	return (
		<select
			value={current ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
			className="max-w-72 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none"
		>
			{placeholder ? <option value="">{placeholder}</option> : <option value="">{defaultBranch ?? "…"} (default)</option>}
			{placeholder && defaultBranch && <option value={defaultBranch}>{defaultBranch} (default)</option>}
			{current && !listed.has(current) && <option value={current}>{/^[0-9a-f]{40}$/.test(current) ? `commit ${current.slice(0, 7)}` : current}</option>}
			{others.length > 0 && (
				<optgroup label="Branches">
					{others.map((b) => (
						<option key={b.name} value={b.name}>
							{b.name}
						</option>
					))}
				</optgroup>
			)}
			{tags.length > 0 && (
				<optgroup label="Tags">
					{tags.map((t) => (
						<option key={`tag:${t.name}`} value={`refs/tags/${t.name}`}>
							{t.name}
						</option>
					))}
				</optgroup>
			)}
			{agents.length > 0 && (
				<optgroup label="Agent forks">
					{agents.map((a) => (
						<option key={a.name} value={a.name}>
							{a.taskId} · {a.title.slice(0, 40)}
						</option>
					))}
				</optgroup>
			)}
		</select>
	);
}
