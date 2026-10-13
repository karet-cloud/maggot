import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Archive, Bot, FolderCode, GitBranch, GitFork, History, Plus, Radio, Search, Settings, Star, Terminal } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { EventFeed } from "../components/events.tsx";
import { NewTask } from "../components/new-task.tsx";
import { CloneUrl, RepoCommands } from "../components/repo-access.tsx";
import { ArchivedBadge, ForkedFrom, VisibilityBadge } from "../components/repos.tsx";
import { Button, cx, Empty, ErrorNote, Field, Input, Modal, Oid, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, keys, repoParams, type RepoInfo, type Task } from "../lib/api.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";
import { useProjectTasks } from "../lib/queries.ts";
import { LiveContext, useProjectLive, type LiveStatus } from "../lib/live.ts";

export const Route = createFileRoute("/$owner/$repo")({ component: ProjectLayout });

function ProjectLayout() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const live = useProjectLive(project);
	// Pushes through megit's git URL emit events, but poll the head too (quickly while the repo is empty).
	const info = useQuery({
		queryKey: keys.project(project),
		queryFn: () => api.project(project),
		refetchInterval: (q) => (q.state.data && !q.state.data.head ? 3000 : 15_000),
	});
	const tasks = useProjectTasks(project);
	const byId = useMemo(() => new Map<string, Task>((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
	const [creating, setCreating] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [forking, setForking] = useState(false);
	const p = info.data;
	const navigate = useNavigate();
	const location = useRouterState({ select: (s) => s.location });
	// An old name (the repository was renamed or transferred) or a different spelling: show the current one.
	const canonical = p?.repo.fullName;
	useEffect(() => {
		if (!canonical || canonical === project) return;
		// The URL's own first two segments, not the params, which can lag a navigation behind.
		const [, urlOwner = "", urlRepo = "", ...rest] = location.pathname.split("/");
		if (`${decodeURIComponent(urlOwner)}/${decodeURIComponent(urlRepo)}` !== project) return;
		const [newOwner, newRepo] = canonical.split("/").map(encodeURIComponent);
		const path = ["", newOwner, newRepo, ...rest].join("/");
		void navigate({ href: `${path}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`, replace: true });
	}, [canonical, project, location, navigate]);

	if (info.error) {
		const missing = info.error instanceof ApiError && info.error.status === 404;
		return (
			<main className="mx-auto max-w-xl px-5 py-16">
				<Empty title={missing ? "Repository not found" : "Couldn't load this repository"}>
					{missing ? "It doesn't exist, or it's private and you're not signed in as its owner." : info.error.message}
				</Empty>
			</main>
		);
	}
	const canWrite = p?.repo.canWrite ?? false;
	const archived = Boolean(p?.repo.archivedAt);

	return (
		<LiveContext.Provider value={live}>
			<div className="border-b border-line bg-panel/40">
				<div className="mx-auto max-w-[1600px] px-5 pt-5">
					<div className="flex flex-wrap items-start justify-between gap-4">
						<div className="min-w-0">
							<div className="flex items-center gap-3">
								<h1 className="min-w-0 break-all font-mono text-xl font-semibold tracking-tight">{project}</h1>
								{p && <VisibilityBadge visibility={p.repo.visibility} />}
								{archived && <ArchivedBadge />}
								<LiveDot status={live.status} />
							</div>
							{p?.repo.forkOf && <ForkedFrom source={p.repo.forkOf} className="mt-1" />}
							<p className="mt-1 text-sm text-dim">{p ? p.description || "No description" : <Spinner className="inline" />}</p>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							{p && <StarButton project={project} repo={p.repo} />}
							{p && (
								<div className="flex items-center">
									<Button onClick={() => setForking(true)} className="rounded-r-none" disabled={!p.head} title={p.head ? "Copy this repository, with all its branches, into your account" : "Nothing to fork yet"}>
										<GitFork className="size-4" />
										Fork
									</Button>
									<Link
										to="/$owner/$repo/forks"
										params={{ owner, repo }}
										className="rounded-r-md border border-l-0 border-line bg-raised px-2.5 py-1.5 text-sm tabular-nums text-dim hover:text-fg"
										title="Forks"
									>
										{p.repo.forks}
									</Link>
								</div>
							)}
							<Button onClick={() => setConnecting(true)}>
								<Terminal className="size-4" />
								Clone / push
							</Button>
							{canWrite && (
								<Button
									variant="primary"
									onClick={() => setCreating(true)}
									disabled={(p !== undefined && !p.head) || archived}
									title={archived ? "Archived repositories are read-only" : p && !p.head ? "Push a first commit before creating tasks" : "Give an agent its own fork to work in"}
								>
									<Plus className="size-4" />
									New agent task
								</Button>
							)}
						</div>
					</div>
					{p && (
						<div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-dim">
							<span>
								<span className="text-faint">branch</span> <span className="font-mono text-fg">{p.defaultBranch}</span>
							</span>
							<span className="flex items-center gap-1.5">
								<span className="text-faint">head</span> <Oid oid={p.head} />
							</span>
							<span>
								<span className="text-faint">active</span>{" "}
								<b className="font-medium text-fg">{p.stats.provisioning + p.stats.open + p.stats.queued + p.stats.merging}</b>
							</span>
							<span>
								<span className="text-faint">queue</span> <b className="font-medium text-fg">{p.queueLength}</b>
							</span>
							<span>
								<span className="text-faint">merged</span> <b className="font-medium text-emerald-300">{p.stats.merged}</b>
							</span>
							{p.stats.conflict + p.stats.failed > 0 && (
								<span>
									<span className="text-faint">attention</span> <b className="font-medium text-rose-300">{p.stats.conflict + p.stats.failed}</b>
								</span>
							)}
							<div className="w-full min-w-0 max-w-md sm:ml-auto sm:w-auto sm:min-w-96">
								<CloneUrl repo={p.repo} />
							</div>
						</div>
					)}
					{p?.repo.archivedAt && (
						<p className="mt-4 flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
							<Archive className="size-4 shrink-0 text-amber-300" />
							<span>
								This repository was archived <TimeAgo at={p.repo.archivedAt} />. It's read-only: you can clone, fork and star it, but nobody can push to it.
							</span>
						</p>
					)}
					<nav className="-mx-5 mt-4 flex gap-1 overflow-x-auto px-5">
						<Tab to="/$owner/$repo" project={project} icon={<FolderCode className="size-3.5" />} label="Code" exact />
						<Tab to="/$owner/$repo/history" project={project} icon={<History className="size-3.5" />} label="History" />
						<Tab to="/$owner/$repo/branches" project={project} icon={<GitBranch className="size-3.5" />} label="Branches" />
						<Tab to="/$owner/$repo/agents" project={project} icon={<Bot className="size-3.5" />} label="Agents" />
						<Tab to="/$owner/$repo/search" project={project} icon={<Search className="size-3.5" />} label="Search code" />
						{canWrite && <Tab to="/$owner/$repo/settings" project={project} icon={<Settings className="size-3.5" />} label="Settings" />}
					</nav>
				</div>
			</div>

			<div className="mx-auto grid max-w-[1600px] gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="min-w-0">
					<Outlet />
				</div>
				<aside className="lg:sticky lg:top-17 lg:max-h-[calc(100vh-5.5rem)]">
					<Panel
						title="Activity"
						actions={<span className="text-[11px] text-faint">{live.events.length} events</span>}
						className="flex max-h-[inherit] flex-col overflow-hidden"
					>
						<div className="min-h-0 flex-1 overflow-y-auto">
							<EventFeed events={live.events} tasks={byId} project={project} />
						</div>
					</Panel>
				</aside>
			</div>

			<Modal open={connecting} onClose={() => setConnecting(false)} title={`Use ${project} with git`}>
				{p && <RepoCommands repo={p.repo} empty={!p.head} />}
			</Modal>
			<Modal open={forking} onClose={() => setForking(false)} title={`Fork ${project}`}>
				{p && <ForkDialog project={project} repo={p.repo} onClose={() => setForking(false)} />}
			</Modal>
			<Modal open={creating} onClose={() => setCreating(false)} title="New task">
				<NewTask project={project} onClose={() => setCreating(false)} />
			</Modal>
		</LiveContext.Provider>
	);
}

function StarButton({ project, repo }: { project: string; repo: RepoInfo }) {
	const viewer = useViewer();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const star = useMutation({
		mutationFn: (starred: boolean) => api.star(project, starred),
		onSuccess: ({ starred, stars }) => {
			queryClient.setQueryData(keys.project(project), (old: Awaited<ReturnType<typeof api.project>> | undefined) =>
				old ? { ...old, repo: { ...old.repo, starred, stars } } : old,
			);
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
		},
	});
	return (
		<div className="flex items-center">
			<Button
				onClick={() => (viewer.data ? star.mutate(!repo.starred) : navigate({ to: "/login" }))}
				busy={star.isPending}
				className="rounded-r-none"
				title={viewer.data ? (repo.starred ? "Unstar" : "Star this repository") : "Sign in to star"}
			>
				<Star className={cx("size-4", repo.starred && "fill-amber-300 text-amber-300")} />
				{repo.starred ? "Starred" : "Star"}
			</Button>
			<span className="rounded-r-md border border-l-0 border-line bg-raised px-2.5 py-1.5 text-sm tabular-nums text-dim">{repo.stars}</span>
		</div>
	);
}

function ForkDialog({ project, repo, onClose }: { project: string; repo: RepoInfo; onClose: () => void }) {
	const viewer = useViewer();
	const needsVerification = useNeedsVerification();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	// Forking your own repository needs another name.
	const [name, setName] = useState(repo.canWrite ? `${repo.name}-fork` : repo.name);
	const fork = useMutation({
		mutationFn: () => api.fork(project, name.trim()),
		onSuccess: (created) => {
			void queryClient.invalidateQueries({ queryKey: ["repos"] });
			void queryClient.invalidateQueries({ queryKey: keys.me });
			void queryClient.invalidateQueries({ queryKey: keys.forks(project) });
			onClose();
			void navigate({ to: "/$owner/$repo", params: { owner: created.owner, repo: created.name } });
		},
	});
	if (!viewer.data) {
		return (
			<p className="text-sm text-dim">
				<Link to="/login" className="text-accent hover:underline">
					Sign in
				</Link>{" "}
				to fork this repository.
			</p>
		);
	}
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				fork.mutate();
			}}
			className="space-y-4"
		>
			<p className="text-sm text-dim">
				A fork is your own copy of the repository, with every branch and tag. Push to it, then compare it with the original.
				{repo.visibility === "private" && " It stays private."}
			</p>
			<div className="flex items-end gap-2">
				<div className="pb-2 font-mono text-sm text-dim">{viewer.data.username} /</div>
				<div className="flex-1">
					<Field label="Repository name">
						<Input value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9._\-]{1,100}" autoFocus required />
					</Field>
				</div>
			</div>
			{needsVerification && <p className="text-xs text-amber-200">Verify your email address before forking.</p>}
			<ErrorNote error={fork.error} />
			<div className="flex justify-end gap-2">
				<Button onClick={onClose}>Cancel</Button>
				<Button type="submit" variant="primary" busy={fork.isPending} disabled={needsVerification}>
					<GitFork className="size-4" />
					Create fork
				</Button>
			</div>
		</form>
	);
}

type TabTarget =
	| "/$owner/$repo"
	| "/$owner/$repo/agents"
	| "/$owner/$repo/history"
	| "/$owner/$repo/branches"
	| "/$owner/$repo/search"
	| "/$owner/$repo/settings";

function Tab({ to, project, icon, label, exact }: { to: TabTarget; project: string; icon: ReactNode; label: string; exact?: boolean }) {
	return (
		<Link
			to={to}
			params={repoParams(project)}
			activeOptions={{ exact, includeSearch: false }}
			className="-mb-px flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-sm text-dim hover:text-fg data-[status=active]:border-accent data-[status=active]:text-fg"
		>
			{icon}
			{label}
		</Link>
	);
}

function LiveDot({ status }: { status: LiveStatus }) {
	const label = { connecting: "Connecting", live: "Live", offline: "Reconnecting" }[status];
	return (
		<span
			className={cx(
				"flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
				status === "live" ? "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30" : "bg-zinc-500/10 text-dim ring-zinc-500/30",
			)}
		>
			<Radio className={cx("size-3", status === "live" && "animate-pulse-dot")} />
			{label}
		</span>
	);
}
