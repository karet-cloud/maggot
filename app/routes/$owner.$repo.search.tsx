import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FileCode2, Search as SearchIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Empty, ErrorNote, Input, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { browserOnly, preload } from "../lib/queries.ts";

// Code search in the repository's default branch (indexed after each change to it).
export const Route = createFileRoute("/$owner/$repo/search")({
	validateSearch: (s: Record<string, unknown>): { q?: string } => ({ q: typeof s.q === "string" && s.q ? s.q : undefined }),
	loaderDeps: ({ search }) => ({ q: search.q }),
	loader: ({ context, params, deps }) => preload(context.queryClient, Boolean(deps.q) && browserOnly(false, searchQuery(`${params.owner}/${params.repo}`, deps.q as string))),
	component: CodeSearchPage,
});

const searchQuery = (project: string, q: string) => queryOptions({ queryKey: keys.search(project, q), queryFn: () => api.searchCode(project, q) });

function CodeSearchPage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { q = "" } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [text, setText] = useState(q);
	useEffect(() => setText(q), [q]);
	const search = useQuery({
		...searchQuery(project, q),
		enabled: q.length > 0,
		placeholderData: keepPreviousData,
		// While the index catches up, look again.
		refetchInterval: (query) => (query.state.data?.indexing ? 2000 : false),
	});
	// The last results stay up while the next search runs, but not once the box is cleared.
	const data = q ? search.data : undefined;
	return (
		<div className="space-y-3">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void navigate({ search: { q: text.trim() || undefined } });
				}}
				className="relative"
			>
				<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
				<Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search code on the default branch" className="pl-9 font-mono" autoFocus aria-label="Search code" />
			</form>
			{!q && <p className="text-xs text-dim">Matches any text of three or more characters in file contents, and shorter text in file names. Case doesn't matter.</p>}
			{q && search.isPending && <Spinner />}
			<ErrorNote error={search.error} />
			{data && (
				<p className="text-xs text-faint">
					{data.indexing
						? data.commit
							? "Updating the index to the latest commit; results may be slightly behind."
							: "Building the search index for the first time…"
						: `${data.results.length}${data.results.length === 50 ? "+" : ""} matching file${data.results.length === 1 ? "" : "s"}, of ${data.files} indexed`}
					{data.partial && " · Some files are too big or too many to index."}
				</p>
			)}
			{data && !data.indexing && data.results.length === 0 && q && (
				<Empty icon={<SearchIcon className="size-6" />} title="No matches">
					Nothing on the default branch contains “{q}”.
				</Empty>
			)}
			{data?.results.map((r) => (
				<Panel
					key={r.path}
					title={
						<Link
							to="/$owner/$repo"
							params={repoParams(project)}
							search={{ path: r.path.split("/").slice(0, -1).join("/") || undefined, file: r.path }}
							className="flex items-center gap-1.5 font-mono normal-case tracking-normal text-accent hover:underline"
						>
							<FileCode2 className="size-3.5" />
							{r.path}
						</Link>
					}
					actions={r.matches > r.lines.length ? <span className="text-[11px] text-faint">{r.matches} matching lines</span> : undefined}
				>
					{r.lines.length === 0 && <p className="px-4 py-2 text-xs text-faint">Matched by its path.</p>}
					{r.lines.length > 0 && (
						<table className="w-full font-mono text-[12px] leading-5">
							<tbody>
								{r.lines.map((l) => (
									<tr key={l.line} className="hover:bg-raised/60">
										<td className="w-px px-3 text-right align-top select-none">
											<Link
												to="/$owner/$repo"
												params={repoParams(project)}
												search={{ path: r.path.split("/").slice(0, -1).join("/") || undefined, file: r.path }}
												hash={`L${l.line}`}
												className="text-faint/70 hover:text-fg"
											>
												{l.line}
											</Link>
										</td>
										<td className="pr-4 whitespace-pre-wrap break-all text-fg/90">{highlight(l.text, q)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</Panel>
			))}
		</div>
	);
}

/** Marks every case-insensitive occurrence of `q` in `text`. */
function highlight(text: string, q: string): ReactNode[] {
	const out: ReactNode[] = [];
	const lower = text.toLowerCase();
	const needle = q.toLowerCase();
	let at = 0;
	for (let i = lower.indexOf(needle); i !== -1 && needle; i = lower.indexOf(needle, i + needle.length)) {
		out.push(text.slice(at, i), <mark key={i} className="rounded-sm bg-amber-400/25 text-amber-100">{text.slice(i, i + needle.length)}</mark>);
		at = i + needle.length;
	}
	out.push(text.slice(at));
	return out;
}
