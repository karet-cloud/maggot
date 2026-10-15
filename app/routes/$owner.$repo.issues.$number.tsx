import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleCheck, CircleDot, Pencil, Tags, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { IssueStateBadge, Label } from "../components/issues.tsx";
import { Markdown } from "../components/markdown.tsx";
import { MarkdownEditor } from "../components/markdown-editor.tsx";
import { Button, Empty, ErrorNote, Input, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, keys, repoParams, type Issue, type IssueComment } from "../lib/api.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

export const Route = createFileRoute("/$owner/$repo/issues/$number")({ component: IssuePage });

function IssuePage() {
	const { owner, repo, number: raw } = Route.useParams();
	const project = `${owner}/${repo}`;
	const number = Number(raw);
	const queryClient = useQueryClient();
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const data = useQuery({ queryKey: keys.issue(project, number), queryFn: () => api.issue(project, number), enabled: Number.isInteger(number) });
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: keys.issues(project) });
		void queryClient.invalidateQueries({ queryKey: keys.project(project) });
	};
	const update = useMutation({
		mutationFn: (patch: Parameters<typeof api.updateIssue>[2]) => api.updateIssue(project, number, patch),
		onSuccess: refresh,
	});
	const [reply, setReply] = useState("");
	// One request either way, so a failure can't leave the comment posted and the state unchanged (and a retry post it twice).
	const comment = useMutation({
		mutationFn: async (toggle: boolean) => {
			const state = toggle && data.data ? (data.data.issue.state === "open" ? "closed" : "open") : undefined;
			if (reply.trim()) await api.comment(project, number, reply, state);
			else if (state) await api.updateIssue(project, number, { state });
		},
		onSuccess: () => {
			setReply("");
			refresh();
		},
	});
	const [editingTitle, setEditingTitle] = useState<string | null>(null);
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
						<h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight break-words">
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
							update.mutate({ title: editingTitle.trim() }, { onSuccess: () => setEditingTitle(null) });
						}}
						className="flex gap-2"
					>
						<Input value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)} maxLength={256} required autoFocus aria-label="Title" />
						<Button type="submit" variant="primary" busy={update.isPending}>
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
					<ErrorNote error={update.error} />
					{canPost ? (
						<div className="space-y-2">
							<MarkdownEditor value={reply} onChange={setReply} project={project} label="Comment" placeholder="Leave a comment" rows={5} />
							{needsVerification && <p className="text-xs text-amber-200">Verify your email address before commenting.</p>}
							<ErrorNote error={comment.error} />
							<div className="flex justify-end gap-2">
								{issue.canEdit && (
									<Button busy={comment.isPending && comment.variables === true} onClick={() => comment.mutate(true)} disabled={needsVerification && Boolean(reply.trim())}>
										{issue.state === "open" ? <CircleCheck className="size-4 text-violet-300" /> : <CircleDot className="size-4 text-emerald-300" />}
										{issue.state === "open" ? (reply.trim() ? "Close with comment" : "Close issue") : reply.trim() ? "Reopen with comment" : "Reopen issue"}
									</Button>
								)}
								<Button variant="primary" busy={comment.isPending && comment.variables === false} disabled={!reply.trim() || needsVerification} onClick={() => comment.mutate(false)}>
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
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: () => api.updateIssue(project, issue.number, { body: draft ?? "" }),
		onSuccess: () => {
			setDraft(null);
			void queryClient.invalidateQueries({ queryKey: keys.issue(project, issue.number) });
		},
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
					<ErrorNote error={save.error} />
					<div className="flex justify-end gap-2">
						<Button onClick={() => setDraft(null)}>Cancel</Button>
						<Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
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
	const queryClient = useQueryClient();
	const viewer = useViewer();
	const [draft, setDraft] = useState<string | null>(null);
	const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.issue(project, number) });
	const save = useMutation({
		mutationFn: () => api.editComment(project, number, comment.id, draft ?? ""),
		onSuccess: () => {
			setDraft(null);
			refresh();
		},
	});
	const remove = useMutation({ mutationFn: () => api.deleteComment(project, number, comment.id), onSuccess: refresh });
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
					<ErrorNote error={save.error} />
					<div className="flex justify-end gap-2">
						<Button onClick={() => setDraft(null)}>Cancel</Button>
						<Button variant="primary" busy={save.isPending} disabled={!draft.trim()} onClick={() => save.mutate()}>
							Save
						</Button>
					</div>
				</div>
			) : (
				<Markdown source={comment.body} project={project} path="" />
			)}
			<ErrorNote error={remove.error} />
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
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: () => api.updateIssue(project, issue.number, { labels: (draft ?? "").split(",").map((l) => l.trim()).filter(Boolean) }),
		onSuccess: () => {
			setDraft(null);
			void queryClient.invalidateQueries({ queryKey: keys.issues(project) });
		},
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
						save.mutate();
					}}
					className="space-y-2"
				>
					<Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="bug, help wanted" aria-label="Labels, comma-separated" autoFocus />
					<ErrorNote error={save.error} />
					<div className="flex gap-2">
						<Button type="submit" variant="primary" className="text-xs" busy={save.isPending}>
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
