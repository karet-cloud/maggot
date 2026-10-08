import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, File, FileCode2, Folder, FolderGit2, Link2 } from "lucide-react";
import { cx, Empty, ErrorNote, Oid, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, type TreeEntry } from "../lib/api.ts";
import { useProjectTasks } from "../lib/queries.ts";

type Search = { ref?: string; path?: string; file?: string };

export const Route = createFileRoute("/p/$project/code")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		ref: typeof s.ref === "string" && s.ref ? s.ref : undefined,
		path: typeof s.path === "string" && s.path ? s.path : undefined,
		file: typeof s.file === "string" && s.file ? s.file : undefined,
	}),
	component: Code,
});

const MAX_LINES = 5000;

function Code() {
	const { project } = Route.useParams();
	const { ref, path = "", file } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const tree = useQuery({ queryKey: [...keys.code(project), "tree", ref ?? "", path], queryFn: () => api.tree(project, path, ref) });
	const readme = !file ? tree.data?.entries.find((e) => e.type !== "tree" && /^readme(\.md|\.txt)?$/i.test(e.name)) : undefined;
	const shown = file ?? readme?.path;

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<RefPicker project={project} value={ref} onChange={(next) => void navigate({ search: { ref: next } })} />
				<Breadcrumbs project={project} refName={ref} path={path} />
				{tree.data?.commit && (
					<span className="ml-auto flex items-center gap-1.5 text-xs text-faint">
						at <Oid oid={tree.data.commit} />
					</span>
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
					<FileView project={project} refName={ref} path={shown} />
				) : (
					tree.data && (
						<Empty icon={<FolderGit2 className="size-6" />} title="Pick a file">
							{tree.data.commit ? "Browse the tree on the left." : "This repository has no commits yet."}
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

function FileView({ project, refName, path }: { project: string; refName?: string; path: string }) {
	const file = useQuery({ queryKey: [...keys.code(project), "file", refName ?? "", path], queryFn: () => api.file(project, path, refName) });
	const lines = file.data?.split("\n") ?? [];
	if (lines.at(-1) === "") lines.pop();
	return (
		<Panel title={<span className="font-mono normal-case tracking-normal text-fg">{path}</span>} actions={file.data !== undefined && <span className="text-[11px] text-faint">{lines.length} lines</span>} className="min-w-0 overflow-hidden">
			{file.isPending && <Spinner className="m-4" />}
			{file.error && (
				<div className="p-3">
					<ErrorNote error={file.error} />
				</div>
			)}
			{file.data !== undefined && (
				<div className="overflow-x-auto">
					<table className="w-full border-collapse font-mono text-[12px] leading-5">
						<tbody>
							{lines.slice(0, MAX_LINES).map((line, i) => (
								<tr key={i} className="hover:bg-raised/60">
									<td className="w-px select-none px-3 text-right align-top text-faint/70">{i + 1}</td>
									<td className="pr-4 whitespace-pre text-fg/90">{line || " "}</td>
								</tr>
							))}
						</tbody>
					</table>
					{lines.length > MAX_LINES && <p className="p-3 text-xs text-faint">Showing the first {MAX_LINES} lines.</p>}
				</div>
			)}
		</Panel>
	);
}

function Breadcrumbs({ project, refName, path }: { project: string; refName?: string; path: string }) {
	const parts = path.split("/").filter(Boolean);
	return (
		<nav className="flex min-w-0 items-center gap-1 font-mono text-xs">
			<Link to="/p/$project/code" params={{ project }} search={{ ref: refName }} className="text-accent hover:underline">
				{project}
			</Link>
			{parts.map((part, i) => (
				<span key={parts.slice(0, i + 1).join("/")} className="flex items-center gap-1">
					<ChevronRight className="size-3 text-faint" />
					<Link
						to="/p/$project/code"
						params={{ project }}
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

/** The default branch, or the fork of any task that has one. */
function RefPicker({ project, value, onChange }: { project: string; value?: string; onChange: (ref?: string) => void }) {
	const tasks = useProjectTasks(project);
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const forks = (tasks.data ?? []).filter((t) => t.remote && ["open", "queued", "merging", "conflict", "failed"].includes(t.status));
	const known = !value || forks.some((t) => `task:${t.id}` === value);
	return (
		<select
			value={value ?? ""}
			onChange={(e) => onChange(e.target.value || undefined)}
			className="max-w-72 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 font-mono text-xs text-fg focus:border-accent focus:outline-none"
		>
			<option value="">{info.data?.defaultBranch ?? "main"} (default)</option>
			{!known && <option value={value}>{/^[0-9a-f]{40}$/.test(value ?? "") ? `commit ${value?.slice(0, 7)}` : value}</option>}
			{forks.length > 0 && (
				<optgroup label="Task forks">
					{forks.map((t) => (
						<option key={t.id} value={`task:${t.id}`}>
							{t.id} · {t.title.slice(0, 40)}
						</option>
					))}
				</optgroup>
			)}
		</select>
	);
}
