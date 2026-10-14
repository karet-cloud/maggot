import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Download, Package, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { useState } from "react";
import { Markdown } from "../components/markdown.tsx";
import { MarkdownEditor } from "../components/markdown-editor.tsx";
import { BranchSelect } from "../components/refs.tsx";
import { Button, cx, Empty, ErrorNote, Field, Input, Modal, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, repoParams, type Release, type Tag } from "../lib/api.ts";

type Search = { tab?: "tags" };

export const Route = createFileRoute("/$owner/$repo/releases")({
	validateSearch: (s: Record<string, unknown>): Search => (s.tab === "tags" ? { tab: "tags" } : {}),
	component: Releases,
});

function Releases() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const { tab } = Route.useSearch();
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const writable = Boolean(info.data?.repo.canWrite && !info.data.repo.archivedAt);
	const [creating, setCreating] = useState(false);
	const sub = (active: boolean) =>
		cx("-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", active ? "border-accent text-fg" : "border-transparent text-dim hover:text-fg");

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line">
				<nav className="flex gap-1">
					<Link from={Route.fullPath} search={{}} className={sub(tab !== "tags")}>
						<Package className="size-3.5" />
						Releases
					</Link>
					<Link from={Route.fullPath} search={{ tab: "tags" }} className={sub(tab === "tags")}>
						<TagIcon className="size-3.5" />
						Tags
					</Link>
				</nav>
				{writable && (
					<Button variant="primary" className="mb-1.5 text-xs" onClick={() => setCreating(true)}>
						<Plus className="size-3.5" />
						{tab === "tags" ? "New tag" : "New release"}
					</Button>
				)}
			</div>
			{tab === "tags" ? <TagList project={project} writable={writable} /> : <ReleaseList project={project} writable={writable} />}
			<Modal open={creating} onClose={() => setCreating(false)} title={tab === "tags" ? "New tag" : "New release"}>
				{tab === "tags" ? <NewTag project={project} onDone={() => setCreating(false)} /> : <NewRelease project={project} onDone={() => setCreating(false)} />}
			</Modal>
		</div>
	);
}

/** Source downloads of a tag, by its full ref name so a branch with the same name can't be mistaken for it. */
function Downloads({ project, refName }: { project: string; refName: string }) {
	return (
		<span className="flex flex-wrap items-center gap-3 text-xs">
			{(["zip", "tar.gz"] as const).map((format) => (
				<a key={format} href={api.archiveUrl(project, format, refName)} className="flex items-center gap-1 text-dim hover:text-accent">
					<Download className="size-3.5" />
					Source code (.{format})
				</a>
			))}
		</span>
	);
}

function ReleaseList({ project, writable }: { project: string; writable: boolean }) {
	const [limit, setLimit] = useState(20);
	const page = useQuery({ queryKey: [...keys.releases(project), limit], queryFn: () => api.releases(project, limit), placeholderData: keepPreviousData });
	const releases = { ...page, data: page.data?.releases };
	if (releases.isPending) return <Spinner />;
	if (releases.error) return <ErrorNote error={releases.error} />;
	if (!releases.data) return null;
	if (releases.data.length === 0) {
		return (
			<Empty icon={<Package className="size-6" />} title="No releases yet">
				A release marks a tag with notes and source downloads.
			</Empty>
		);
	}
	const latest = releases.data.findIndex((x) => !x.prerelease);
	return (
		<div className="space-y-4">
			<ol className="space-y-4">
				{releases.data.map((r, i) => (
					<li key={r.id}>
						<ReleaseCard project={project} release={r} latest={i === latest} writable={writable} />
					</li>
				))}
			</ol>
			{page.data?.more && (
				<div className="text-center">
					<Button busy={page.isFetching} onClick={() => setLimit((n) => Math.min(n + 20, 200))} disabled={limit >= 200}>
						{limit >= 200 ? "Showing the newest 200" : "Show older releases"}
					</Button>
				</div>
			)}
		</div>
	);
}

function ReleaseCard({ project, release: r, latest, writable }: { project: string; release: Release; latest: boolean; writable: boolean }) {
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(r.name);
	const [notes, setNotes] = useState(r.notes);
	const [prerelease, setPrerelease] = useState(r.prerelease);
	const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.releases(project) });
	const save = useMutation({
		mutationFn: () => api.updateRelease(project, r.id, { name, notes, prerelease }),
		onSuccess: () => {
			setEditing(false);
			refresh();
		},
	});
	const remove = useMutation({
		mutationFn: (deleteTag: boolean) => api.deleteRelease(project, r.id, deleteTag),
		onSuccess: () => {
			refresh();
			void queryClient.invalidateQueries({ queryKey: keys.tags(project) });
		},
	});
	return (
		<Panel>
			<div className="space-y-3 p-4">
				<div className="flex flex-wrap items-start gap-3">
					<div className="min-w-0 flex-1">
						<h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
							{r.name}
							{latest && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">Latest</span>}
							{r.prerelease && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">Pre-release</span>}
						</h2>
						<p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
							<Link to="/$owner/$repo" params={repoParams(project)} search={{ ref: `refs/tags/${r.tag}` }} className="flex items-center gap-1 font-mono text-dim hover:text-accent">
								<TagIcon className="size-3" />
								{r.tag}
							</Link>
							{r.commit ? (
								<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: r.commit }} className="font-mono hover:text-accent">
									{r.commit.slice(0, 7)}
								</Link>
							) : (
								<span className="text-amber-300">tag deleted</span>
							)}
							<span>
								{r.author ? `${r.author} released this ` : "Released "}
								<TimeAgo at={r.createdAt} />
							</span>
						</p>
					</div>
					{writable && !editing && (
						<div className="flex gap-1">
							<Button variant="ghost" className="px-2 text-xs" onClick={() => setEditing(true)} aria-label="Edit release">
								<Pencil className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								className="px-2 text-xs hover:text-red-300"
								busy={remove.isPending}
								aria-label="Delete release"
								onClick={() => {
									if (!confirm(`Delete the release ${r.name}?`)) return;
									remove.mutate(r.commit !== null && confirm(`Delete the tag ${r.tag} too? Cancel keeps the tag.`));
								}}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					)}
				</div>
				{editing ? (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							save.mutate();
						}}
						className="space-y-3"
					>
						<Field label="Title">
							<Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
						</Field>
						<MarkdownEditor value={notes} onChange={setNotes} project={project} label="Release notes" rows={8} />
						<label className="flex items-center gap-2 text-sm text-dim">
							<input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />
							Pre-release
						</label>
						<ErrorNote error={save.error} />
						<div className="flex justify-end gap-2">
							<Button onClick={() => setEditing(false)}>Cancel</Button>
							<Button type="submit" variant="primary" busy={save.isPending}>
								Save
							</Button>
						</div>
					</form>
				) : r.notes.trim() ? (
					<Markdown source={r.notes} project={project} path="" refName={`refs/tags/${r.tag}`} />
				) : (
					<p className="text-sm text-faint italic">No release notes.</p>
				)}
				<ErrorNote error={remove.error} />
				{r.commit && (
					<div className="border-t border-line pt-3">
						<Downloads project={project} refName={`refs/tags/${r.tag}`} />
					</div>
				)}
			</div>
		</Panel>
	);
}

function TagList({ project, writable }: { project: string; writable: boolean }) {
	const queryClient = useQueryClient();
	const tags = useQuery({ queryKey: keys.tags(project), queryFn: () => api.tags(project) });
	const remove = useMutation({
		mutationFn: (name: string) => api.deleteTag(project, name),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.tags(project) }),
	});
	if (tags.isPending) return <Spinner />;
	if (tags.error) return <ErrorNote error={tags.error} />;
	if (tags.data.length === 0) {
		return (
			<Empty icon={<TagIcon className="size-6" />} title="No tags yet">
				Push one with <code className="font-mono">git push origin v1.0</code>, or create one here.
			</Empty>
		);
	}
	return (
		<Panel>
			<ErrorNote error={remove.error} />
			<ul className="divide-y divide-line/60">
				{tags.data.map((t: Tag) => (
					<li key={t.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
						<TagIcon className="size-4 text-faint" />
						<div className="min-w-0 flex-1">
							<Link to="/$owner/$repo" params={repoParams(project)} search={{ ref: `refs/tags/${t.name}` }} className="font-mono text-sm font-medium text-fg hover:text-accent">
								{t.name}
							</Link>
							<p className="mt-0.5 truncate text-xs text-faint">
								<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: t.commit }} className="font-mono hover:text-accent">
									{t.commit.slice(0, 7)}
								</Link>
								{t.summary && (
									<>
										{" "}
										· {t.summary.message} · <TimeAgo at={t.summary.committedAt} />
									</>
								)}
								{t.annotated && " · annotated"}
							</p>
						</div>
						<Downloads project={project} refName={`refs/tags/${t.name}`} />
						{writable && (
							<Button
								variant="ghost"
								className="px-2 text-xs hover:text-red-300"
								busy={remove.isPending && remove.variables === t.name}
								onClick={() => confirm(`Delete the tag ${t.name}? Releases of it stay, without downloads.`) && remove.mutate(t.name)}
								aria-label={`Delete ${t.name}`}
							>
								<Trash2 className="size-3.5" />
							</Button>
						)}
					</li>
				))}
			</ul>
		</Panel>
	);
}

function NewTag({ project, onDone }: { project: string; onDone: () => void }) {
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [target, setTarget] = useState<string | undefined>();
	const create = useMutation({
		mutationFn: () => api.createTag(project, name.trim(), target),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: keys.tags(project) });
			onDone();
		},
	});
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				create.mutate();
			}}
			className="space-y-3"
		>
			<Field label="Tag name">
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.0.0" required autoFocus />
			</Field>
			<Field label="At">
				<BranchSelect project={project} value={target} onChange={setTarget} branchesOnly />
			</Field>
			<ErrorNote error={create.error} />
			<div className="flex justify-end gap-2">
				<Button onClick={onDone}>Cancel</Button>
				<Button type="submit" variant="primary" busy={create.isPending}>
					Create tag
				</Button>
			</div>
		</form>
	);
}

function NewRelease({ project, onDone }: { project: string; onDone: () => void }) {
	const queryClient = useQueryClient();
	const tags = useQuery({ queryKey: keys.tags(project), queryFn: () => api.tags(project) });
	const [tag, setTag] = useState("");
	const [target, setTarget] = useState<string | undefined>();
	const [name, setName] = useState("");
	const [notes, setNotes] = useState("");
	const [prerelease, setPrerelease] = useState(false);
	const exists = tags.data?.some((t) => t.name === tag.trim()) ?? false;
	const create = useMutation({
		mutationFn: () => api.createRelease(project, { tag: tag.trim(), target: exists ? undefined : target, name: name.trim() || undefined, notes, prerelease }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: keys.releases(project) });
			void queryClient.invalidateQueries({ queryKey: keys.tags(project) });
			onDone();
		},
	});
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				create.mutate();
			}}
			className="space-y-3"
		>
			<Field label="Tag" hint={tag.trim() ? (exists ? "Releases this existing tag." : "A new tag, created when you publish.") : "Pick a tag, or type a new one."}>
				<Input value={tag} onChange={(e) => setTag(e.target.value)} list="release-tags" placeholder="v1.0.0" required autoFocus />
				<datalist id="release-tags">
					{tags.data?.map((t) => (
						<option key={t.name} value={t.name} />
					))}
				</datalist>
			</Field>
			{tag.trim() && !exists && (
				<Field label="Tag the head of">
					<BranchSelect project={project} value={target} onChange={setTarget} branchesOnly />
				</Field>
			)}
			<Field label="Title">
				<Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tag.trim() || "Defaults to the tag"} maxLength={200} />
			</Field>
			<MarkdownEditor value={notes} onChange={setNotes} project={project} label="Release notes" placeholder="What's new, what changed, what to watch out for" rows={6} />
			<label className="flex items-center gap-2 text-sm text-dim">
				<input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />
				This is a pre-release
			</label>
			<ErrorNote error={create.error} />
			<div className="flex justify-end gap-2">
				<Button onClick={onDone}>Cancel</Button>
				<Button type="submit" variant="primary" busy={create.isPending}>
					Publish release
				</Button>
			</div>
		</form>
	);
}
