import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Check, ChevronRight, Download, File, FileCode2, FileText, Folder, FolderGit2, Link2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "../components/markdown.tsx";
import { RepoCommands } from "../components/repo-access.tsx";
import { BranchSelect } from "../components/refs.tsx";
import { cx, Empty, ErrorNote, Panel, Spinner, useCopy } from "../components/ui.tsx";
import { api, keys, type TreeEntry, repoParams } from "../lib/api.ts";
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

function Code() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { ref, path = "", file } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const tree = useQuery({ queryKey: [...keys.code(project), "tree", ref ?? "", path], queryFn: () => api.tree(project, path, ref) });
	const readme = !file ? tree.data?.entries.find((e) => e.type !== "tree" && /^readme(\.md|\.txt)?$/i.test(e.name)) : undefined;
	const shown = file ?? readme?.path;

	if (tree.data && !tree.data.commit && !ref && info.data) {
		return (
			<Panel title="Quick setup">
				<div className="space-y-4 p-4">
					<p className="text-sm text-dim">
						This repository is empty.{" "}
						{info.data.repo.canWrite ? "Push your code to it with git:" : "Its owner hasn't pushed anything yet."}
					</p>
					{info.data.repo.canWrite && <RepoCommands repo={info.data.repo} empty />}
				</div>
			</Panel>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<BranchSelect project={project} value={ref} onChange={(next) => void navigate({ search: { ref: next } })} />
				<Breadcrumbs project={project} refName={ref} path={path} />
				{tree.data?.commit && (
					<div className="ml-auto flex items-center gap-3">
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
						<ArchiveMenu project={project} refName={ref} />
					</div>
				)}
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
					<FileView key={shown} project={project} refName={ref} path={shown} commit={tree.data?.commit ?? null} />
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

function FileView({ project, refName, path, commit }: { project: string; refName?: string; path: string; commit: string | null }) {
	const image = IMAGE.test(path);
	const markdown = MARKDOWN.test(path);
	const file = useQuery({
		queryKey: [...keys.code(project), "file", refName ?? "", path],
		queryFn: () => api.file(project, path, refName),
		enabled: !image,
	});
	const [mode, setMode] = useState<"preview" | "code">("preview");
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
		() => (file.data === undefined || binary ? null : highlightLines(lines.slice(0, MAX_LINES).join("\n"), languageFor(path))),
		[file.data, binary, lines, path],
	);
	const showCode = !image && !binary && !(markdown && mode === "preview");

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
				<div className="flex items-center gap-1">
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
			{markdown && mode === "preview" && file.data !== undefined && (
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

/** Downloads the whole tree at the current ref. */
function ArchiveMenu({ project, refName }: { project: string; refName?: string }) {
	return (
		<details className="relative">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-fg hover:border-faint">
				<Download className="size-3.5" />
				Download
			</summary>
			<div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-line-strong bg-panel py-1 shadow-xl">
				{(["zip", "tar.gz"] as const).map((format) => (
					<a key={format} href={api.archiveUrl(project, format, refName)} className="block px-3 py-1.5 text-xs text-dim hover:bg-raised hover:text-fg">
						Download .{format}
					</a>
				))}
			</div>
		</details>
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
