import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, GitBranch, GitCompareArrows, ShieldCheck, Trash2 } from "lucide-react";
import { protectionFor } from "../../src/branch-rules.ts";
import type { ReactNode } from "react";
import { Button, Empty, ErrorNote, Panel, Spinner, StatusBadge, TimeAgo } from "../components/ui.tsx";
import { api, keys, type Branches, type BranchSummary, repoParams, type Task } from "../lib/api.ts";
import { patch, useOptimistic } from "../lib/optimistic.ts";
import { preload, projectQuery } from "../lib/queries.ts";

export const Route = createFileRoute("/$owner/$repo/branches")({
	loader: ({ context, params }) => {
		const project = `${params.owner}/${params.repo}`;
		return preload(context.queryClient, branchesQuery(project), branchRulesQuery(project));
	},
	component: BranchesPage,
});

const branchesQuery = (project: string) => queryOptions({ queryKey: keys.branches(project), queryFn: () => api.branches(project) });
// The same key and fetcher as the branch protection settings.
const branchRulesQuery = (project: string) => queryOptions({ queryKey: keys.branchRules(project), queryFn: () => api.branchRules(project) });

function BranchesPage() {
	const { owner, repo } = Route.useParams();
	const project = `${owner}/${repo}`;
	const branches = useQuery(branchesQuery(project));
	const info = useQuery(projectQuery(project));
	// Only the owner deletes branches, and not while the repository is archived.
	const writable = Boolean(info.data?.repo.canWrite && !info.data.repo.archivedAt);
	const rules = useQuery(branchRulesQuery(project));
	const protectedBranch = (name: string) => protectionFor(rules.data ?? [], name).patterns.length > 0;
	const deletable = (name: string) => {
		const p = protectionFor(rules.data ?? [], name);
		return !p.blockDeletions && !p.requireMergeQueue;
	};
	// Covers the "names" variant the branch pickers use too.
	const remove = useOptimistic({
		mutationFn: (name: string) => api.deleteBranch(project, name),
		apply: (name) => [patch<Branches>(keys.branches(project), (old) => ({ ...old, branches: old.branches.filter((b) => b.name !== name) }))],
		action: "delete the branch",
	});
	const abandon = useOptimistic({
		mutationFn: (id: string) => api.abandon(project, id),
		apply: (id) => [
			patch<Branches>(keys.branches(project), (old) => ({ ...old, agents: old.agents.filter((a) => a.taskId !== id) })),
			patch<Task[]>(keys.tasks(project), (old) => old.map((t) => (t.id === id ? { ...t, status: "abandoned" } : t)), true),
			patch<Task>(keys.task(project, id), (old) => ({ ...old, status: "abandoned" }), true),
		],
		action: "abandon the task",
	});

	if (branches.isPending) return <Spinner />;
	if (branches.error) return <ErrorNote error={branches.error} />;
	const { defaultBranch, branches: all, agents } = branches.data;
	const main = all.find((b) => b.default);
	const others = all.filter((b) => !b.default);
	const scale = Math.max(1, ...[...all, ...agents].flatMap((b) => [b.ahead ?? 0, b.behind ?? 0]));

	return (
		<div className="space-y-4">
			{main && (
				<Panel title="Default branch">
					<BranchRow project={project} branch={main} name={main.name} refName={undefined} scale={scale} isDefault protectedBranch={protectedBranch(main.name)} />
				</Panel>
			)}

			<Panel title={`Branches (${others.length})`} actions={<span className="text-[11px] text-faint">ahead / behind {defaultBranch}</span>}>
				{others.length === 0 ? (
					<p className="px-4 py-6 text-center text-xs text-faint">
						No other branches. Push one with <code className="font-mono text-dim">git push megit my-branch</code>.
					</p>
				) : (
					<ul className="divide-y divide-line/60">
						{others.map((b) => (
							<li key={b.name}>
								<BranchRow
									project={project}
									branch={b}
									name={b.name}
									refName={b.name}
									scale={scale}
									protectedBranch={protectedBranch(b.name)}
									actions={
										writable && deletable(b.name) && <Button
											variant="ghost"
											className="px-2 text-xs hover:text-red-300"
											onClick={() => confirm(`Delete branch ${b.name}? Its commits stay reachable only if merged elsewhere.`) && remove.mutate(b.name)}
											title="Delete branch"
										>
											<Trash2 className="size-3.5" />
										</Button>
									}
								/>
							</li>
						))}
					</ul>
				)}
			</Panel>

			<Panel title={`Agent forks (${agents.length})`} actions={<span className="text-[11px] text-faint">one fork per active task</span>}>
				{agents.length === 0 ? (
					<Empty icon={<Bot className="size-6" />} title="No active agent work">
						Each task gets its own fork of {defaultBranch}; it shows up here while the task is active.
					</Empty>
				) : (
					<ul className="divide-y divide-line/60">
						{agents.map((a) => (
							<li key={a.taskId}>
								<BranchRow
									project={project}
									branch={a}
									name={
										<span className="flex min-w-0 items-center gap-2">
											<Link to="/$owner/$repo/t/$task" params={{ ...repoParams(project), task: a.taskId }} className="font-mono text-accent hover:underline">
												{a.taskId}
											</Link>
											<span className="truncate font-sans text-fg">{a.title}</span>
											<StatusBadge status={a.status} />
										</span>
									}
									refName={a.name}
									scale={scale}
									byline={a.agent}
									actions={
										a.status !== "merging" && (
											<Button
												variant="ghost"
												className="px-2 text-xs hover:text-red-300"
												onClick={() => confirm(`Abandon task ${a.taskId} and delete its fork?`) && abandon.mutate(a.taskId)}
												title="Abandon task and delete its fork"
											>
												<Trash2 className="size-3.5" />
											</Button>
										)
									}
								/>
							</li>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

function BranchRow({
	project,
	branch,
	name,
	refName,
	scale,
	isDefault,
	byline,
	actions,
	protectedBranch,
}: {
	project: string;
	branch: BranchSummary;
	name: ReactNode;
	refName: string | undefined;
	scale: number;
	isDefault?: boolean;
	byline?: string | null;
	actions?: ReactNode;
	protectedBranch?: boolean;
}) {
	const subject = branch.commit?.message.split("\n")[0];
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
			<div className="min-w-0 flex-1 basis-72">
				<div className="flex items-center gap-2 text-sm">
					<GitBranch className="size-4 shrink-0 text-faint" />
					{typeof name === "string" ? (
						<Link to="/$owner/$repo" params={repoParams(project)} search={{ ref: refName }} className="truncate font-mono text-fg hover:text-accent">
							{name}
						</Link>
					) : (
						name
					)}
					{protectedBranch && (
						<span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300" title="Protected by a branch rule (see Settings)">
							<ShieldCheck className="size-3" />
							Protected
						</span>
					)}
				</div>
				{branch.commit && (
					<p className="mt-1 truncate pl-6 text-xs text-faint">
						<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash: branch.head }} search={{ ref: refName?.startsWith("task:") ? refName : undefined }} className="text-dim hover:text-accent">
							{subject}
						</Link>{" "}
						· {byline ?? branch.commit.author.name} · <TimeAgo at={branch.commit.committedAt} />
					</p>
				)}
			</div>
			{!isDefault && <AheadBehind ahead={branch.ahead} behind={branch.behind} capped={branch.capped} scale={scale} />}
			<div className="flex items-center gap-1">
				{!isDefault && (
					<Link
						to="/$owner/$repo/compare"
						params={repoParams(project)}
						search={{ head: refName }}
						className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-dim hover:bg-raised hover:text-fg"
					>
						<GitCompareArrows className="size-3.5" />
						Compare
					</Link>
				)}
				{actions}
			</div>
		</div>
	);
}

/** GitHub-style split bar: behind grows left of the center line, ahead grows right. */
function AheadBehind({ ahead, behind, capped, scale }: { ahead: number | null; behind: number | null; capped: boolean; scale: number }) {
	const width = (n: number | null) => `${Math.max(n ? 4 : 0, ((n ?? 0) / scale) * 100)}%`;
	return (
		<div className="w-40 shrink-0" title={`${behind ?? "?"} behind, ${ahead ?? "?"}${capped ? "+" : ""} ahead`}>
			<div className="flex justify-between font-mono text-[11px] text-dim">
				<span>{behind ?? "?"}</span>
				<span>
					{ahead ?? "?"}
					{capped ? "+" : ""}
				</span>
			</div>
			<div className="mt-1 flex h-1">
				<div className="flex flex-1 justify-end border-r border-line-strong">
					<div className="h-full rounded-l bg-faint/60" style={{ width: width(behind) }} />
				</div>
				<div className="flex-1">
					<div className="h-full rounded-r bg-accent" style={{ width: width(ahead) }} />
				</div>
			</div>
		</div>
	);
}
