import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FolderGit2, GitMerge, Plus } from "lucide-react";
import { useState } from "react";
import { Button, cx, Empty, ErrorNote, Field, Input, Modal, Oid, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, type Project } from "../lib/api.ts";
import { STATUS } from "../lib/format.ts";

export const Route = createFileRoute("/")({ component: Projects });

function Projects() {
	const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects, refetchInterval: 10_000 });
	const [creating, setCreating] = useState(false);
	const list = [...(projects.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	return (
		<main className="mx-auto max-w-[1600px] px-5 py-8">
			<div className="mb-6 flex items-end justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Projects</h1>
					<p className="mt-1 text-sm text-dim">Each project is an Artifacts repo with its own fork queue and merge queue.</p>
				</div>
				<Button variant="primary" onClick={() => setCreating(true)}>
					<Plus className="size-4" />
					New project
				</Button>
			</div>

			{projects.isPending && <Spinner />}
			<ErrorNote error={projects.error} />
			{projects.data && list.length === 0 && (
				<Empty icon={<FolderGit2 className="size-6" />} title="No projects yet">
					Create one here or with <code className="font-mono">megit init &lt;name&gt;</code>, then point agents at it.
				</Empty>
			)}
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{list.map((p) => (
					<ProjectCard key={p.name} project={p} />
				))}
			</div>

			<Modal open={creating} onClose={() => setCreating(false)} title="New project">
				<CreateProject onDone={() => setCreating(false)} />
			</Modal>
		</main>
	);
}

function ProjectCard({ project: p }: { project: Project }) {
	const active = p.stats.provisioning + p.stats.open + p.stats.queued + p.stats.merging;
	const attention = p.stats.conflict + p.stats.failed;
	return (
		<Link
			to="/p/$project"
			params={{ project: p.name }}
			className="group block rounded-lg border border-line bg-panel p-4 transition-colors hover:border-line-strong hover:bg-raised"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="truncate font-mono text-[15px] font-medium group-hover:text-accent">{p.name}</h2>
					<p className="mt-0.5 truncate text-sm text-dim">{p.description || <span className="text-faint">No description</span>}</p>
				</div>
				{p.queueLength > 0 && (
					<span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-400/30 ring-inset">
						<GitMerge className="size-3" />
						{p.queueLength} queued
					</span>
				)}
			</div>
			<StatusBar stats={p.stats} />
			<div className="mt-3 flex items-center gap-3 text-xs text-faint">
				<span className="font-mono">{p.defaultBranch}</span>
				<Oid oid={p.head} />
				<span className="ml-auto flex gap-3">
					<span>
						<b className="font-medium text-dim">{active}</b> active
					</span>
					<span>
						<b className="font-medium text-dim">{p.stats.merged}</b> merged
					</span>
					{attention > 0 && <span className="text-rose-300">{attention} need attention</span>}
				</span>
			</div>
			<div className="mt-1 text-[11px] text-faint">
				created <TimeAgo at={p.createdAt} />
			</div>
		</Link>
	);
}

/** Proportional bar of task statuses (abandoned left out). */
function StatusBar({ stats }: { stats: Project["stats"] }) {
	const order = ["merged", "merging", "queued", "open", "provisioning", "conflict", "failed"] as const;
	const total = order.reduce((n, s) => n + stats[s], 0);
	return (
		<div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-raised">
			{total > 0 &&
				order.map((s) =>
					stats[s] ? <div key={s} title={`${stats[s]} ${STATUS[s].label}`} className={cx(STATUS[s].dot)} style={{ width: `${(stats[s] / total) * 100}%` }} /> : null,
				)}
		</div>
	);
}

function CreateProject({ onDone }: { onDone: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [importUrl, setImportUrl] = useState("");
	const [readme, setReadme] = useState(false);
	const create = useMutation({
		mutationFn: () =>
			api.createProject({
				name: name.trim(),
				description: description.trim() || undefined,
				importUrl: importUrl.trim() || undefined,
				readme,
			}),
		onSuccess: (project) => {
			void queryClient.invalidateQueries({ queryKey: keys.projects });
			onDone();
			void navigate({ to: "/p/$project", params: { project: project.name } });
		},
	});
	return (
		<form
			className="space-y-4"
			onSubmit={(e) => {
				e.preventDefault();
				create.mutate();
			}}
		>
			<Field label="Name" hint="Lowercase letters, digits, - and _. 2–40 characters.">
				<Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="my-app" pattern="[a-z0-9][a-z0-9_\-]{1,39}" required autoFocus />
			</Field>
			<Field label="Description">
				<Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
			</Field>
			<Field label="Import from" hint="Optional. A public Git URL for Artifacts to import.">
				<Input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" type="url" />
			</Field>
			{!importUrl.trim() && (
				<label className="flex items-start gap-2.5 text-sm">
					<input type="checkbox" checked={readme} onChange={(e) => setReadme(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
					<span>
						<span className="text-fg">Add a README</span>
						<span className="block text-xs text-faint">Leave this off to push an existing repository with git after creating it.</span>
					</span>
				</label>
			)}
			<ErrorNote error={create.error} />
			<div className="flex justify-end gap-2 pt-1">
				<Button onClick={onDone}>Cancel</Button>
				<Button type="submit" variant="primary" busy={create.isPending}>
					Create project
				</Button>
			</div>
		</form>
	);
}
