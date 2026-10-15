import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Check, ChevronRight, Download, File, FileCode2, FilePlus2, FileText, Folder, FolderGit2, History, Link2, Pencil, Trash2, Upload, UserRoundSearch } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "../components/markdown.tsx";
import { CodeMenu, RepoCommands } from "../components/repo-access.tsx";
import { BlameView } from "../components/blame.tsx";
import { GoToFile } from "../components/file-finder.tsx";
import { BranchSelect } from "../components/refs.tsx";
import { Button, cx, Empty, ErrorNote, Field, Input, Modal, Panel, Spinner, useCopy } from "../components/ui.tsx";
import { api, ApiError, keys, type TreeEntry, repoParams } from "../lib/api.ts";
import { highlightLines, languageFor } from "../lib/highlight.ts";

type Search = { ref?: string; path?: string; file?: string };

export const Route = createFileRoute("/$owner/$repo/")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		ref: typeof s.ref === "string" && s.ref ? s.ref : undefined,
		path: typeof s.path === "string" && s.path ? s.path : undefined,
		file: typeof s.file === "string" && s.file ? s.file : undefined,
	}),
	component: Code,
});

const MAX_LINES = 5000;
/** Past this, files are shown plain: highlighting runs on the main thread. */
const MAX_HIGHLIGHT_BYTES = 256 * 1024;

function Code() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { ref, path = "", file } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const tree = useQuery({ queryKey: [...keys.code(project), "tree", ref ?? "", path], queryFn: () => api.tree(project, path, ref) });
	const readme = !file ? tree.data?.entries.find((e) => e.type !== "tree" && /^readme(\.md|\.txt)?$/i.test(e.name)) : undefined;
	const shown = file ?? readme?.path;
	// Archived repositories are read-only, even for their owner.
	const writable = Boolean(info.data?.repo.canWrite && !info.data.repo.archivedAt);
	// Files are edited on branches, not on tags (refs/tags/…) or commits.
	const onBranch = isBranch(ref);

	// Links from READMEs guess whether a path is a file or a directory; correct the guess either way.
	const listedAsDir = file !== undefined && tree.data?.entries.some((e) => e.path === file && e.type === "tree");
	const missing = path !== "" && tree.error instanceof ApiError && tree.error.status === 404;
	const notADirectory = !file && missing && /not a directory/.test(tree.error?.message ?? "");
	useEffect(() => {
		const parent = path.split("/").slice(0, -1).join("/") || undefined;
		if (listedAsDir) void navigate({ search: { ref, path: file }, replace: true });
		else if (notADirectory) void navigate({ search: { ref, path: parent, file: path }, replace: true });
		// A folder that's gone (its last file was deleted): go up until one exists.
		else if (missing) void navigate({ search: { ref, path: parent }, replace: true });
	}, [listedAsDir, notADirectory, missing, navigate, ref, file, path]);

	if (tree.data && !tree.data.commit && !ref && info.data) {
		return (
			<Panel title="Quick setup">
				<div className="space-y-4 p-4">
					<p className="text-sm text-dim">
						This repository is empty.{" "}
						{info.data.repo.canWrite ? "Push your code to it with git:" : "Its owner hasn't pushed anything yet. Clone it now and pull once they do:"}
					</p>
					{/* Writers get push and setup commands; everyone else gets the clone URLs (there's nothing to download yet). */}
					<RepoCommands repo={info.data.repo} empty />
				</div>
			</Panel>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<BranchSelect project={project} value={ref} onChange={(next) => void navigate({ search: { ref: next } })} />
				<Breadcrumbs project={project} refName={ref} path={path} />
				{/* Wraps right-aligned on narrow screens, so the Code menu's panel stays on screen. */}
				<div className="flex w-full flex-wrap items-center justify-end gap-3 sm:ml-auto sm:w-auto">
					{tree.data?.commit && (
						<>
							<span className="flex items-center gap-1.5 text-xs text-faint">
								at
								<Link
									to="/$owner/$repo/commit/$hash"
									params={{ ...repoParams(project), hash: tree.data.commit }}
									search={{ ref: ref?.startsWith("task:") ? ref : undefined }}
									className="font-mono text-[12px] text-dim hover:text-accent"
								>
									{tree.data.commit.slice(0, 7)}
								</Link>
							</span>
							<GoToFile project={project} refName={ref} commit={tree.data.commit} />
							{writable && onBranch && (
								<Link
									to="/$owner/$repo/edit"
									params={repoParams(project)}
									search={{ ref, dir: path || undefined }}
									className="flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-fg hover:border-faint"
								>
									<FilePlus2 className="size-3.5" />
									Add file
								</Link>
							)}
							{writable && onBranch && (
								<Link
									to="/$owner/$repo/upload"
									params={repoParams(project)}
									search={{ ref, dir: path || undefined }}
									className="flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-fg hover:border-faint"
								>
									<Upload className="size-3.5" />
									Upload
								</Link>
							)}
						</>
					)}
					{/* Cloning doesn't need the tree, so the menu stays while it loads or fails. */}
					{info.data && <CodeMenu repo={info.data.repo} refName={ref} />}
				</div>
			</div>

			<div className="grid gap-3 xl:grid-cols-[320px_minmax(0,1fr)]">
				<Panel className="self-start overflow-hidden">
					{tree.isPending && <Spinner className="m-4" />}
					{tree.error && (
						<div className="p-3">
							<ErrorNote error={tree.error} />
						</div>
					)}
					{tree.data && tree.data.entries.length === 0 && <p className="p-4 text-xs text-faint">Empty directory.</p>}
					<ul className="py-1">
						{path && (
							<li>
								<Link
									from={Route.fullPath}
									search={{ ref, path: path.split("/").slice(0, -1).join("/") || undefined }}
									className="flex items-center gap-2 px-3 py-1 font-mono text-xs text-dim hover:bg-raised"
								>
									<Folder className="size-3.5 text-faint" />
									..
								</Link>
							</li>
						)}
						{tree.data?.entries.map((e) => (
							<li key={e.path}>
								<EntryLink entry={e} refName={ref} active={e.path === shown} />
							</li>
						))}
					</ul>
				</Panel>

				{shown ? (
					<FileView
						key={shown}
						project={project}
						refName={ref}
						path={shown}
						commit={tree.data?.commit ?? null}
						editable={writable && onBranch}
						branch={ref ?? info.data?.defaultBranch}
					/>
				) : (
					tree.data && (
						<Empty icon={<FolderGit2 className="size-6" />} title="Pick a file">
							Browse the tree on the left.
						</Empty>
					)
				)}
			</div>
		</div>
	);
}

function EntryLink({ entry: e, refName, active }: { entry: TreeEntry; refName?: string; active: boolean }) {
	const dir = e.type === "tree";
	const parent = e.path.split("/").slice(0, -1).join("/") || undefined;
	const Icon = dir ? Folder : e.type === "symlink" || e.type === "gitlink" ? Link2 : /\.(ts|tsx|js|jsx|json|css|html|py|go|rs|md)$/.test(e.name) ? FileCode2 : File;
	return (
		<Link
			from={Route.fullPath}
			search={dir ? { ref: refName, path: e.path } : { ref: refName, path: parent, file: e.path }}
			className={cx(
				"flex items-center gap-2 px-3 py-1 font-mono text-xs hover:bg-raised",
				active ? "bg-raised text-fg" : dir ? "text-fg" : "text-dim",
			)}
		>
			<Icon className={cx("size-3.5 shrink-0", dir ? "text-accent" : "text-faint")} />
			<span className="truncate">{e.name}</span>
		</Link>
	);
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;

/** `L10` or `L10-L20` from the URL hash. */
function parseLines(hash: string): [number, number] | null {
	const m = /^L(\d+)(?:-L(\d+))?$/.exec(hash);
	if (!m) return null;
	const a = Number(m[1]);
	const b = Number(m[2] ?? m[1]);
	return [Math.min(a, b), Math.max(a, b)];
}

/** Whether a ref is a branch name (the default branch when absent), so the file can be edited there. */
const isBranch = (ref: string | undefined) => !ref || (!ref.startsWith("task:") && !ref.startsWith("refs/tags/") && !/^[0-9a-f]{40}$/.test(ref));

function FileView({
	project,
	refName,
	path,
	commit,
	editable,
	branch,
}: {
	project: string;
	refName?: string;
	path: string;
	commit: string | null;
	editable: boolean;
	branch?: string;
}) {
	const [deleting, setDeleting] = useState(false);
	const image = IMAGE.test(path);
	const markdown = MARKDOWN.test(path);
	const file = useQuery({
		queryKey: [...keys.code(project), "file", refName ?? "", path],
		queryFn: () => api.file(project, path, refName),
		enabled: !image,
	});
	const [mode, setMode] = useState<"preview" | "code">("preview");
	const [blaming, setBlaming] = useState(false);
	const navigate = useNavigate({ from: Route.fullPath });
	const hash = useRouterState({ select: (s) => s.location.hash });
	const selected = parseLines(hash);
	const { copied, copy } = useCopy();
	const binary = file.data?.slice(0, 8000).includes("\0") ?? false;
	const lines = useMemo(() => {
		const all = file.data?.split("\n") ?? [];
		if (all.at(-1) === "") all.pop();
		return all;
	}, [file.data]);
	const html = useMemo(
		() =>
			file.data === undefined || binary || file.data.length > MAX_HIGHLIGHT_BYTES ? null : highlightLines(lines.slice(0, MAX_LINES).join("\n"), languageFor(path)),
		[file.data, binary, lines, path],
	);
	const showCode = !image && !binary && !(markdown && mode === "preview") && !blaming;

	// Bring linked lines into view once the file has rendered.
	const scrolled = useRef("");
	useEffect(() => {
		if (!selected || !showCode || file.data === undefined || scrolled.current === `${path}#${hash}`) return;
		scrolled.current = `${path}#${hash}`;
		document.getElementById(`L${selected[0]}`)?.scrollIntoView({ block: "center" });
	}, [selected, showCode, file.data, path, hash]);

	const select = (line: number, extend: boolean) => {
		const next = extend && selected ? (line === selected[0] ? `L${line}` : `L${Math.min(selected[0], line)}-L${Math.max(selected[0], line)}`) : `L${line}`;
		scrolled.current = `${path}#${next}`;
		void navigate({ search: (prev) => prev, hash: next, replace: true });
	};
	const permalink = () => {
		const url = new URL(location.href);
		if (commit) url.searchParams.set("ref", commit);
		copy(url.toString());
	};

	return (
		<Panel
			title={<span className="font-mono normal-case tracking-normal text-fg">{path}</span>}
			actions={
				<div className="flex flex-wrap items-center justify-end gap-1">
					{file.data !== undefined && !binary && <span className="mr-2 text-[11px] text-faint">{lines.length} lines</span>}
					{markdown && (
						<div className="mr-1 flex overflow-hidden rounded-md border border-line-strong">
							{(["preview", "code"] as const).map((m) => (
								<button
									key={m}
									type="button"
									onClick={() => setMode(m)}
									className={cx("px-2 py-0.5 text-[11px] capitalize", mode === m ? "bg-raised text-fg" : "text-faint hover:text-fg")}
								>
									{m}
								</button>
							))}
						</div>
					)}
					{!binary && !image && (
						<button
							type="button"
							onClick={() => setBlaming((b) => !b)}
							aria-pressed={blaming}
							title="Who last changed each line"
							className={cx("flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-raised hover:text-fg", blaming ? "bg-raised text-fg" : "text-dim")}
						>
							<UserRoundSearch className="size-3.5" />
							Blame
						</button>
					)}
					<Link
						to="/$owner/$repo/history"
						params={repoParams(project)}
						search={{ ref: refName, path }}
						className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-raised hover:text-fg"
					>
						<History className="size-3.5" />
						History
					</Link>
					{editable && !binary && !image && (
						<Link
							to="/$owner/$repo/edit"
							params={repoParams(project)}
							search={{ ref: refName, path }}
							className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-raised hover:text-fg"
						>
							<Pencil className="size-3.5" />
							Edit
						</Link>
					)}
					{editable && (
						<button
							type="button"
							onClick={() => setDeleting(true)}
							className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-rose-500/10 hover:text-rose-300"
						>
							<Trash2 className="size-3.5" />
							Delete
						</button>
					)}
					<IconLink href={api.rawUrl(project, path, refName)} label="Raw" icon={<FileText className="size-3.5" />} newTab />
					<IconLink href={api.rawUrl(project, path, refName, true)} label="Download" icon={<Download className="size-3.5" />} />
					<button
						type="button"
						onClick={permalink}
						title="Copy a link to this file at this commit, including selected lines"
						className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-raised hover:text-fg"
					>
						{copied ? <Check className="size-3.5 text-emerald-300" /> : <Link2 className="size-3.5" />}
						{copied ? "Copied" : "Permalink"}
					</button>
				</div>
			}
			className="min-w-0 overflow-hidden"
		>
			<Modal open={deleting} onClose={() => setDeleting(false)} title={`Delete ${path}`}>
				{branch && <DeleteFile project={project} path={path} branch={branch} refName={refName} commit={commit} onClose={() => setDeleting(false)} />}
			</Modal>
			{file.isPending && !image && <Spinner className="m-4" />}
			{file.error && (
				<div className="p-3">
					<ErrorNote error={file.error} />
				</div>
			)}
			{image && (
				<div className="flex justify-center bg-[repeating-conic-gradient(#1a1e24_0%_25%,#111418_0%_50%)] bg-[length:16px_16px] p-6">
					<img src={api.rawUrl(project, path, refName)} alt={path} className="max-h-[70vh] max-w-full" />
				</div>
			)}
			{binary && <p className="p-4 text-xs text-faint">Binary file. Use Download to get it.</p>}
			{blaming && !binary && !image && <BlameView project={project} path={path} refName={refName} />}
			{markdown && mode === "preview" && !blaming && file.data !== undefined && (
				<div className="p-6">
					<Markdown source={file.data} project={project} path={path} refName={refName} />
				</div>
			)}
			{showCode && file.data !== undefined && (
				<div className="overflow-x-auto">
					<table className="w-full border-collapse font-mono text-[12px] leading-5">
						<tbody>
							{lines.slice(0, MAX_LINES).map((line, i) => {
								const n = i + 1;
								const on = selected !== null && n >= selected[0] && n <= selected[1];
								return (
									<tr key={i} id={`L${n}`} className={on ? "bg-amber-400/10" : "hover:bg-raised/60"}>
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
					{lines.length > MAX_LINES && <p className="p-3 text-xs text-faint">Showing the first {MAX_LINES} lines. Use Raw for the rest.</p>}
				</div>
			)}
		</Panel>
	);
}

function DeleteFile({
	project,
	path,
	branch,
	refName,
	commit,
	onClose,
}: {
	project: string;
	path: string;
	branch: string;
	refName?: string;
	commit: string | null;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate({ from: Route.fullPath });
	const [message, setMessage] = useState("");
	const remove = useMutation({
		mutationFn: () => api.commitFiles(project, { branch, baseCommit: commit, message: message.trim() || `Delete ${path}`, files: [{ path, content: null }] }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["project", project] });
			onClose();
			void navigate({ search: { ref: refName, path: path.split("/").slice(0, -1).join("/") || undefined } });
		},
	});
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				remove.mutate();
			}}
			className="space-y-4"
		>
			<p className="text-sm text-dim">
				This commits the deletion to <span className="font-mono text-fg">{branch}</span>. The file stays in the history.
			</p>
			<Field label="Commit message">
				<Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Delete ${path}`} autoFocus />
			</Field>
			<ErrorNote error={remove.error} />
			<div className="flex justify-end gap-2">
				<Button onClick={onClose}>Cancel</Button>
				<Button type="submit" variant="danger" busy={remove.isPending}>
					<Trash2 className="size-4" />
					Delete file
				</Button>
			</div>
		</form>
	);
}

function IconLink({ href, label, icon, newTab }: { href: string; label: string; icon: ReactNode; newTab?: boolean }) {
	return (
		<a
			href={href}
			target={newTab ? "_blank" : undefined}
			rel={newTab ? "noreferrer" : undefined}
			className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-raised hover:text-fg"
		>
			{icon}
			{label}
		</a>
	);
}

function Breadcrumbs({ project, refName, path }: { project: string; refName?: string; path: string }) {
	const parts = path.split("/").filter(Boolean);
	return (
		<nav className="flex min-w-0 items-center gap-1 font-mono text-xs">
			<Link to="/$owner/$repo" params={repoParams(project)} search={{ ref: refName }} className="text-accent hover:underline">
				{project}
			</Link>
			{parts.map((part, i) => (
				<span key={parts.slice(0, i + 1).join("/")} className="flex items-center gap-1">
					<ChevronRight className="size-3 text-faint" />
					<Link
						to="/$owner/$repo"
						params={repoParams(project)}
						search={{ ref: refName, path: parts.slice(0, i + 1).join("/") }}
						className="text-dim hover:text-fg"
					>
						{part}
					</Link>
				</span>
			))}
		</nav>
	);
}
