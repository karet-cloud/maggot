import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Button, cx, Empty, ErrorNote, Field, Input, Panel, Spinner } from "../components/ui.tsx";
import { api, ApiError, keys, repoParams } from "../lib/api.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";

type Search = { ref?: string; path?: string; dir?: string };

// Edit a file (`path`) or add one (in `dir`) on a branch, and commit it there or to a new branch.
export const Route = createFileRoute("/$owner/$repo/edit")({
	validateSearch: (s: Record<string, unknown>): Search => ({
		ref: typeof s.ref === "string" && s.ref ? s.ref : undefined,
		path: typeof s.path === "string" && s.path ? s.path : undefined,
		dir: typeof s.dir === "string" && s.dir ? s.dir : undefined,
	}),
	component: Editor,
});

const MAX_EDIT_BYTES = 1024 * 1024;

function Editor() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { ref, path: editing, dir } = Route.useSearch();
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const branch = ref ?? info.data?.defaultBranch;
	const parentDir = editing ? editing.split("/").slice(0, -1).join("/") : (dir ?? "");
	// The commit the edit starts from; the server refuses the commit if the branch has moved since.
	const base = useQuery({
		queryKey: [...keys.code(project), "edit-base", branch ?? "", parentDir],
		queryFn: () => api.tree(project, parentDir, branch),
		enabled: Boolean(branch),
		staleTime: Infinity,
	});
	const original = useQuery({
		queryKey: [...keys.code(project), "edit-file", branch ?? "", editing ?? ""],
		queryFn: () => api.file(project, editing as string, branch),
		enabled: Boolean(editing && branch),
		staleTime: Infinity,
	});

	const [path, setPath] = useState(editing ?? (dir ? `${dir}/` : ""));
	const [content, setContent] = useState<string | null>(editing ? null : "");
	const [message, setMessage] = useState("");
	const [target, setTarget] = useState<"same" | "new">("same");
	const [newBranch, setNewBranch] = useState("");
	useEffect(() => {
		if (original.data !== undefined && content === null) setContent(original.data);
	}, [original.data, content]);
	useEffect(() => {
		if (viewer.data && !newBranch) setNewBranch(`${viewer.data.username}-patch-1`);
	}, [viewer.data, newBranch]);

	const cleanPath = path.trim().replace(/^\/+|\/+$/g, "");
	const renamed = Boolean(editing && cleanPath !== editing);
	const defaultMessage = editing ? (renamed ? `Rename ${editing} to ${cleanPath}` : `Update ${editing}`) : `Create ${cleanPath || "file"}`;
	const tooBig = content !== null && new TextEncoder().encode(content).length > MAX_EDIT_BYTES;

	const commit = useMutation({
		mutationFn: () =>
			api.commitFiles(project, {
				branch: branch as string,
				baseCommit: base.data?.commit ?? null,
				newBranch: target === "new" ? newBranch.trim() : undefined,
				message: message.trim() || defaultMessage,
				files: [...(renamed ? [{ path: editing as string, content: null }] : []), { path: cleanPath, content: content ?? "" }],
			}),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["project", project] });
			const folder = cleanPath.split("/").slice(0, -1).join("/") || undefined;
			void navigate({
				to: "/$owner/$repo",
				params: repoParams(project),
				search: { ref: result.branch === info.data?.defaultBranch ? undefined : result.branch, path: folder, file: cleanPath },
			});
		},
	});

	if (info.isPending || viewer.isPending) return <Spinner className="m-4" />;
	if (!info.data?.repo.canWrite) {
		return <Empty title="You can't edit this repository">Only its owner can commit to it.</Empty>;
	}
	if (editing && original.error) return <ErrorNote error={original.error} />;
	if (content === null) return <Spinner className="m-4" />;

	const back = { ref, path: parentDir || undefined, file: editing };
	const moved = commit.error instanceof ApiError && commit.error.code === "BRANCH_MOVED";

	// Tab inserts a tab instead of leaving the editor.
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
		e.preventDefault();
		const el = e.currentTarget;
		const { selectionStart: start, selectionEnd: end } = el;
		const next = `${content.slice(0, start)}\t${content.slice(end)}`;
		setContent(next);
		requestAnimationFrame(() => el.setSelectionRange(start + 1, start + 1));
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				commit.mutate();
			}}
			className="space-y-3"
		>
			<Panel
				title={<span className="normal-case tracking-normal text-fg">{editing ? "Edit file" : "New file"}</span>}
				actions={
					<span className="flex items-center gap-1.5 text-[11px] text-faint">
						<GitBranch className="size-3.5" />
						<span className="font-mono text-dim">{branch}</span>
					</span>
				}
			>
				<div className="space-y-3 p-3">
					<Field label="Path" hint={editing ? "Change it to rename or move the file." : "Use slashes to put it in a folder; missing folders are created."}>
						<Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" autoFocus={!editing} required placeholder="docs/notes.md" />
					</Field>
					<textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						onKeyDown={onKeyDown}
						spellCheck={false}
						aria-label="File contents"
						autoFocus={Boolean(editing)}
						className="block min-h-[55vh] w-full resize-y rounded-md border border-line-strong bg-bg p-3 font-mono text-[12px] leading-5 text-fg outline-none focus:border-accent"
					/>
					{tooBig && <p className="text-xs text-rose-300">Files over 1 MB can't be edited here; push them with git.</p>}
				</div>
			</Panel>

			<Panel title="Commit">
				<div className="space-y-3 p-3">
					<Field label="Message">
						<Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={defaultMessage} />
					</Field>
					<fieldset className="space-y-2 text-sm">
						<label className="flex items-center gap-2">
							<input type="radio" checked={target === "same"} onChange={() => setTarget("same")} className="accent-accent" />
							<GitCommitHorizontal className="size-4 text-faint" />
							Commit directly to <span className="font-mono text-fg">{branch}</span>
						</label>
						<label className="flex flex-wrap items-center gap-2">
							<input type="radio" checked={target === "new"} onChange={() => setTarget("new")} className="accent-accent" />
							<GitBranch className="size-4 text-faint" />
							Create a new branch
							{target === "new" && (
								<Input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} className="ml-1 w-64 font-mono" required pattern="[A-Za-z0-9._/\-]+" />
							)}
						</label>
					</fieldset>
					{needsVerification && <p className="text-xs text-amber-200">Verify your email address before committing.</p>}
					<ErrorNote error={commit.error} />
					{moved && (
						<button type="button" onClick={() => location.reload()} className="text-xs text-accent hover:underline">
							Reload the latest version (your edits here will be lost; copy them first)
						</button>
					)}
					<div className="flex justify-end gap-2">
						<Link
							to="/$owner/$repo"
							params={repoParams(project)}
							search={back}
							className={cx("rounded-md px-3 py-1.5 text-sm text-dim hover:bg-raised hover:text-fg")}
						>
							Cancel
						</Link>
						<Button type="submit" variant="primary" busy={commit.isPending} disabled={!cleanPath || tooBig || needsVerification || !base.data}>
							Commit changes
						</Button>
					</div>
				</div>
			</Panel>
		</form>
	);
}
