import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ArrowRightLeft, BookOpen, PencilLine, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { VisibilityBadge } from "../components/repos.tsx";
import { Webhooks } from "../components/webhooks.tsx";
import { BranchProtection } from "../components/branch-protection.tsx";
import { ActionsSettings } from "../components/actions.tsx";
import { Collaborators } from "../components/collaborators.tsx";
import { Button, ErrorNote, Field, Input, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, type RepoInfo, type Visibility } from "../lib/api.ts";

export const Route = createFileRoute("/$owner/$repo/settings")({ component: RepoSettings });

function RepoSettings() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const info = useQuery({ queryKey: keys.project(project), queryFn: () => api.project(project) });
	const [description, setDescription] = useState("");
	useEffect(() => setDescription(info.data?.repo.description ?? ""), [info.data?.repo.description]);
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: keys.project(project) });
		void queryClient.invalidateQueries({ queryKey: ["repos"] });
	};
	const update = useMutation({
		mutationFn: (patch: { visibility?: Visibility; description?: string | null; archived?: boolean; hasWiki?: boolean }) => api.updateRepo(project, patch),
		onSuccess: refresh,
	});
	const remove = useMutation({
		mutationFn: () => api.deleteRepo(project),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
			void navigate({ to: "/$owner", params: { owner } });
		},
	});

	if (info.isPending) return <Spinner />;
	if (!info.data?.repo.canAdmin) return <p className="text-sm text-dim">Only the repository's admins can change settings.</p>;
	const current = info.data.repo;
	const archived = Boolean(current.archivedAt);
	const other: Visibility = current.visibility === "public" ? "private" : "public";
	return (
		<div className="max-w-3xl space-y-4">
			{archived && (
				<p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
					Archived repositories are read-only, settings included. Unarchive it below to change anything else.
				</p>
			)}
			<Panel title="General">
				<div className="divide-y divide-line">
					<Rename project={project} repo={current} disabled={archived} />
					<form
						onSubmit={(e) => {
							e.preventDefault();
							update.mutate({ description: description.trim() || null });
						}}
						className="space-y-3 p-4"
					>
						<Field label="Description">
							<Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" disabled={archived} />
						</Field>
						<Button type="submit" busy={update.isPending && update.variables?.description !== undefined} disabled={archived}>
							Save
						</Button>
					</form>
				</div>
			</Panel>
			<Panel title="Visibility">
				<div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
					<p className="flex items-center gap-2 text-dim">
						This repository is <VisibilityBadge visibility={current.visibility} />
						{current.visibility === "public" ? "Anyone can browse and clone it." : "Only you can see and clone it."}
					</p>
					<Button
						busy={update.isPending && update.variables?.visibility !== undefined}
						disabled={archived}
						onClick={() => confirm(`Make ${project} ${other}?`) && update.mutate({ visibility: other })}
					>
						Make {other}
					</Button>
				</div>
			</Panel>
			<Panel title="Features">
				<label className="flex items-start gap-3 p-4 text-sm">
					<input
						type="checkbox"
						checked={current.hasWiki}
						disabled={archived || update.isPending}
						onChange={(e) => update.mutate({ hasWiki: e.target.checked })}
						className="mt-0.5 accent-accent"
					/>
					<span>
						<span className="flex items-center gap-1.5 text-fg">
							<BookOpen className="size-4 text-faint" />
							Wiki
						</span>
						<span className="text-xs text-dim">
							Pages of documentation, edited here or cloned from <code className="font-mono">{current.wikiUrl}</code>. Turned off, the tab and the wiki's
							address go away, but its pages are kept.
						</span>
					</span>
				</label>
			</Panel>
			<ErrorNote error={update.error} />
			{!archived && <Collaborators project={project} />}
			{!archived && <BranchProtection project={project} defaultBranch={current.defaultBranch} />}
			<ActionsSettings project={project} archived={archived} />
			<Webhooks project={project} archived={archived} />
			<Panel title="Danger zone" className="border-red-500/30">
				<div className="divide-y divide-line">
					{current.isOwner && <Transfer project={project} />}
					<div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
						{archived ? (
							<p className="min-w-0 flex-1 text-dim">
								Archived <TimeAgo at={current.archivedAt as string} />. Unarchive it to push, edit files and run agent tasks again.
							</p>
						) : (
							<p className="min-w-0 flex-1 text-dim">
								Archive the repository to make it read-only: it can still be cloned, forked and starred, but nobody can push to it. Finish or
								abandon any agent tasks first.
							</p>
						)}
						<Button
							busy={update.isPending && update.variables?.archived !== undefined}
							onClick={() =>
								archived ? update.mutate({ archived: false }) : confirm(`Archive ${project}? It becomes read-only until you unarchive it.`) && update.mutate({ archived: true })
							}
						>
							{archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
							{archived ? "Unarchive" : "Archive"}
						</Button>
					</div>
					{current.isOwner ? (
						<div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
							<p className="min-w-0 flex-1 text-dim">Delete the repository, its history, every agent fork, and all task records. This can't be undone.</p>
							<Button variant="danger" busy={remove.isPending} onClick={() => prompt(`Type ${project} to delete it`) === project && remove.mutate()}>
								<Trash2 className="size-4" />
								Delete
							</Button>
						</div>
					) : (
						<p className="p-4 text-sm text-dim">Only {current.owner} (or its owners, for an organization) can transfer or delete this repository.</p>
					)}
				</div>
				<div className="px-4 pb-3">
					<ErrorNote error={remove.error} />
				</div>
			</Panel>
		</div>
	);
}

function Rename({ project, repo, disabled }: { project: string; repo: RepoInfo; disabled: boolean }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [name, setName] = useState(repo.name);
	useEffect(() => setName(repo.name), [repo.name]);
	const rename = useMutation({
		mutationFn: () => api.updateRepo(project, { name: name.trim() }),
		onSuccess: (updated) => {
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
			void navigate({ to: "/$owner/$repo/settings", params: { owner: updated.owner, repo: updated.name }, replace: true });
		},
	});
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				rename.mutate();
			}}
			className="space-y-3 p-4"
		>
			<Field label="Repository name" hint="The old name keeps working for links and git remotes, until you give another repository that name.">
				<div className="flex gap-2">
					<Input value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9._\-]{1,100}" required disabled={disabled} />
					<Button type="submit" busy={rename.isPending} disabled={disabled || name.trim() === repo.name} className="shrink-0">
						<PencilLine className="size-4" />
						Rename
					</Button>
				</div>
			</Field>
			<ErrorNote error={rename.error} />
		</form>
	);
}

function Transfer({ project }: { project: string }) {
	const queryClient = useQueryClient();
	const pending = useQuery({ queryKey: keys.transfer(project), queryFn: () => api.transfer(project) });
	const [to, setTo] = useState("");
	const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.transfer(project) });
	const offer = useMutation({
		mutationFn: () => api.offerTransfer(project, to.trim()),
		onSuccess: () => {
			setTo("");
			refresh();
		},
	});
	const cancel = useMutation({ mutationFn: () => api.cancelTransfer(project), onSuccess: refresh });
	const transfer = pending.data;
	return (
		<div className="space-y-3 p-4 text-sm">
			{transfer ? (
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-dim">
						Waiting for <span className="font-mono text-fg">{transfer.to}</span> to accept (offered <TimeAgo at={transfer.createdAt} />, expires{" "}
						<TimeAgo at={transfer.expiresAt} />
						). Until then it stays yours.
					</p>
					<Button busy={cancel.isPending} onClick={() => cancel.mutate()}>
						<X className="size-4" />
						Cancel transfer
					</Button>
				</div>
			) : (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (confirm(`Offer ${project} to ${to.trim()}? Once they accept, it's theirs and you lose access unless it's public.`)) offer.mutate();
					}}
					className="space-y-3"
				>
					<p className="text-dim">
						Hand the repository to another user. They get a notification and have a week to accept; the old address keeps working afterwards.
					</p>
					<div className="flex gap-2">
						<Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Their username" required aria-label="New owner's username" />
						<Button type="submit" busy={offer.isPending} className="shrink-0">
							<ArrowRightLeft className="size-4" />
							Transfer
						</Button>
					</div>
				</form>
			)}
			<ErrorNote error={pending.error ?? offer.error ?? cancel.error} />
		</div>
	);
}
