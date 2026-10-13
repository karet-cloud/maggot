import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FileUp, GitBranch, GitCommitHorizontal, Upload, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Button, cx, Empty, ErrorNote, Field, Input, Panel, Spinner } from "../components/ui.tsx";
import { api, keys, repoParams } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

type Search = { ref?: string; dir?: string };

// Upload files (any kind, up to 10 MB each) into a folder on a branch, as one commit.
export const Route = createFileRoute("/$owner/$repo/upload")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		ref: typeof s.ref === "string" && s.ref ? s.ref : undefined,
		dir: typeof s.dir === "string" && s.dir ? s.dir : undefined,
	}),
	component: UploadPage,
});

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
const MAX_FILES = 100;

interface Picked {
	/** Path under the target folder, keeping the dropped folder structure. */
	path: string;
	file: File;
}

/** File contents as base64, in chunks so big files don't overflow the call stack. */
async function toBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Every file in a drop, walking into dropped folders. */
async function droppedFiles(event: DragEvent): Promise<Picked[]> {
	const items = [...event.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
	if (items.length === 0) return [...event.dataTransfer.files].map((file) => ({ path: file.name, file }));
	const out: Picked[] = [];
	const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
		if (out.length > MAX_FILES) return;
		if (entry.isFile) {
			const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
			out.push({ path: `${prefix}${entry.name}`, file });
		} else if (entry.isDirectory) {
			const reader = (entry as FileSystemDirectoryEntry).createReader();
			// readEntries returns a batch at a time until it returns none.
			for (;;) {
				const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
				if (batch.length === 0) break;
				for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
			}
		}
	};
	for (const item of items) await walk(item, "");
	return out;
}

function UploadPage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { ref, dir } = Route.useSearch();
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const branch = ref ?? info.data?.defaultBranch;
	const [folder, setFolder] = useState(dir ?? "");
	const [picked, setPicked] = useState<Picked[]>([]);
	const [message, setMessage] = useState("");
	const [target, setTarget] = useState<"same" | "new">("same");
	const [newBranch, setNewBranch] = useState("");
	const [dragging, setDragging] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	const add = (files: Picked[]) =>
		setPicked((prev) => {
			const byPath = new Map(prev.map((p) => [p.path, p]));
			for (const f of files) byPath.set(f.path, f);
			return [...byPath.values()];
		});
	const total = picked.reduce((n, p) => n + p.file.size, 0);
	const tooBig = picked.filter((p) => p.file.size > MAX_FILE);
	const problem =
		picked.length > MAX_FILES
			? `At most ${MAX_FILES} files per upload`
			: tooBig.length
				? `${tooBig[0].path} is over ${formatBytes(MAX_FILE)}; push it with git`
				: total > MAX_TOTAL
					? `One upload can add at most ${formatBytes(MAX_TOTAL)}`
					: null;
	const prefix = folder.trim().replace(/^\/+|\/+$/g, "");

	const commit = useMutation({
		mutationFn: async () => {
			// The branch head now, so the commit is refused (not merged blindly) if it moves meanwhile.
			const base = await api.tree(project, "", branch);
			const files = await Promise.all(picked.map(async (p) => ({ path: prefix ? `${prefix}/${p.path}` : p.path, content: await toBase64(p.file), encoding: "base64" as const })));
			return api.commitFiles(project, {
				branch: branch as string,
				baseCommit: base.commit,
				newBranch: target === "new" ? newBranch.trim() : undefined,
				message: message.trim() || `Add ${picked.length === 1 ? picked[0].path : `${picked.length} files`}`,
				files,
			});
		},
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: keys.project(project) });
			void navigate({
				to: "/$owner/$repo",
				params: repoParams(project),
				search: { ref: result.branch === info.data?.defaultBranch ? undefined : result.branch, path: prefix || undefined },
			});
		},
	});

	if (info.isPending || viewer.isPending) return <Spinner className="m-4" />;
	if (!info.data?.repo.canWrite) return <Empty title="You can't add files here">Only people who can push to this repository can upload.</Empty>;
	if (info.data.repo.archivedAt) return <Empty title="This repository is archived">It's read-only. Its owner can unarchive it in Settings.</Empty>;

	return (
		<Panel title="Upload files">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					commit.mutate();
				}}
				className="space-y-4 p-4"
			>
				<Field label="Into folder" hint="Leave empty for the top of the repository. Dropped folders keep their structure inside it.">
					<Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. docs/images" className="font-mono" />
				</Field>
				<div
					onDragOver={(e) => {
						e.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragging(false);
						void droppedFiles(e).then(add);
					}}
					className={cx(
						"flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center",
						dragging ? "border-accent bg-accent/5" : "border-line-strong",
					)}
				>
					<FileUp className="size-7 text-faint" />
					<p className="text-sm text-dim">Drag files or folders here</p>
					<Button type="button" className="text-xs" onClick={() => input.current?.click()}>
						Choose files
					</Button>
					<input
						ref={input}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							add([...(e.target.files ?? [])].map((file) => ({ path: file.name, file })));
							e.target.value = "";
						}}
					/>
					<p className="text-[11px] text-faint">
						Any kind of file, up to {formatBytes(MAX_FILE)} each and {formatBytes(MAX_TOTAL)} in all. Bigger files go through git.
					</p>
				</div>
				{picked.length > 0 && (
					<ul className="divide-y divide-line/60 rounded-md border border-line">
						{picked.map((p) => (
							<li key={p.path} className="flex items-center gap-3 px-3 py-1.5 text-sm">
								<span className="min-w-0 flex-1 truncate font-mono text-xs">
									<span className="text-faint">{prefix ? `${prefix}/` : ""}</span>
									{p.path}
								</span>
								<span className={cx("text-[11px] tabular-nums", p.file.size > MAX_FILE ? "text-rose-300" : "text-faint")}>{formatBytes(p.file.size)}</span>
								<button type="button" onClick={() => setPicked((prev) => prev.filter((x) => x !== p))} className="rounded p-0.5 text-faint hover:text-fg" aria-label={`Remove ${p.path}`}>
									<X className="size-3.5" />
								</button>
							</li>
						))}
					</ul>
				)}
				<Field label="Commit message">
					<Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={picked.length ? `Add ${picked.length === 1 ? picked[0].path : `${picked.length} files`}` : "Add files"} />
				</Field>
				<fieldset className="space-y-2 text-sm">
					<label className="flex items-center gap-2">
						<input type="radio" checked={target === "same"} onChange={() => setTarget("same")} />
						<GitCommitHorizontal className="size-4 text-faint" />
						Commit to <span className="font-mono">{branch}</span>
					</label>
					<label className="flex items-center gap-2">
						<input type="radio" checked={target === "new"} onChange={() => setTarget("new")} />
						<GitBranch className="size-4 text-faint" />
						Commit to a new branch
					</label>
					{target === "new" && <Input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="new-branch-name" className="ml-6 max-w-sm font-mono" required />}
				</fieldset>
				{needsVerification && <p className="text-xs text-amber-200">Verify your email address before committing.</p>}
				<ErrorNote error={problem ? new Error(problem) : commit.error} />
				<div className="flex justify-end gap-2">
					<Link to="/$owner/$repo" params={repoParams(project)} search={{ ref, path: dir }} className="rounded-md px-3 py-1.5 text-sm text-dim hover:text-fg">
						Cancel
					</Link>
					<Button type="submit" variant="primary" busy={commit.isPending} disabled={picked.length === 0 || Boolean(problem) || needsVerification}>
						<Upload className="size-4" />
						Commit {picked.length || ""} {picked.length === 1 ? "file" : "files"}
					</Button>
				</div>
			</form>
		</Panel>
	);
}
