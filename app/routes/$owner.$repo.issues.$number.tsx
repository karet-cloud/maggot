import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleCheck, CircleDot, Pencil, Tags, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { IssueStateBadge, Label, listPatches, openCountPatch, pendingComment, stateChange } from "../components/issues.tsx";
import { Markdown } from "../components/markdown.tsx";
import { MarkdownEditor } from "../components/markdown-editor.tsx";
import { Button, Empty, ErrorNote, Input, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, keys, repoParams, type Issue, type IssueComment, type IssueState, type IssueSummary } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { preload, projectQuery } from "../lib/queries.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

const issueQuery = (project: string, number: number) => queryOptions({ queryKey: keys.issue(project, number), queryFn: () => api.issue(project, number) });

type IssueData = Awaited<ReturnType<typeof api.issue>>;

/** Edits the issue's page and its row in every cached list. */
const issuePatches = (project: string, number: number, edit: (data: IssueData) => IssueData, row: (row: IssueSummary) => Partial<IssueSummary>) => [
	patch<IssueData>(keys.issue(project, number), edit, true),
	...listPatches(keys.issues(project), "issues", number, row),
];

export const Route = createFileRoute("/$owner/$repo/issues/$number")({
	loader: ({ context, params }) => {
		const project = `${params.owner}/${params.repo}`;
		const number = Number(params.number);
		return preload(context.queryClient, projectQuery(project), Number.isInteger(number) && issueQuery(project, number));
	},
	component: IssuePage,
});

function IssuePage() {
	const { owner, repo, number: raw } = Route.useParams();
	const project = `${owner}/${repo}`;
	const number = Number(raw);
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const info = useQuery(projectQuery(project));
	const data = useQuery({ ...issueQuery(project, number), enabled: Number.isInteger(number) });
	const [editingTitle, setEditingTitle] = useState<string | null>(null);
	const rename = useOptimistic({
		mutationFn: (title: string) => api.updateIssue(project, number, { title }),
		apply: (title) => issuePatches(project, number, (old) => ({ ...old, issue: { ...old.issue, title } }), () => ({ title })),
		onError: (_error, title) => setEditingTitle((t) => t ?? title),
		action: "rename the issue",
	});
	const [reply, setReply] = useState("");
	// One request either way, so a failure can't leave the comment posted and the state unchanged (and a retry post it twice).
	const comment = useOptimistic({
		mutationFn: async ({ body, state }: { body: string; state?: IssueState }) => {
			if (body.trim()) await api.comment(project, number, body, state);
			else if (state) await api.updateIssue(project, number, { state });
		},
		apply: ({ body, state }) => {
			const by = viewer.data?.username ?? null;
			const posted = body.trim() ? pendingComment(body, by) : null;
			const change = state ? { ...stateChange(state, by), closedByCommit: null } : {};
			return [
				...openCountPatch(project, "openIssues", state),
				...issuePatches(
					project,
					number,
					(old) => ({
						...old,
						issue: { ...old.issue, ...change, comments: old.issue.comments + (posted ? 1 : 0) },
						comments: posted ? [...old.comments, posted] : old.comments,
					}),
					(row) => ({ ...change, comments: row.comments + (posted ? 1 : 0) }),
				),
			];
		},
		// The draft comes back unless another has been started since.
		onError: (_error, { body }) => setReply((r) => r || body),
		action: "update the issue",
	});
	const send = (toggle: boolean) => {
		const state = toggle && data.data ? (data.data.issue.state === "open" ? "closed" : "open") : undefined;
		comment.mutate({ body: reply, state });
		setReply("");
	};
	// Comments before the newest page, loaded on request.
	const [earlier, setEarlier] = useState<IssueComment[]>([]);
	const [earlierMore, setEarlierMore] = useState(false);
	// Another issue: start from its newest comments.
	useEffect(() => {
		setEarlier([]);
		setEarlierMore(false);
	}, [number]);
	const loadEarlier = useMutation({
		mutationFn: () => {
			const first = earlier[0] ?? data.data?.comments[0];
			return api.earlierComments(project, number, first?.id ?? "");
		},
		onSuccess: (page) => {
			setEarlier((prev) => [...page.comments, ...prev]);
			setEarlierMore(page.earlier);
		},
	});

	if (data.isPending) return <Spinner />;
	if (data.error) {
		return data.error instanceof ApiError && data.error.status === 404 ? (
			<Empty title={`Issue #${raw} doesn't exist`}>
				<Link to="/$owner/$repo/issues" params={repoParams(project)} className="text-accent hover:underline">
					All issues
				</Link>
			</Empty>
		) : (
			<ErrorNote error={data.error} />
		);
	}
	const { issue } = data.data;
	const comments = [...earlier, ...data.data.comments];
	const moreEarlier = earlier.length > 0 ? earlierMore : data.data.earlier;
	const archived = Boolean(info.data?.repo.archivedAt);
	const canPost = Boolean(viewer.data) && !archived;

	return (
		<div className="space-y-4">
			<header className="space-y-2 border-b border-line pb-4">
				{editingTitle === null ? (
					<div className="flex flex-wrap items-start gap-3">
						<h1 className="min-w-0 flex-1 text-xl font-semibold break-words">
							{issue.title} <span className="font-normal text-faint">#{issue.number}</span>
						</h1>
						{issue.canEdit && !archived && (
							<Button className="text-xs" onClick={() => setEditingTitle(issue.title)}>
								<Pencil className="size-3.5" />
								Edit title
							</Button>
						)}
					</div>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							rename.mutate(editingTitle.trim());
							setEditingTitle(null);
						}}
						className="flex gap-2"
					>
						<Input value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)} maxLength={256} required autoFocus aria-label="Title" />
						<Button type="submit" variant="primary">
							Save
						</Button>
						<Button onClick={() => setEditingTitle(null)}>Cancel</Button>
					</form>
				)}
				<div className="flex flex-wrap items-center gap-2 text-sm text-dim">
					<IssueStateBadge state={issue.state} />
					<span>
						<b className="font-medium text-fg">{issue.author ?? "A deleted account"}</b> opened this <TimeAgo at={issue.createdAt} />
						{issue.state === "closed" && issue.closedAt && (
							<>
								{" "}
								· closed <TimeAgo at={issue.closedAt} />
								{issue.closedBy && ` by ${issue.closedBy}`}
								{issue.closedByCommit && (
									<>
										{" "}
										by commit{" "}
										<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: issue.closedByCommit }} className="font-mono text-accent hover:underline">
											{issue.closedByCommit.slice(0, 7)}
										</Link>
									</>
								)}
							</>
						)}{" "}
						· {issue.comments === 1 ? "1 comment" : `${issue.comments} comments`}
					</span>
				</div>
			</header>

			<div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px]">
				<div className="min-w-0 space-y-4">
					<Body project={project} issue={issue} archived={archived} />
					{moreEarlier && (
						<div className="text-center">
							<Button className="text-xs" busy={loadEarlier.isPending} onClick={() => loadEarlier.mutate()}>
								Load earlier comments
							</Button>
							<ErrorNote error={loadEarlier.error} />
						</div>
					)}
					{comments.map((c) => (
						<Comment key={c.id} project={project} number={number} comment={c} archived={archived} />
					))}
					{canPost ? (
						<div className="space-y-2">
							<MarkdownEditor value={reply} onChange={setReply} project={project} label="Comment" placeholder="Leave a comment" rows={5} />
							{needsVerification && <p className="text-xs text-amber-200">Verify your email address before commenting.</p>}
							<div className="flex justify-end gap-2">
								{issue.canEdit && (
									<Button onClick={() => send(true)} disabled={needsVerification && Boolean(reply.trim())}>
										{issue.state === "open" ? <CircleCheck className="size-4 text-violet-300" /> : <CircleDot className="size-4 text-emerald-300" />}
										{issue.state === "open" ? (reply.trim() ? "Close with comment" : "Close issue") : reply.trim() ? "Reopen with comment" : "Reopen issue"}
									</Button>
								)}
								<Button variant="primary" disabled={!reply.trim() || needsVerification} onClick={() => send(false)}>
									Comment
								</Button>
							</div>
						</div>
					) : (
						<p className="rounded-md border border-line bg-panel px-4 py-3 text-sm text-dim">
							{archived ? (
								"This repository is archived, so its issues are read-only."
							) : (
								<>
									<Link to="/login" className="text-accent hover:underline">
										Sign in
									</Link>{" "}
									to comment.
								</>
							)}
						</p>
					)}
				</div>
				<aside className="space-y-2">
					<Labels project={project} issue={issue} editable={issue.canLabel && !archived} />
				</aside>
			</div>
		</div>
	);
}

function Body({ project, issue, archived }: { project: string; issue: Issue; archived: boolean }) {
	const [draft, setDraft] = useState<string | null>(null);
	const save = useOptimistic({
		mutationFn: (body: string) => api.updateIssue(project, issue.number, { body }),
		apply: (body) => [patch<IssueData>(keys.issue(project, issue.number), (old) => ({ ...old, issue: { ...old.issue, body } }), true)],
		onError: (_error, body) => setDraft((d) => d ?? body),
		action: "save the description",
	});
	return (
		<Card
			author={issue.author}
			at={issue.createdAt}
			edited={null}
			actions={
				issue.canEdit && !archived && draft === null ? (
					<button type="button" onClick={() => setDraft(issue.body)} className="rounded p-1 text-faint hover:text-fg" aria-label="Edit the description">
						<Pencil className="size-3.5" />
					</button>
				) : null
			}
		>
			{draft !== null ? (
				<div className="space-y-2">
					<MarkdownEditor value={draft} onChange={setDraft} project={project} label="Description" autoFocus />
					<div className="flex justify-end gap-2">
						<Button onClick={() => setDraft(null)}>Cancel</Button>
						<Button
							variant="primary"
							onClick={() => {
								save.mutate(draft);
								setDraft(null);
							}}
						>
							Save
						</Button>
					</div>
				</div>
			) : issue.body.trim() ? (
				<Markdown source={issue.body} project={project} path="" />
			) : (
				<p className="text-sm text-faint italic">No description.</p>
			)}
		</Card>
	);
}

function Comment({ project, number, comment, archived }: { project: string; number: number; comment: IssueComment; archived: boolean }) {
	const viewer = useViewer();
	const [draft, setDraft] = useState<string | null>(null);
	const save = useOptimistic({
		mutationFn: (body: string) => api.editComment(project, number, comment.id, body),
		apply: (body) => [
			patch<IssueData>(
				keys.issue(project, number),
				(old) => ({ ...old, comments: old.comments.map((c) => (c.id === comment.id ? { ...c, body, updatedAt: new Date().toISOString() } : c)) }),
				true,
			),
		],
		onError: (_error, body) => setDraft((d) => d ?? body),
		action: "save the comment",
	});
	const remove = useOptimistic({
		mutationFn: () => api.deleteComment(project, number, comment.id),
		apply: () =>
			issuePatches(
				project,
				number,
				(old) => ({ ...old, issue: { ...old.issue, comments: old.issue.comments - 1 }, comments: old.comments.filter((c) => c.id !== comment.id) }),
				(row) => ({ comments: row.comments - 1 }),
			),
		action: "delete the comment",
	});
	const mine = viewer.data?.username === comment.author;
	return (
		<Card
			author={comment.author}
			at={comment.createdAt}
			edited={comment.updatedAt !== comment.createdAt ? comment.updatedAt : null}
			actions={
				comment.canEdit && !archived && draft === null ? (
					<span className="flex items-center gap-0.5">
						{mine && (
							<button type="button" onClick={() => setDraft(comment.body)} className="rounded p-1 text-faint hover:text-fg" aria-label="Edit comment">
								<Pencil className="size-3.5" />
							</button>
						)}
						<button
							type="button"
							onClick={() => confirm("Delete this comment?") && remove.mutate()}
							className="rounded p-1 text-faint hover:text-red-300"
							aria-label="Delete comment"
						>
							<Trash2 className="size-3.5" />
						</button>
					</span>
				) : null
			}
		>
			{draft !== null ? (
				<div className="space-y-2">
					<MarkdownEditor value={draft} onChange={setDraft} project={project} label="Comment" autoFocus rows={5} />
					<div className="flex justify-end gap-2">
						<Button onClick={() => setDraft(null)}>Cancel</Button>
						<Button
							variant="primary"
							disabled={!draft.trim()}
							onClick={() => {
								save.mutate(draft);
								setDraft(null);
							}}
						>
							Save
						</Button>
					</div>
				</div>
			) : (
				<Markdown source={comment.body} project={project} path="" />
			)}
		</Card>
	);
}

function Card({ author, at, edited, actions, children }: { author: string | null; at: string; edited: string | null; actions: ReactNode; children: ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg border border-line bg-panel">
			<div className="flex items-center gap-2 border-b border-line bg-raised/40 px-4 py-2 text-xs text-dim">
				<b className="font-medium text-fg">{author ?? "A deleted account"}</b>
				<TimeAgo at={at} />
				{edited && <span className="text-faint">· edited</span>}
				<span className="ml-auto">{actions}</span>
			</div>
			<div className="space-y-2 px-4 py-3">{children}</div>
		</div>
	);
}

function Labels({ project, issue, editable }: { project: string; issue: Issue; editable: boolean }) {
	const [draft, setDraft] = useState<string | null>(null);
	const save = useOptimistic({
		mutationFn: (labels: string[]) => api.updateIssue(project, issue.number, { labels }),
		apply: (labels) => issuePatches(project, issue.number, (old) => ({ ...old, issue: { ...old.issue, labels } }), () => ({ labels })),
		onError: (_error, labels) => setDraft((d) => d ?? labels.join(", ")),
		action: "save the labels",
	});
	return (
		<div className="space-y-2 border-b border-line pb-3">
			<div className="flex items-center justify-between text-xs font-medium text-dim">
				<span className="flex items-center gap-1.5">
					<Tags className="size-3.5" />
					Labels
				</span>
				{editable && draft === null && (
					<button type="button" onClick={() => setDraft(issue.labels.join(", "))} className="rounded p-1 text-faint hover:text-fg" aria-label="Edit labels">
						<Pencil className="size-3.5" />
					</button>
				)}
			</div>
			{draft !== null ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						save.mutate(draft.split(",").map((l) => l.trim()).filter(Boolean));
						setDraft(null);
					}}
					className="space-y-2"
				>
					<Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="bug, help wanted" aria-label="Labels, comma-separated" autoFocus />
					<div className="flex gap-2">
						<Button type="submit" variant="primary" className="text-xs">
							Save
						</Button>
						<Button className="text-xs" onClick={() => setDraft(null)}>
							Cancel
						</Button>
					</div>
				</form>
			) : issue.labels.length ? (
				<div className="flex flex-wrap gap-1">
					{issue.labels.map((l) => (
						<Link key={l} to="/$owner/$repo/issues" params={repoParams(project)} search={{ label: l, state: "all" }}>
							<Label name={l} />
						</Link>
					))}
				</div>
			) : (
				<p className="text-xs text-faint">None yet</p>
			)}
		</div>
	);
}
