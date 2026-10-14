import { useQuery } from "@tanstack/react-query";
import { api, keys, type RepoInfo } from "../lib/api.ts";

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
	const refs = useQuery({ queryKey: [...keys.branches(project), "names"], queryFn: () => api.branches(project, false) });
	const tagList = useQuery({ queryKey: keys.tagNames(project), queryFn: () => api.tags(project, false), enabled: !branchesOnly, staleTime: 60_000 });
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

/** A pull request's head as a URL gives it: `head` is a branch here, `owner:branch` (GitHub's syntax), or a branch of `headRepo`. */
export interface HeadSearch {
	head?: string;
	headRepo?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ownerOf = (repo: string) => repo.split("/")[0].toLowerCase();

/**
 * Resolves a head from the URL against `project`'s fork network (`repo` is `owner/name`; `fork` is set when
 * that isn't `project`). `repo` is undefined while the network loads; `unknown` is an `owner:` with nothing
 * in the network the caller can read.
 */
export function usePullHead(project: string, search: HeadSearch) {
	const network = useQuery({ queryKey: keys.network(project), queryFn: () => api.network(project), staleTime: 60_000 });
	const colon = search.head?.indexOf(":") ?? -1;
	const owner = colon >= 0 ? search.head?.slice(0, colon).toLowerCase() : undefined;
	const branch = (colon >= 0 ? search.head?.slice(colon + 1) : search.head) || undefined;
	let repo: string | undefined = search.headRepo ?? project;
	if (!search.headRepo && owner && owner !== ownerOf(project)) repo = network.data?.find((r) => r.owner.toLowerCase() === owner)?.fullName;
	return {
		repo,
		fork: repo && !same(repo, project) ? repo : undefined,
		branch,
		unknown: !repo && network.data ? owner : undefined,
		network: network.data ?? [],
		error: network.error,
	};
}

/** The URL for a head: `branch` here, `owner:branch` when that owner has one repository in the network, else `headRepo` too. */
export function headSearch(project: string, network: RepoInfo[], repo: string, branch: string | undefined): HeadSearch {
	if (same(repo, project)) return { head: branch, headRepo: undefined };
	const owner = ownerOf(repo);
	const unique = owner !== ownerOf(project) && network.filter((r) => r.owner.toLowerCase() === owner).length === 1;
	return unique ? { head: `${repo.split("/")[0]}:${branch ?? ""}`, headRepo: undefined } : { head: branch, headRepo: repo };
}

/**
 * Picks where a pull request's changes come from: `project` or another repository in its fork network
 * that the caller can read, then a branch of it. Another repository starts on its own default branch.
 */
export function HeadPicker({
	project,
	network,
	repo,
	branch,
	onChange,
	branchesOnly,
}: {
	project: string;
	network: RepoInfo[];
	repo: string | undefined;
	branch: string | undefined;
	onChange: (head: HeadSearch) => void;
	branchesOnly?: boolean;
}) {
	const crossRepo = Boolean(repo && !same(repo, project));
	return (
		<>
			{(network.length > 1 || crossRepo) && (
				<select
					value={repo ?? ""}
					aria-label="Head repository"
					onChange={(e) => {
						const next = network.find((r) => r.fullName === e.target.value);
						if (next) onChange(headSearch(project, network, next.fullName, same(next.fullName, project) ? undefined : next.defaultBranch));
					}}
					className="max-w-72 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none"
				>
					{!repo && <option value="">…</option>}
					{repo && !network.some((r) => r.fullName === repo) && <option value={repo}>{repo}</option>}
					{network.map((r) => (
						<option key={r.fullName} value={r.fullName}>
							{r.fullName}
							{same(r.fullName, project) ? "" : r.visibility === "private" ? " (private)" : ""}
						</option>
					))}
				</select>
			)}
			{repo && (
				<BranchSelect
					project={repo}
					value={branch}
					onChange={(b) => onChange(headSearch(project, network, repo, b))}
					placeholder="Pick a branch"
					branchesOnly={branchesOnly || crossRepo}
				/>
			)}
		</>
	);
}
