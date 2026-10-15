import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { api, keys } from "../lib/api.ts";
import { headSearch, ownerRepo, parseHead, sameRepo, type HeadSearch } from "../lib/pull-head.ts";

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

/**
 * Resolves a head from the URL (`repo` is `owner/name`; `fork` is set when that isn't `project`). An
 * `owner:` is looked up on the server, so big networks resolve too; `repo` is undefined while it loads,
 * and `problem` says when that owner has no readable repository in the network, or more than one.
 */
export function usePullHead(project: string, search: HeadSearch) {
	const { owner, branch } = parseHead(search.head);
	const byOwner = !search.headRepo && owner !== undefined;
	const candidates = useQuery({
		queryKey: keys.network(project, { owner }),
		queryFn: () => api.network(project, { owner }),
		enabled: byOwner,
		staleTime: 60_000,
	});
	const picked = byOwner && candidates.data ? ownerRepo(candidates.data) : {};
	const repo = search.headRepo ?? (byOwner ? picked.repo : project);
	return { repo, fork: repo && !sameRepo(repo, project) ? repo : undefined, branch, owner, problem: picked.problem, error: candidates.error };
}

/** Past this many, the head repository list gets its search (the server lists up to 100). */
const NETWORK_SEARCH_AT = 20;

/**
 * Picks where a pull request's changes come from: `project` or another repository in its fork network
 * that the caller can read, then a branch of it. Another repository starts on its own default branch.
 * Big networks get a search, done on the server, so no fork is out of reach.
 */
export function HeadPicker({
	project,
	repo,
	branch,
	onChange,
	branchesOnly,
}: {
	project: string;
	repo: string | undefined;
	branch: string | undefined;
	onChange: (head: HeadSearch) => void;
	branchesOnly?: boolean;
}) {
	const [q, setQ] = useState("");
	const query = useDeferredValue(q.trim());
	const network = useQuery({ queryKey: keys.network(project, { q: query }), queryFn: () => api.network(project, { q: query }), staleTime: 60_000, placeholderData: keepPreviousData });
	const repos = network.data ?? [];
	const crossRepo = Boolean(repo && !sameRepo(repo, project));
	const searching = Boolean(query) || repos.length >= NETWORK_SEARCH_AT;
	return (
		<>
			{searching && (
				<input
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Find a fork…"
					aria-label="Find a head repository"
					className="w-32 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none"
				/>
			)}
			{(repos.length > 1 || crossRepo || searching) && (
				<select
					value={repo ?? ""}
					aria-label="Head repository"
					onChange={(e) => {
						const next = repos.find((r) => r.fullName === e.target.value);
						if (next) onChange(headSearch(project, next.fullName, sameRepo(next.fullName, project) ? undefined : next.defaultBranch));
					}}
					className="max-w-72 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none"
				>
					{!repo && <option value="">…</option>}
					{repo && !repos.some((r) => r.fullName === repo) && <option value={repo}>{repo}</option>}
					{repos.map((r) => (
						<option key={r.fullName} value={r.fullName}>
							{r.fullName}
							{sameRepo(r.fullName, project) ? "" : r.visibility === "private" ? " (private)" : ""}
						</option>
					))}
				</select>
			)}
			{repo && (
				<BranchSelect
					project={repo}
					value={branch}
					onChange={(b) => onChange(headSearch(project, repo, b))}
					placeholder="Pick a branch"
					branchesOnly={branchesOnly || crossRepo}
				/>
			)}
		</>
	);
}

