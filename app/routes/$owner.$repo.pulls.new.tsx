import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";
import { CommitList } from "../components/commits.tsx";
import { DiffView } from "../components/diff.tsx";
import { MarkdownEditor } from "../components/markdown-editor.tsx";
import { BranchSelect } from "../components/refs.tsx";
import { Button, Empty, ErrorNote, Field, Input, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { preload, projectQuery } from "../lib/queries.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

type Search = { base?: string; head?: string; headRepo?: string };

const previewQuery = (project: string, base: string, head: string, headRepo?: string) =>
	queryOptions({ queryKey: [...keys.pulls(project), "preview", base, headRepo ?? "", head], queryFn: () => api.pullPreview(project, base, head, headRepo) });

// Open a pull request from a branch here, or from a branch of a fork (`headRepo` = owner/name).
export const Route = createFileRoute("/$owner/$repo/pulls/new")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		base: typeof s.base === "string" && s.base ? s.base : undefined,
		head: typeof s.head === "string" && s.head ? s.head : undefined,
		headRepo: typeof s.headRepo === "string" && s.headRepo ? s.headRepo : undefined,
	}),
	loaderDeps: ({ search }) => search,
	loader: ({ context, params, deps }) => {
		const project = `${params.owner}/${params.repo}`;
		// Without a base in the URL the preview is against the default branch, known once the project is cached.
		const base = deps.base ?? context.queryClient.getQueryData(projectQuery(project).queryKey)?.defaultBranch;
		return preload(context.queryClient, projectQuery(project), base && deps.head ? previewQuery(project, base, deps.head, deps.headRepo) : null);
	},
	component: NewPull,
});

function NewPull() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const queryClient = useQueryClient();
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const info = useQuery(projectQuery(project));
	const base = search.base ?? info.data?.defaultBranch;
	const head = search.head;
	// A fork's branches come from the fork; its own picker lists them.
	const headProject = search.headRepo ?? project;
	const preview = useQuery({ ...previewQuery(project, base ?? "", head ?? "", search.headRepo), enabled: Boolean(base && head) });
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	// The first commit's subject makes a good default title, as on GitHub.
	const first = preview.data?.commits.at(-1)?.message.split("\n")[0];
	useEffect(() => {
		if (first && !title) setTitle(preview.data?.commits.length === 1 ? first : (head ?? "").replace(/[-_/]+/g, " "));
	}, [first, head, preview.data?.commits.length, title]);
	const create = useMutation({
		mutationFn: () => api.createPull(project, { title: title.trim(), body, base: base as string, head: head as string, headRepo: search.headRepo }),
		onSuccess: (pull) => {
			void queryClient.invalidateQueries({ queryKey: keys.pulls(project) });
			void queryClient.invalidateQueries({ queryKey: keys.project(project) });
			void navigate({ to: "/$owner/$repo/pull/$number", params: { ...repoParams(project), number: String(pull.number) } });
		},
	});

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2 text-xs text-dim">
				<GitPullRequest className="size-4 text-faint" />
				<span>into</span>
				<BranchSelect project={project} value={base} onChange={(b) => void navigate({ search: { ...search, base: b } })} branchesOnly />
				<span>from</span>
				{search.headRepo && <span className="font-mono text-fg">{search.headRepo}:</span>}
				<BranchSelect project={headProject} value={head} onChange={(h) => void navigate({ search: { ...search, head: h } })} placeholder="Pick a branch" branchesOnly />
			</div>
			{!head && <Empty icon={<GitPullRequest className="size-6" />} title="Pick the branch with your changes" />}
			{preview.isPending && head && <Spinner />}
			<ErrorNote error={preview.error} />
			{preview.data &&
				(preview.data.commits.length === 0 ? (
					<Empty title="Nothing to merge">
						{head} has nothing that {base} doesn't.
					</Empty>
				) : (
					<>
						{viewer.data ? (
							<Panel title="Open a pull request">
								<form
									onSubmit={(e) => {
										e.preventDefault();
										create.mutate();
									}}
									className="space-y-3 p-4"
								>
									<Field label="Title">
										<Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={256} />
									</Field>
									<MarkdownEditor value={body} onChange={setBody} project={project} label="Description" placeholder="What does this change, and why? Fixes #12 closes issue 12 when it merges." rows={6} />
									{needsVerification && <p className="text-xs text-amber-200">Verify your email address before opening pull requests.</p>}
									<ErrorNote error={create.error} />
									<div className="flex justify-end">
										<Button type="submit" variant="primary" busy={create.isPending} disabled={!title.trim() || needsVerification}>
											<GitPullRequest className="size-4" />
											Open pull request
										</Button>
									</div>
								</form>
							</Panel>
						) : (
							<p className="text-sm text-dim">
								<Link to="/login" className="text-accent hover:underline">
									Sign in
								</Link>{" "}
								to open a pull request.
							</p>
						)}
						<Panel title={`${preview.data.commits.length}${preview.data.capped ? "+" : ""} ${preview.data.commits.length === 1 ? "commit" : "commits"}`}>
							<CommitList commits={preview.data.commits} project={headProject} />
						</Panel>
						<DiffView diff={preview.data.diff} project={headProject} viewRef={head} />
					</>
				))}
		</div>
	);
}
