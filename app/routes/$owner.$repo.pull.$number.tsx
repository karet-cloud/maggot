import { queryOptions, useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, CircleAlert, FileDiff, GitCommitHorizontal, GitMerge, MessageSquare, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { CommitList } from "../components/commits.tsx";
import { DiffView, lineKey, type DiffNotes, type DiffSource } from "../components/diff.tsx";
import { Markdown } from "../components/markdown.tsx";
import { MarkdownEditor } from "../components/markdown-editor.tsx";
import { PullChecksBox, usePullChecks } from "../components/actions.tsx";
import { listPatches, openCountPatch, pendingComment, stateChange } from "../components/issues.tsx";
import { Decision, PullStateBadge } from "../components/pulls.tsx";
import { Button, cx, Empty, ErrorNote, Modal, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, diffs, keys, repoParams, type ComparisonMeta, type IssueComment, type IssueState, type MergeMethod, type Pull, type Review, type ReviewComment, type ReviewState } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import type { StreamedDiff } from "../lib/diff-stream.ts";
import { browserOnly, diffQuery, preload } from "../lib/queries.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

type Search = { tab?: "commits" | "files" };

const pullQuery = (project: string, number: number) => queryOptions({ queryKey: keys.pull(project, number), queryFn: () => api.pull(project, number) });
const pullDiff = (project: string, number: number): DiffSource => ({ key: keys.pullFiles(project, number), path: diffs.pullFiles(project, number) });
// Streamed: the commits (in the header) and the file list come at once, then each file as it's diffed.
const pullFilesQuery = (project: string, number: number) => diffQuery<ComparisonMeta>(keys.pullFiles(project, number), diffs.pullFiles(project, number));

export const Route = createFileRoute("/$owner/$repo/pull/$number")({
	validateSearch: (s: Record<string, unknown>): Search => (s.tab === "commits" || s.tab === "files" ? { tab: s.tab } : {}),
	loaderDeps: ({ search }) => ({ tab: search.tab }),
	// The full diff is costly to work out: a hover fetches it only for links to the Files tab, and only the browser does.
	loader: ({ context, params, deps }) => {
		const project = `${params.owner}/${params.repo}`;
		const number = Number(params.number);
		return Number.isInteger(number) ? preload(context.queryClient, pullQuery(project, number), deps.tab === "files" && browserOnly(false, pullFilesQuery(project, number))) : undefined;
	},
	component: PullPage,
});

function PullPage() {
	const { owner, repo, number: raw } = Route.useParams();
	const project = `${owner}/${repo}`;
	const number = Number(raw);
	const { tab } = Route.useSearch();
	const data = useQuery({ ...pullQuery(project, number), enabled: Number.isInteger(number) });
	const files = useQuery({ ...pullFilesQuery(project, number), enabled: Number.isInteger(number) });
	const comparison = files.data?.meta ?? null;

	if (data.isPending) return <Spinner />;
	if (data.error) {
		return data.error instanceof ApiError && data.error.status === 404 ? (
			<Empty title={`Pull request #${raw} doesn't exist`}>
				<Link to="/$owner/$repo/pulls" params={repoParams(project)} className="text-accent hover:underline">
					All pull requests
				</Link>
			</Empty>
		) : (
			<ErrorNote error={data.error} />
		);
	}
	const { pull } = data.data;
	const sub = (active: boolean) =>
		cx("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", active ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg");
	return (
		<div className="space-y-4">
			<header className="space-y-2">
				<h1 className="text-2xl font-semibold tracking-tight break-words">
					{pull.title} <span className="font-normal text-faint">#{pull.number}</span>
				</h1>
				<div className="flex flex-wrap items-center gap-2 text-sm text-dim">
					<PullStateBadge state={pull.pullState} />
					<span>
						<b className="font-medium text-fg">{pull.author ?? "A deleted account"}</b>{" "}
						{pull.mergedAt
							? "merged changes"
							: `${pull.state === "open" ? "wants to merge" : "proposed merging"} ${comparison ? `${comparison.commits.length}${comparison.capped ? "+" : ""} ${comparison.commits.length === 1 ? "commit" : "commits"}` : "changes"}`}{" "}
						into{" "}
						<code className="rounded bg-raised px-1.5 font-mono text-xs text-fg">{pull.base}</code> from{" "}
						<code className="rounded bg-raised px-1.5 font-mono text-xs text-fg">
							{pull.headRepo ? (pull.head ? `${pull.headRepo}:` : "a private fork") : ""}
							{pull.head}
						</code>
					</span>
					<Decision decision={pull.pullState === "open" ? pull.decision : null} />
				</div>
			</header>
			<nav className="flex gap-1 border-b border-line">
				<Link from={Route.fullPath} search={{}} className={sub(!tab)}>
					<MessageSquare className="size-3.5" />
					Conversation
				</Link>
				<Link from={Route.fullPath} search={{ tab: "commits" }} className={sub(tab === "commits")}>
					<GitCommitHorizontal className="size-3.5" />
					Commits {comparison && <span className="rounded-full bg-raised px-1.5 text-[11px] text-dim">{comparison.commits.length}</span>}
				</Link>
				<Link from={Route.fullPath} search={{ tab: "files" }} className={sub(tab === "files")}>
					<FileDiff className="size-3.5" />
					Files changed {comparison && <span className="rounded-full bg-raised px-1.5 text-[11px] text-dim">{files.data?.list.length}</span>}
				</Link>
			</nav>
			{!tab && <Conversation project={project} data={data.data} />}
			{tab === "commits" &&
				(files.isPending ? (
					<Spinner />
				) : !comparison ? (
					<ErrorNote error={files.error} />
				) : comparison.commits.length === 0 ? (
					<Empty title="No commits" />
				) : (
					<Panel>
						<CommitList commits={comparison.commits} project={!pull.mergedAt && pull.headRepo && !pull.headRepo.startsWith("(") ? pull.headRepo : project} />
					</Panel>
				))}
			{tab === "files" && <Files project={project} pull={pull} reviewComments={data.data.reviewComments} files={files} />}
		</div>
	);
}

type PullData = Awaited<ReturnType<typeof api.pull>>;

/** The description, then comments and reviews in order, then the merge box and a reply. */
function Conversation({ project, data }: { project: string; data: PullData }) {
	const { pull } = data;
	const queryClient = useQueryClient();
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const [reply, setReply] = useState("");
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: keys.pulls(project) });
		void queryClient.invalidateQueries({ queryKey: keys.project(project) });
	};
	// One request either way, as on issues.
	const comment = useOptimistic({
		mutationFn: async ({ body, state }: { body: string; state?: IssueState }) => {
			if (body.trim()) await api.comment(project, pull.number, body, state);
			else if (state) await api.updateIssue(project, pull.number, { state });
		},
		apply: ({ body, state }) => {
			const by = viewer.data?.username ?? null;
			const posted = body.trim() ? pendingComment(body, by) : null;
			const change = state ? { ...stateChange(state, by), pullState: state } : {};
			return [
				...openCountPatch(project, "openPulls", state),
				patch<PullData>(
					keys.pull(project, pull.number),
					(old) => ({
						...old,
						pull: { ...old.pull, ...change, comments: old.pull.comments + (posted ? 1 : 0) },
						comments: posted ? [...old.comments, posted] : old.comments,
					}),
					true,
				),
				...listPatches(keys.pulls(project), "pulls", pull.number, (row) => ({ ...change, comments: row.comments + (posted ? 1 : 0) })),
			];
		},
		// The draft comes back unless another has been started since.
		onError: (_error, { body }) => setReply((r) => r || body),
		action: "update the pull request",
	});
	const send = (toggle: boolean) => {
		comment.mutate({ body: reply, state: toggle ? (pull.state === "open" ? "closed" : "open") : undefined });
		setReply("");
	};
	const timeline = useMemo(() => {
		const items: { at: string; node: ReactNode }[] = [
			...data.comments.map((c) => ({ at: c.createdAt, node: <CommentCard key={`c${c.id}`} project={project} comment={c} /> })),
			...data.reviews.map((r) => ({
				at: r.createdAt,
				node: <ReviewCard key={`r${r.id}`} project={project} review={r} comments={data.reviewComments.filter((k) => k.reviewId === r.id)} />,
			})),
		];
		return items.sort((a, b) => a.at.localeCompare(b.at));
	}, [data, project]);
	return (
		<div className="max-w-4xl space-y-4">
			<Card author={pull.author} at={pull.createdAt}>
				{pull.body.trim() ? <Markdown source={pull.body} project={project} path="" /> : <p className="text-sm text-faint italic">No description.</p>}
			</Card>
			{data.earlier && <p className="text-center text-xs text-faint">Older comments aren't shown; the newest 100 are.</p>}
			{timeline.map((t) => t.node)}
			<MergeBox project={project} pull={pull} onDone={refresh} />
			{viewer.data && pull.pullState !== "merged" && (
				<div className="space-y-2">
					<MarkdownEditor value={reply} onChange={setReply} project={project} label="Comment" placeholder="Leave a comment" rows={4} />
					<div className="flex justify-end gap-2">
						{pull.canEdit && (
							<Button onClick={() => send(true)} disabled={needsVerification && Boolean(reply.trim())}>
								{pull.state === "open" ? "Close pull request" : "Reopen pull request"}
							</Button>
						)}
						<Button variant="primary" disabled={!reply.trim() || needsVerification} onClick={() => send(false)}>
							Comment
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function MergeBox({ project, pull, onDone }: { project: string; pull: Pull; onDone: () => void }) {
	const [method, setMethod] = useState<MergeMethod>("merge");
	// The head shown in Files changed is the one that merges; if the branch moved since, the merge stops.
	const files = useQuery({ ...pullFilesQuery(project, pull.number), enabled: pull.pullState === "open" });
	const merge = useMutation({ mutationFn: () => api.mergePull(project, pull.number, method, files.data?.meta?.head), onSuccess: onDone });
	// The server's own judgement of the checks (what a merge would get), so the two can't disagree.
	const checks = usePullChecks(project, pull.number, pull.pullState === "open");
	if (pull.pullState === "merged") {
		return (
			<div className="flex items-center gap-3 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-3 text-sm">
				<GitMerge className="size-5 text-violet-300" />
				<span>
					Merged by <b>{pull.mergedBy ?? "someone"}</b> {pull.mergedAt && <TimeAgo at={pull.mergedAt} />}
					{pull.mergeCommit && (
						<>
							{" "}
							as{" "}
							<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: pull.mergeCommit }} className="font-mono text-accent hover:underline">
								{pull.mergeCommit.slice(0, 7)}
							</Link>
						</>
					)}
				</span>
			</div>
		);
	}
	if (pull.pullState === "closed") return <p className="rounded-lg border border-line bg-panel px-4 py-3 text-sm text-dim">Closed without merging.</p>;
	const needsReview = pull.reviewRequired && pull.decision !== "approved";
	// Until they're loaded, required checks count as not passed. If they can't be loaded, the merge itself is still refused with the server's reason.
	const c = checks.data;
	const stale = c && files.data?.meta && c.head !== files.data.meta.head;
	const checksReason =
		pull.checksRequired && !checks.isError
			? !c
				? "Checking the required Actions runs…"
				: stale
					? `${pull.head} has new commits since this page loaded; reload to review them and see their checks.`
					: c.reason
			: null;
	const reasons = [
		needsReview && `${pull.base} is protected: someone who can merge has to approve, with no changes requested.`,
		checksReason && `${pull.base} requires Actions to pass. ${checksReason}`,
	].filter((r): r is string => Boolean(r));
	const blocked = reasons.length > 0;
	return (
		<div className="space-y-3">
			<PullChecksBox project={project} number={pull.number} checks={c} canApprove={pull.canMerge} />
			<div className={cx("space-y-3 rounded-lg border px-4 py-3", blocked ? "border-amber-400/30 bg-amber-400/5" : "border-emerald-500/30 bg-emerald-500/5")}>
				<div className="flex items-start gap-3 text-sm">
					{blocked ? <CircleAlert className="mt-0.5 size-5 text-amber-300" /> : <Check className="mt-0.5 size-5 text-emerald-300" />}
					<div>
						<p className="font-medium">
							{needsReview && checksReason
								? "An approving review and passing checks are required"
								: needsReview
									? "An approving review is required"
									: checksReason
										? "Required checks haven't passed"
										: pull.decision === "changes_requested"
											? "Changes were requested"
											: "Ready to merge"}
						</p>
						{blocked ? (
							reasons.map((r) => (
								<p key={r} className="text-xs text-dim">
									{r}
								</p>
							))
						) : (
							<p className="text-xs text-dim">Conflicts are found when merging; if there are any, nothing changes and the files are named.</p>
						)}
					</div>
				</div>
				{pull.canMerge && (
					<div className="flex flex-wrap items-center gap-2">
						<select
							value={method}
							onChange={(e) => setMethod(e.target.value as MergeMethod)}
							aria-label="Merge method"
							className="rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-fg"
						>
							<option value="merge">Create a merge commit</option>
							<option value="squash">Squash and merge</option>
						</select>
						<Button variant="primary" busy={merge.isPending} disabled={blocked} onClick={() => merge.mutate()}>
							<GitMerge className="size-4" />
							{method === "squash" ? "Squash and merge" : "Merge pull request"}
						</Button>
					</div>
				)}
				<ErrorNote error={merge.error} />
			</div>
		</div>
	);
}

function Card({ author, at, badge, children }: { author: string | null; at: string; badge?: ReactNode; children: ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg border border-line bg-panel">
			<div className="flex flex-wrap items-center gap-2 border-b border-line bg-raised/40 px-4 py-2 text-xs text-dim">
				<b className="font-medium text-fg">{author ?? "A deleted account"}</b>
				{badge}
				<TimeAgo at={at} />
			</div>
			<div className="space-y-2 px-4 py-3">{children}</div>
		</div>
	);
}

function CommentCard({ project, comment }: { project: string; comment: IssueComment }) {
	return (
		<Card author={comment.author} at={comment.createdAt}>
			<Markdown source={comment.body} project={project} path="" />
		</Card>
	);
}

const REVIEW_LABEL: Record<ReviewState, { text: string; tone: string }> = {
	approved: { text: "approved these changes", tone: "text-emerald-300" },
	changes_requested: { text: "requested changes", tone: "text-amber-300" },
	commented: { text: "reviewed", tone: "text-dim" },
};

function ReviewCard({ project, review, comments }: { project: string; review: Review; comments: ReviewComment[] }) {
	const label = REVIEW_LABEL[review.state];
	return (
		<Card author={review.author} at={review.createdAt} badge={<span className={label.tone}>{label.text}</span>}>
			{review.body && <Markdown source={review.body} project={project} path="" />}
			{comments.length > 0 && (
				<ul className="space-y-2">
					{comments.map((k) => (
						<li key={k.id} className="rounded-md border border-line bg-bg px-3 py-2">
							<p className="mb-1 font-mono text-[11px] text-faint">
								{k.path}:{k.side === "old" ? "−" : ""}
								{k.line}
							</p>
							<Markdown source={k.body} project={project} path="" />
						</li>
					))}
				</ul>
			)}
			{!review.body && comments.length === 0 && <p className="text-xs text-faint italic">No comment.</p>}
		</Card>
	);
}

interface Draft {
	path: string;
	side: "new" | "old";
	line: number;
	body: string;
}

/** The diff, with existing line comments, and a pending review built up line by line. */
function Files({ project, pull, reviewComments, files }: { project: string; pull: Pull; reviewComments: ReviewComment[]; files: UseQueryResult<StreamedDiff<ComparisonMeta>> }) {
	const viewer = useViewer();
	const queryClient = useQueryClient();
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [editing, setEditing] = useState<{ path: string; side: "new" | "old"; line: number } | null>(null);
	const [text, setText] = useState("");
	const [finishing, setFinishing] = useState(false);
	const canReview = Boolean(viewer.data) && pull.pullState === "open";

	const notes: DiffNotes = useMemo(() => {
		const under = new Map<string, ReactNode>();
		const byLine = new Map<string, ReactNode[]>();
		const add = (key: string, node: ReactNode) => byLine.set(key, [...(byLine.get(key) ?? []), node]);
		for (const k of reviewComments) {
			add(
				lineKey(k.path, k.side, k.line),
				<div key={k.id} className="rounded-md border border-line bg-panel px-3 py-2">
					<p className="mb-1 text-[11px] text-dim">
						<b className="text-fg">{k.author ?? "A deleted account"}</b> <TimeAgo at={k.createdAt} />
					</p>
					<Markdown source={k.body} project={project} path="" />
				</div>,
			);
		}
		drafts.forEach((d, i) =>
			add(
				lineKey(d.path, d.side, d.line),
				<div key={`draft${i}`} className="rounded-md border border-amber-400/40 bg-amber-400/5 px-3 py-2">
					<p className="mb-1 flex items-center justify-between text-[11px] text-amber-300">
						Pending
						<button type="button" onClick={() => setDrafts((all) => all.filter((x) => x !== d))} className="rounded p-0.5 text-faint hover:text-fg" aria-label="Discard this comment">
							<X className="size-3.5" />
						</button>
					</p>
					<Markdown source={d.body} project={project} path="" />
				</div>,
			),
		);
		if (editing) {
			add(
				lineKey(editing.path, editing.side, editing.line),
				<div key="editor" className="space-y-2">
					<MarkdownEditor value={text} onChange={setText} project={project} label="Line comment" rows={3} autoFocus />
					<div className="flex justify-end gap-2">
						<Button className="text-xs" onClick={() => setEditing(null)}>
							Cancel
						</Button>
						<Button
							variant="primary"
							className="text-xs"
							disabled={!text.trim()}
							onClick={() => {
								setDrafts((all) => [...all, { ...editing, body: text.trim() }]);
								setEditing(null);
								setText("");
							}}
						>
							Add to review
						</Button>
					</div>
				</div>,
			);
		}
		for (const [key, nodes] of byLine) under.set(key, <div className="space-y-2">{nodes}</div>);
		return {
			under,
			onAdd: canReview
				? (path, side, line) => {
						setEditing({ path, side, line });
						setText("");
					}
				: undefined,
		};
	}, [reviewComments, drafts, editing, text, canReview, project]);

	if (files.isPending) return <Spinner />;
	const head = files.data?.meta?.head;
	if (!files.data || !head) return <ErrorNote error={files.error} />;
	return (
		<div className="space-y-3">
			{canReview && (
				<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
					<span className="text-dim">Hover a line and press + to comment on it. {drafts.length > 0 && <b className="text-amber-300">{drafts.length} pending</b>}</span>
					<Button variant="primary" className="text-xs" onClick={() => setFinishing(true)}>
						Finish your review
					</Button>
				</div>
			)}
			<DiffView diff={files.data} source={pullDiff(project, pull.number)} project={!pull.mergedAt && pull.headRepo && !pull.headRepo.startsWith("(") ? pull.headRepo : project} viewRef={pull.mergedAt ? undefined : pull.head} notes={notes} error={files.error} onRetry={() => void files.refetch()} />
			<Modal open={finishing} onClose={() => setFinishing(false)} title="Finish your review">
				<FinishReview
					project={project}
					pull={pull}
					commit={head}
					drafts={drafts}
					onDone={() => {
						setFinishing(false);
						setDrafts([]);
						void queryClient.invalidateQueries({ queryKey: keys.pull(project, pull.number) });
						void queryClient.invalidateQueries({ queryKey: keys.pulls(project) });
					}}
				/>
			</Modal>
		</div>
	);
}

function FinishReview({ project, pull, commit, drafts, onDone }: { project: string; pull: Pull; commit: string; drafts: Draft[]; onDone: () => void }) {
	const viewer = useViewer();
	const [body, setBody] = useState("");
	const [state, setState] = useState<ReviewState>("commented");
	const mine = viewer.data?.username === pull.author;
	const submit = useMutation({
		mutationFn: () => api.review(project, pull.number, { state, body, commit, comments: drafts.map(({ path, side, line, body: text }) => ({ path, side, line, body: text })) }),
		onSuccess: onDone,
	});
	const option = (value: ReviewState, label: string, hint: string, disabled: boolean) => (
		<label className={cx("flex items-start gap-2 text-sm", disabled && "opacity-50")}>
			<input type="radio" className="mt-1" checked={state === value} onChange={() => setState(value)} disabled={disabled} />
			<span>
				{label}
				<span className="block text-[11px] text-faint">{hint}</span>
			</span>
		</label>
	);
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				submit.mutate();
			}}
			className="space-y-3"
		>
			<MarkdownEditor value={body} onChange={setBody} project={project} label="Review summary" placeholder="Overall thoughts (optional with line comments or an approval)" rows={4} />
			<fieldset className="space-y-2">
				{option("commented", "Comment", "Feedback without a verdict.", false)}
				{option("approved", "Approve", mine ? "You can't approve your own pull request." : "Only people who can merge can approve.", mine || !pull.canMerge)}
				{option("changes_requested", "Request changes", "Blocks merging into a branch that requires a review until it's approved.", mine || !pull.canMerge)}
			</fieldset>
			<p className="text-xs text-faint">{drafts.length === 1 ? "1 line comment" : `${drafts.length} line comments`} will be posted with it.</p>
			<ErrorNote error={submit.error} />
			<div className="flex justify-end">
				<Button type="submit" variant="primary" busy={submit.isPending}>
					Submit review
				</Button>
			</div>
		</form>
	);
}
