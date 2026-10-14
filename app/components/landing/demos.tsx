import { Link } from "@tanstack/react-router";
import { CircleDot, FileCode2, Folder, GitBranch, GitCommitHorizontal, GitPullRequest, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { CommitList } from "../commits.tsx";
import { DiffView, lineKey, type DiffNotes } from "../diff.tsx";
import { IssueStateBadge, IssueStateIcon, Label } from "../issues.tsx";
import { MarkdownEditor } from "../markdown-editor.tsx";
import { Markdown } from "../markdown.tsx";
import { Decision, PullStateBadge } from "../pulls.tsx";
import { Button, cx, Panel } from "../ui.tsx";
import { LINUX_ROOT, LINUX_README, LINUX_COMMITS, LINUX_DIFF, LINUX_PATCH_SOURCE } from "./linux-cache.ts";

/*
 * Working demos for the landing pages, assembled from the app's own components (Panel, Markdown,
 * DiffView, MarkdownEditor, CommitList, the pull request badges) over static data. They behave like
 * the real pages: files open, lines select, diffs switch layout, comments get drafted.
 */

const PROJECT = "maggot-mirror/linux";
const PARAMS = { owner: "maggot-mirror", repo: "linux" };

/** Cached root listing: every click navigates to the real repository page. */
function CodeView() {
	return (
		<div className="grid gap-3 p-3 md:grid-cols-[260px_minmax(0,1fr)]">
			<Panel className="min-w-0 overflow-hidden" title="master · root">
				<ul className="max-h-[360px] overflow-y-auto py-1">
					{LINUX_ROOT.map((entry) => <li key={entry.path}>
						<Link to="/$owner/$repo" params={PARAMS} search={entry.type === "tree" ? { path: entry.path } : { file: entry.path }} className="flex items-center gap-2 px-3 py-1.5 font-mono text-xs hover:bg-raised">
							{entry.type === "tree" ? <Folder className="size-3.5 shrink-0 text-accent" /> : <FileCode2 className="size-3.5 shrink-0 text-faint" />}<span className="truncate">{entry.name}</span>
						</Link>
					</li>)}
				</ul>
			</Panel>
			<Panel className="min-w-0" title="README" actions={<Link to="/$owner/$repo" params={PARAMS} search={{ file: "README" }} className="text-xs text-accent hover:underline">Open file</Link>}>
				<pre className="max-h-[360px] overflow-auto p-4 font-mono text-xs leading-5">{LINUX_README}</pre>
			</Panel>
		</div>
	);
}

type DemoIssue = { number: number; title: string; state: "open" | "closed"; labels: string[]; by: string; when: string; body: string; comments: { by: string; when: string; body: string }[] };

const ISSUES: DemoIssue[] = [
	{ number: 52, title: "Clear Poly1305 state explicitly after finalizing", state: "open", labels: ["crypto", "bug"], by: "demo-contributor", when: "2 hours ago", body: "The descriptor is cleared with a plain assignment. Use an explicit clearing helper so compiler optimization cannot remove the cleanup.\n\nFictional demo issue inspired by [this upstream Linux patch](" + LINUX_PATCH_SOURCE + ").", comments: [{ by: "demo-maintainer", when: "1 hour ago", body: "Let's make the cleanup intent explicit and keep the patch small." }] },
	{ number: 50, title: "Add coverage for split-update Poly1305 carries", state: "open", labels: ["crypto", "tests"], by: "demo-contributor", when: "yesterday", body: "Add a regression test for updates split across several calls.\n\nFictional discussion based on the [upstream crypto fixes](https://github.com/torvalds/linux/commit/0fcb05b72344f40806cbe810de8872f1698bf053).", comments: [] },
	{ number: 46, title: "Preserve checksum types in the NIOS2 fold helper", state: "closed", labels: ["nios2", "bug"], by: "demo-contributor", when: "3 days ago", body: "Keep the checksum type through the helper's conversion.\n\nFictional issue inspired by [the upstream NIOS2 fix](https://github.com/torvalds/linux/commit/4056b3c9d3c92ea45955641dbafeb9b960e146ef).", comments: [] },
];

/** The Issues tab: the list, and an issue with its thread and a reply box. */
function IssuesView() {
	const [issues, setIssues] = useState(ISSUES);
	const [open, setOpen] = useState<number | null>(null);
	const [reply, setReply] = useState("");
	const issue = issues.find((i) => i.number === open);

	const update = (n: number, patch: (i: DemoIssue) => DemoIssue) => setIssues((all) => all.map((i) => (i.number === n ? patch(i) : i)));

	if (!issue) {
		return (
			<div className="p-3">
				<Panel
					title={`${issues.filter((i) => i.state === "open").length} open · ${issues.filter((i) => i.state === "closed").length} closed`}
					actions={<span className="text-[11px] text-faint">Click an issue to open it</span>}
				>
					<ul className="divide-y divide-line/60">
						{issues.map((i) => (
							<li key={i.number} className="flex items-start gap-3 px-4 py-3">
								<IssueStateIcon state={i.state} className="mt-0.5 shrink-0" />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
										<button type="button" onClick={() => setOpen(i.number)} className="text-left text-sm font-medium text-fg hover:text-accent">
											{i.title}
										</button>
										{i.labels.map((l) => (
											<Label key={l} name={l} />
										))}
									</div>
									<p className="mt-0.5 text-xs text-dim">
										#{i.number} opened {i.when} by {i.by}
										{i.comments.length > 0 && ` · ${i.comments.length} ${i.comments.length === 1 ? "comment" : "comments"}`}
									</p>
								</div>
							</li>
						))}
					</ul>
				</Panel>
			</div>
		);
	}

	return (
		<div className="space-y-3 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<button type="button" onClick={() => setOpen(null)} className="text-xs text-dim hover:text-fg">
					← Issues
				</button>
				<span className="text-sm font-semibold text-fg">{issue.title}</span>
				<span className="font-mono text-xs text-faint">#{issue.number}</span>
				<IssueStateBadge state={issue.state} />
				{issue.labels.map((l) => (
					<Label key={l} name={l} />
				))}
			</div>
			{[{ by: issue.by, when: issue.when, body: issue.body }, ...issue.comments].map((c, i) => (
				<div key={i} className="overflow-hidden rounded-lg border border-line bg-panel">
					<div className="flex items-center gap-2 border-b border-line bg-raised/40 px-4 py-2 text-xs text-dim">
						<b className="font-medium text-fg">{c.by}</b>
						{c.when}
					</div>
					<div className="px-4 py-3">
						<Markdown source={c.body} project={PROJECT} path="" />
					</div>
				</div>
			))}
			<div className="space-y-2 rounded-lg border border-line bg-panel p-3">
				<MarkdownEditor value={reply} onChange={setReply} project={PROJECT} label="Comment" rows={3} placeholder="Leave a comment" />
				<div className="flex justify-end gap-2">
					<Button
						className="text-xs"
						onClick={() => update(issue.number, (i) => ({ ...i, state: i.state === "open" ? "closed" : "open" }))}
					>
						{issue.state === "open" ? "Close issue" : "Reopen issue"}
					</Button>
					<Button
						variant="primary"
						className="text-xs"
						disabled={!reply.trim()}
						onClick={() => {
							update(issue.number, (i) => ({ ...i, comments: [...i.comments, { by: "you", when: "just now", body: reply.trim() }] }));
							setReply("");
						}}
					>
						Comment
					</Button>
				</div>
			</div>
		</div>
	);
}

const DIFF = LINUX_DIFF;

type Draft = { path: string; side: "new" | "old"; line: number; body: string };

/** The pull request's Files changed tab: the real diff view with line comments and a pending review. */
function ReviewView() {
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [submitted, setSubmitted] = useState<Draft[]>([]);
	const [editing, setEditing] = useState<{ path: string; side: "new" | "old"; line: number } | null>(null);
	const [text, setText] = useState("");
	const [decision, setDecision] = useState<"approved" | "changes_requested" | null>(null);

	const submit = (next: "approved" | "changes_requested") => {
		setSubmitted((all) => [...all, ...drafts]);
		setDrafts([]);
		setDecision(next);
	};

	const notes: DiffNotes = useMemo(() => {
		const under = new Map<string, ReactNode>();
		const byLine = new Map<string, ReactNode[]>();
		const add = (key: string, node: ReactNode) => byLine.set(key, [...(byLine.get(key) ?? []), node]);
		add(
			lineKey("lib/crypto/poly1305.c", "new", 81),
			<div key="demo-maintainer" className="rounded-md border border-line bg-panel px-3 py-2">
				<p className="mb-1 text-[11px] text-dim">
					<b className="text-fg">demo-maintainer</b> yesterday
				</p>
				<Markdown source="Does the explicit cleanup cover the whole descriptor?" project={PROJECT} path="" />
			</div>,
		);
		submitted.forEach((d, i) => add(lineKey(d.path, d.side, d.line), (
			<div key={`submitted${i}`} className="rounded-md border border-line bg-panel px-3 py-2">
				<p className="mb-1 text-[11px] text-dim"><b className="text-fg">you</b> just now</p>
				<Markdown source={d.body} project={PROJECT} path="" />
			</div>
		)));
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
					<Markdown source={d.body} project={PROJECT} path="" />
				</div>,
			),
		);
		if (editing) {
			add(
				lineKey(editing.path, editing.side, editing.line),
				<div key="editor" className="space-y-2">
					<MarkdownEditor value={text} onChange={setText} project={PROJECT} label="Line comment" rows={3} autoFocus />
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
			onAdd: (path, side, line) => {
				setEditing({ path, side, line });
				setText("");
			},
		};
	}, [drafts, submitted, editing, text]);

	return (
		<div className="p-3">
			<div className="mb-3 flex flex-wrap items-center gap-2 px-1">
				<PullStateBadge state="open" />
				<span className="text-sm font-semibold">Clear Poly1305 state after finalizing</span>
				<span className="font-mono text-xs text-faint">#48</span>
				<Decision decision={decision} />
				<span className="ml-auto font-mono text-xs text-dim">
					crypto/explicit-cleanup <span className="text-faint">→</span> master
				</span>
			</div>
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-4 py-2.5 text-sm">
				<span className="text-dim">
					Hover a line and press + to comment on it. {drafts.length > 0 && <b className="text-amber-300">{drafts.length} pending</b>}
				</span>
				<div className="flex gap-2">
					<Button className="text-xs" disabled={editing !== null} onClick={() => submit("changes_requested")}>
						Request changes
					</Button>
					<Button variant="primary" className="text-xs" disabled={editing !== null} onClick={() => submit("approved")}>
						Approve
					</Button>
				</div>
			</div>
			<DiffView diff={DIFF} project={PROJECT} notes={notes} links={false} />
		</div>
	);
}

type Tab = "code" | "issues" | "pull" | "commits";

const TABS: { key: Tab; label: string; icon: typeof FileCode2 }[] = [
	{ key: "code", label: "Code", icon: FileCode2 },
	{ key: "issues", label: "Issues", icon: CircleDot },
	{ key: "pull", label: "Pull request #48", icon: GitPullRequest },
	{ key: "commits", label: "Commits", icon: GitCommitHorizontal },
];

/** Cached Linux root and commits, with fictional issue and review interactions. */
export function AppDemo({ initial = "code" }: { initial?: Tab }) {
	const [tab, setTab] = useState<Tab>(initial);
	return (
		<div className="overflow-hidden rounded-xl border border-line bg-bg text-left text-fg">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 font-mono text-sm">
				<span className="text-dim">maggot-mirror</span>
				<span className="-mx-3 text-faint">/</span>
				<Link to="/$owner/$repo" params={PARAMS} className="font-semibold hover:text-accent">linux</Link>
				<span className="rounded-full border border-line-strong px-2 py-0.5 font-sans text-[11px] text-dim">Public</span>
				<span className="ml-auto font-sans text-xs text-dim">Linux kernel</span>
			</div>
			<div className="border-b border-line px-4 py-2 text-[11px] text-dim">Cached Linux source · issue and review discussions are demo examples. <a href={LINUX_PATCH_SOURCE} target="_blank" rel="noreferrer" className="text-accent hover:underline">Upstream patch ↗</a></div>
			<div className="flex flex-wrap gap-1 border-b border-line px-2 font-sans text-xs">
				{TABS.map(({ key, label, icon: Icon }) => (
					<button
						key={key}
						type="button"
						onClick={() => setTab(key)}
						className={cx("flex items-center gap-1.5 border-b-2 px-3 py-2", tab === key ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg")}
					>
						<Icon className="size-3.5" />
						{label}
					</button>
				))}
				<span className="ml-auto hidden items-center gap-2 pr-2 text-dim sm:flex">
					<GitBranch className="size-3.5" /> <span className="font-mono">master</span>
				</span>
			</div>
			{tab === "code" && <CodeView />}
			{tab === "issues" && <IssuesView />}
			{tab === "pull" && <ReviewView />}
			{tab === "commits" && (
				<div className="p-3">
					<Panel title="master · cached upstream commits" actions={<a href="https://github.com/torvalds/linux/commits/master" target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">Open upstream history ↗</a>}>
						<CommitList commits={LINUX_COMMITS} project={PROJECT} links={false} />
					</Panel>
				</div>
			)}
		</div>
	);
}
