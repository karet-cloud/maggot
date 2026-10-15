import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Activity, Archive, BookOpen, Bot, CircleDot, FolderCode, GitBranch, GitFork, GitPullRequest, History, Package, Plus, Search, Settings, Star, Workflow } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NewTask } from "../components/new-task.tsx";
import { ArchivedBadge, ForkedFrom, VisibilityBadge } from "../components/repos.tsx";
import { Button, cx, Empty, ErrorNote, Field, Input, Modal, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, ApiError, keys, repoParams, type RepoInfo } from "../lib/api.ts";
import { useNeedsVerification, useViewer } from "./__root.tsx";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { preload, projectQuery, tasksQuery } from "../lib/queries.ts";
import { eventsQuery, LiveContext, useProjectLive } from "../lib/live.ts";

export const Route = createFileRoute("/$owner/$repo")({
	loader: ({ context, params }) => {
		const project = `${params.owner}/${params.repo}`;
		return preload(context.queryClient, projectQuery(project), tasksQuery(project), eventsQuery(project));
	},
	component: ProjectLayout,
});

function ProjectLayout() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const live = useProjectLive(project);
	// Pushes through maggot's git URL emit events, but poll the head too (quickly while the repo is empty).
	const info = useQuery({
		...projectQuery(project),
		refetchInterval: (q) => (q.state.data && !q.state.data.head ? 3000 : 15_000),
	});
	const [creating, setCreating] = useState(false);
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
								<h1 className="min-w-0 break-all font-mono text-2xl font-semibold tracking-tight">{project}</h1>
								{p && <VisibilityBadge visibility={p.repo.visibility} />}
								{archived && <ArchivedBadge />}
							</div>
							{p?.repo.forkOf && (
								<div className="mt-1 flex flex-wrap items-center gap-3">
									<ForkedFrom source={p.repo.forkOf} />
									{canWrite && p.head && (
										<Link
											to="/$owner/$repo/pulls/new"
											params={{ owner: p.repo.forkOf.owner, repo: p.repo.forkOf.name }}
											search={{ headRepo: project, head: p.defaultBranch }}
											className="flex items-center gap-1 text-[11px] text-accent hover:underline"
										>
											<GitPullRequest className="size-3" />
											Contribute back
										</Link>
									)}
								</div>
							)}
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
						<Tab
							to="/$owner/$repo/issues"
							project={project}
							icon={<CircleDot className="size-3.5" />}
							label="Issues"
							count={p?.repo.openIssues}
							sections={["issues"]}
						/>
						<Tab
							to="/$owner/$repo/pulls"
							project={project}
							icon={<GitPullRequest className="size-3.5" />}
							label="Pull requests"
							count={p?.repo.openPulls}
							sections={["pulls", "pull"]}
						/>
						<Tab to="/$owner/$repo/actions" project={project} icon={<Workflow className="size-3.5" />} label="Actions" sections={["actions"]} />
						{p?.repo.hasWiki && <Tab to="/$owner/$repo/wiki" project={project} icon={<BookOpen className="size-3.5" />} label="Wiki" sections={["wiki"]} />}
						<Tab to="/$owner/$repo/branches" project={project} icon={<GitBranch className="size-3.5" />} label="Branches" />
						<Tab to="/$owner/$repo/releases" project={project} icon={<Package className="size-3.5" />} label="Releases" />
						<Tab to="/$owner/$repo/agents" project={project} icon={<Bot className="size-3.5" />} label="Agents" />
						<Tab to="/$owner/$repo/activity" project={project} icon={<Activity className="size-3.5" />} label="Activity" />
						<Tab to="/$owner/$repo/search" project={project} icon={<Search className="size-3.5" />} label="Search code" />
						{p?.repo.canAdmin && <Tab to="/$owner/$repo/settings" project={project} icon={<Settings className="size-3.5" />} label="Settings" />}
					</nav>
				</div>
			</div>

			<div className="mx-auto max-w-[1600px] px-5 py-5">
				<Outlet />
			</div>

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
	const navigate = useNavigate();
	const star = useOptimistic({
		mutationFn: (starred: boolean) => api.star(project, starred),
		apply: (starred) => {
			const toggle = (r: RepoInfo): RepoInfo => (r.fullName === repo.fullName && r.starred !== starred ? { ...r, starred, stars: r.stars + (starred ? 1 : -1) } : r);
			return [
				patch<Awaited<ReturnType<typeof api.project>>>(keys.project(project), (old) => ({ ...old, repo: toggle(old.repo) }), true),
				patch<RepoInfo[]>(["repos"], (old) => old.map(toggle)),
			];
		},
		action: "star the repository",
	});
	return (
		<div className="flex items-center">
			<Button
				onClick={() => (viewer.data ? star.mutate(!repo.starred) : navigate({ to: "/login" }))}
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
	| "/$owner/$repo/activity"
	| "/$owner/$repo/actions"
	| "/$owner/$repo/history"
	| "/$owner/$repo/branches"
	| "/$owner/$repo/search"
	| "/$owner/$repo/issues"
	| "/$owner/$repo/pulls"
	| "/$owner/$repo/releases"
	| "/$owner/$repo/wiki"
	| "/$owner/$repo/settings";

/**
 * `sections`: first path segments after the repository that belong to this tab. Tabs that link to an
 * index route (`/actions/`) aren't matched by the router on the pages under it (`/actions/runs/3`).
 */
function Tab({
	to,
	project,
	icon,
	label,
	exact,
	count,
	sections,
}: {
	to: TabTarget;
	project: string;
	icon: ReactNode;
	label: string;
	exact?: boolean;
	count?: number;
	sections?: string[];
}) {
	const section = useRouterState({ select: (s) => s.location.pathname.split("/")[3] ?? "" });
	const inSection = sections?.includes(decodeURIComponent(section)) ?? false;
	return (
		<Link
			to={to}
			params={repoParams(project)}
			activeOptions={{ exact, includeSearch: false }}
			className={cx(
				"-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm hover:text-fg data-[status=active]:border-accent data-[status=active]:text-fg",
				inSection ? "border-accent text-fg" : "border-transparent text-dim",
			)}
		>
			{icon}
			{label}
			{count !== undefined && count > 0 && <span className="rounded-full bg-raised px-1.5 text-[11px] tabular-nums text-dim">{count}</span>}
		</Link>
	);
}
