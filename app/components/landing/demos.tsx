import { CircleDot, File, FileCode2, Folder, GitBranch, GitCommitHorizontal, GitPullRequest, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Commit, Diff, TreeEntry } from "../../lib/api.ts";
import { highlightLines, languageFor } from "../../lib/highlight.ts";
import { CommitList } from "../commits.tsx";
import { DiffView, lineKey, type DiffNotes } from "../diff.tsx";
import { IssueStateBadge, IssueStateIcon, Label } from "../issues.tsx";
import { MarkdownEditor } from "../markdown-editor.tsx";
import { Markdown } from "../markdown.tsx";
import { Decision, PullStateBadge } from "../pulls.tsx";
import { Button, cx, Panel } from "../ui.tsx";

/*
 * Working demos for the landing pages, assembled from the app's own components (Panel, Markdown,
 * DiffView, MarkdownEditor, CommitList, the pull request badges) over static data. They behave like
 * the real pages: files open, lines select, diffs switch layout, comments get drafted.
 */

const PROJECT = "sarthak/shop";

const ENTRIES: TreeEntry[] = [
	{ name: ".maggot", path: ".maggot", type: "tree", hash: "1" },
	{ name: "src", path: "src", type: "tree", hash: "2" },
	{ name: "test", path: "test", type: "tree", hash: "3" },
	{ name: "README.md", path: "README.md", type: "blob", hash: "4" },
	{ name: "package.json", path: "package.json", type: "blob", hash: "5" },
	{ name: "server.ts", path: "server.ts", type: "blob", hash: "6" },
];

const FILES: Record<string, string> = {
	"README.md": `# shop

A small store. CI runs on every pull request; releases are tagged from \`master\`.

## Develop

\`\`\`sh
npm install
npm run dev
\`\`\`

- Issues and pull requests live here, next to the code.
- Push over HTTPS with a token, or over SSH with your key.
`,
	"package.json": `{
  "name": "shop",
  "private": true,
  "scripts": {
    "dev": "vite dev",
    "test": "node --test test/*.test.ts"
  },
  "dependencies": {
    "hono": "^4.13.0"
  }
}
`,
	"server.ts": `import { Hono } from "hono";
import { orders } from "./src/orders.ts";

const app = new Hono();

app.get("/orders", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  return c.json(await orders.list({ page, perPage: 25 }));
});

export default app;
`,
};

const COMMITS: Commit[] = [
	{ hash: "4e1f2c0a9b7d6e5f4c3b2a1908f7e6d5c4b3a291", message: "Limit sign-in attempts per address", author: { name: "sarthak", email: "" }, parents: ["a"], committedAt: Date.now() / 1000 - 3 * 3600 },
	{ hash: "9b17e44c2d1f0a3b5c6d7e8f9a0b1c2d3e4f5a6b", message: "Merge pull request #47 from ana/orders-paging", author: { name: "ana", email: "" }, parents: ["a", "b"], committedAt: Date.now() / 1000 - 26 * 3600 },
	{ hash: "c04d2aa1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7", message: "Document the SSH setup", author: { name: "sarthak", email: "" }, parents: ["a"], committedAt: Date.now() / 1000 - 2 * 86400 },
	{ hash: "3f9a0c1b2e3d4c5b6a79887766554433221100ff", message: "Run tests on pull requests", author: { name: "ana", email: "" }, parents: ["a"], committedAt: Date.now() / 1000 - 4 * 86400 },
];

/** The Code tab: tree, and a file view with selectable lines. */
function CodeView() {
	const [file, setFile] = useState<string>("README.md");
	const [selected, setSelected] = useState<[number, number] | null>(null);
	const source = FILES[file] ?? "";
	const isMarkdown = file.endsWith(".md");
	const [mode, setMode] = useState<"preview" | "code">("preview");
	const lines = useMemo(() => source.replace(/\n$/, "").split("\n"), [source]);
	const html = useMemo(() => highlightLines(source.replace(/\n$/, ""), languageFor(file)), [source, file]);

	const select = (n: number, extend: boolean) => {
		setSelected((s) => (extend && s ? [Math.min(s[0], n), Math.max(s[1], n)] : [n, n]));
	};

	return (
		<div className="grid gap-3 p-3 md:grid-cols-[220px_minmax(0,1fr)]">
			<Panel className="self-start overflow-hidden">
				<ul className="py-1">
					{ENTRIES.map((e) => {
						const dir = e.type === "tree";
						const Icon = dir ? Folder : /\.(ts|json|md)$/.test(e.name) ? FileCode2 : File;
						const active = e.path === file;
						return (
							<li key={e.path}>
								<button
									type="button"
									disabled={dir}
									onClick={() => {
										setFile(e.path);
										setSelected(null);
										setMode("preview");
									}}
									className={cx(
										"flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs",
										dir ? "text-fg" : "hover:bg-raised",
										active ? "bg-raised text-fg" : dir ? "" : "text-dim",
									)}
								>
									<Icon className={cx("size-3.5 shrink-0", dir ? "text-accent" : "text-faint")} />
									<span className="truncate">{e.name}</span>
								</button>
							</li>
						);
					})}
				</ul>
			</Panel>
			<Panel
				title={file}
				actions={
					<div className="flex items-center gap-2 text-[11px]">
						{isMarkdown && (
							<div className="flex overflow-hidden rounded-md border border-line-strong">
								{(["preview", "code"] as const).map((m) => (
									<button key={m} type="button" onClick={() => setMode(m)} className={cx("px-2 py-1 capitalize", mode === m ? "bg-raised text-fg" : "text-faint hover:text-fg")}>
										{m}
									</button>
								))}
							</div>
						)}
						<span className="text-faint">{lines.length} lines</span>
					</div>
				}
			>
				{isMarkdown && mode === "preview" ? (
					<div className="p-5">
						<Markdown source={source} project={PROJECT} path={file} />
					</div>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full border-collapse font-mono text-[12px] leading-5">
							<tbody>
								{lines.map((line, i) => {
									const n = i + 1;
									const on = selected !== null && n >= selected[0] && n <= selected[1];
									return (
										<tr key={i} className={on ? "bg-amber-400/10" : "hover:bg-raised/60"}>
											<td className="w-px align-top">
												<a
													href={`#L${n}`}
													onClick={(e) => {
														e.preventDefault();
														select(n, e.shiftKey);
													}}
													className={cx("block px-3 text-right select-none", on ? "text-amber-300" : "text-faint/70 hover:text-fg")}
												>
													{n}
												</a>
											</td>
											{html?.[i] !== undefined ? (
												<td className="pr-4 whitespace-pre text-fg/90" dangerouslySetInnerHTML={{ __html: html[i] || " " }} />
											) : (
												<td className="pr-4 whitespace-pre text-fg/90">{line || " "}</td>
											)}
										</tr>
									);
								})}
							</tbody>
						</table>
						<p className="border-t border-line px-3 py-1.5 text-[11px] text-faint">
							{selected ? (selected[1] !== selected[0] ? `Lines ${selected[0]}–${selected[1]} selected. ` : `Line ${selected[0]} selected. `) : "Click a line number; shift-click for a range. "}
							Permalinks pin the selection to the commit.
						</p>
					</div>
				)}
			</Panel>
		</div>
	);
}

type DemoIssue = { number: number; title: string; state: "open" | "closed"; labels: string[]; by: string; when: string; body: string; comments: { by: string; when: string; body: string }[] };

const ISSUES: DemoIssue[] = [
	{
		number: 52,
		title: "Orders page is slow past 1,000 orders",
		state: "open",
		labels: ["bug", "performance"],
		by: "ana",
		when: "2 hours ago",
		body: "`GET /orders` loads every order and pages in memory. Past about a thousand orders the page takes several seconds.\n\nWe should page in the query instead: `LIMIT 25 OFFSET ?`.",
		comments: [{ by: "sarthak", when: "1 hour ago", body: "Agreed. #47 added paging to the API; the page just doesn't use it yet." }],
	},
	{
		number: 50,
		title: "Add a dark mode toggle",
		state: "open",
		labels: ["enhancement"],
		by: "sarthak",
		when: "yesterday",
		body: "Follow the system setting by default, with a switch in Settings to override it.",
		comments: [],
	},
	{
		number: 46,
		title: "Sign-in accepts an empty password",
		state: "closed",
		labels: ["bug", "security"],
		by: "ana",
		when: "3 days ago",
		body: "An empty string passes validation and reaches `findUser`.",
		comments: [{ by: "sarthak", when: "2 days ago", body: "Fixed in 4e1f2c0, which also limits attempts per address. Closes #46." }],
	},
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

const DIFF: Diff = {
	additions: 4,
	deletions: 1,
	truncated: false,
	files: [
		{
			path: "src/auth/sign-in.ts",
			status: "modified",
			oldMode: "100644",
			newMode: "100644",
			additions: 3,
			deletions: 1,
			binary: false,
			tooLarge: false,
			hunks: [
				{
					oldStart: 40,
					oldLines: 5,
					newStart: 40,
					newLines: 7,
					lines: [
						" export async function signIn(req: Request) {",
						"-  const user = await findUser(req);",
						'+  await limiter.check(req, "sign-in");',
						"+",
						"+  const user = await findUser(req);",
						"   if (!user) return unauthorized();",
						"   return session.start(user);",
					],
				},
			],
		},
		{
			path: "test/sign-in.test.ts",
			status: "modified",
			oldMode: "100644",
			newMode: "100644",
			additions: 1,
			deletions: 0,
			binary: false,
			tooLarge: false,
			hunks: [{ oldStart: 12, oldLines: 2, newStart: 12, newLines: 3, lines: ['   test("rejects a wrong password", async () => {', '+    await limiter.reset();', "     const res = await signIn(bad);"] }],
		},
	],
};

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
			lineKey("src/auth/sign-in.ts", "new", 42),
			<div key="ana" className="rounded-md border border-line bg-panel px-3 py-2">
				<p className="mb-1 text-[11px] text-dim">
					<b className="text-fg">ana</b> yesterday
				</p>
				<Markdown source="Should this count failures only, so a correct password doesn't burn the budget?" project={PROJECT} path="" />
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
				<span className="text-sm font-semibold">Limit sign-in attempts per address</span>
				<span className="font-mono text-xs text-faint">#48</span>
				<Decision decision={decision} />
				<span className="ml-auto font-mono text-xs text-dim">
					feature/limits <span className="text-faint">→</span> master
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

/** The repository, as the app shows it, with the views switchable. */
export function AppDemo({ initial = "code" }: { initial?: Tab }) {
	const [tab, setTab] = useState<Tab>(initial);
	return (
		<div className="overflow-hidden rounded-xl border border-line bg-bg text-left text-fg">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 font-mono text-sm">
				<span className="text-dim">sarthak</span>
				<span className="-mx-3 text-faint">/</span>
				<span className="font-semibold">shop</span>
				<span className="rounded-full border border-line-strong px-2 py-0.5 font-sans text-[11px] text-dim">Private</span>
				<span className="ml-auto font-sans text-xs text-dim">★ 12 · 3 forks</span>
			</div>
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
					<Panel title="master · 184 commits">
						<CommitList commits={COMMITS} project={PROJECT} links={false} />
					</Panel>
				</div>
			)}
		</div>
	);
}
