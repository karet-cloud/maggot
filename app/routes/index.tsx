import { queryOptions, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleDot, GitPullRequest, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { IssueStateIcon, Label } from "../components/issues.tsx";
import { Landing } from "../components/landing/page.tsx";
import { PullStateIcon } from "../components/pulls.tsx";
import { RepoList } from "../components/repos.tsx";
import { buttonClass, ErrorNote, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys, type DashboardItem } from "../lib/api.ts";
import { preload, viewerQuery } from "../lib/queries.ts";
import { useViewer } from "./__root.tsx";

export const Route = createFileRoute("/")({
	loader: ({ context }) => {
		const me = context.queryClient.getQueryData(viewerQuery.queryKey);
		// Signed out, the home page is the landing page: nothing to load.
		return me ? preload(context.queryClient, reposQuery(me.username), dashboardQuery) : undefined;
	},
	component: Home,
});

const reposQuery = (owner?: string) => queryOptions({ queryKey: keys.repos(owner), queryFn: () => api.repos(owner) });
const dashboardQuery = queryOptions({ queryKey: keys.dashboard, queryFn: api.dashboard });

// Signed in, home is your repositories beside the open pull requests and issues that involve you.
// Public repositories from everyone are on /explore.
function Home() {
	const viewer = useViewer();
	const me = viewer.data;
	const mine = useQuery({ ...reposQuery(me?.username), enabled: Boolean(me) });
	const dashboard = useQuery({ ...dashboardQuery, enabled: Boolean(me) });

	if (viewer.isPending) {
		return (
			<main className="mx-auto max-w-[1280px] px-5 py-8">
				<Spinner />
			</main>
		);
	}
	if (!me) return <Landing />;

	return (
		<main className="mx-auto grid max-w-[1280px] gap-8 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_400px]">
			<section className="min-w-0 space-y-3">
				<div className="flex items-center justify-between gap-3">
					<h1 className="text-2xl font-semibold tracking-tight">Your repositories</h1>
					<Link to="/new" className={buttonClass("primary")}>
						<Plus className="size-4" />
						New repository
					</Link>
				</div>
				{mine.isPending ? <Spinner /> : <ErrorNote error={mine.error} />}
				{mine.data && <RepoList repos={mine.data} empty={{ title: "No repositories yet", body: "Create one, then push to it with git." }} />}
			</section>

			<aside className="min-w-0 space-y-5">
				{dashboard.error && <ErrorNote error={dashboard.error} />}
				<WorkList
					title="Pull requests"
					icon={<GitPullRequest className="size-4 text-dim" />}
					items={dashboard.data?.pulls}
					pending={dashboard.isPending}
					empty="No open pull requests in your repositories, and none of yours are waiting."
					kind="pull"
				/>
				<WorkList
					title="Issues"
					icon={<CircleDot className="size-4 text-dim" />}
					items={dashboard.data?.issues}
					pending={dashboard.isPending}
					empty="No open issues in your repositories, and none you've opened elsewhere."
					kind="issue"
				/>
			</aside>
		</main>
	);
}

/** Open pull requests or issues across repositories, newest activity first, each linking to its page. */
function WorkList({
	title,
	icon,
	items,
	pending,
	empty,
	kind,
}: {
	title: string;
	icon: ReactNode;
	items: DashboardItem[] | undefined;
	pending: boolean;
	empty: string;
	kind: "pull" | "issue";
}) {
	return (
		<Panel
			title={
				<span className="flex items-center gap-2">
					{icon}
					{title}
				</span>
			}
			actions={items && items.length > 0 ? <span className="text-[11px] text-faint">{items.length === 20 ? "20 most recent" : `${items.length} open`}</span> : undefined}
		>
			{pending && <Spinner className="m-4" />}
			{items && items.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-dim">{empty}</p>}
			{items && items.length > 0 && (
				<ul className="divide-y divide-line/60">
					{items.map((item) => {
						const [owner = "", repo = ""] = item.repo.split("/");
						const params = { owner, repo, number: String(item.number) };
						return (
							<li key={`${item.repo}#${item.number}`} className="flex items-start gap-2.5 px-4 py-3">
								{kind === "pull" ? <PullStateIcon state="open" className="mt-0.5 shrink-0" /> : <IssueStateIcon state="open" className="mt-0.5 shrink-0" />}
								<div className="min-w-0 flex-1">
									<Link
										to={kind === "pull" ? "/$owner/$repo/pull/$number" : "/$owner/$repo/issues/$number"}
										params={params}
										className="text-[14px] leading-snug font-medium text-fg hover:text-accent"
									>
										{item.title}
									</Link>
									{item.labels.length > 0 && (
										<span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
											{item.labels.slice(0, 3).map((l) => (
												<Label key={l} name={l} />
											))}
										</span>
									)}
									<p className="mt-0.5 truncate text-[12px] text-faint">
										<Link to="/$owner/$repo" params={{ owner, repo }} className="font-mono text-dim hover:text-fg">
											{item.repo}
										</Link>{" "}
										#{item.number}
										{item.author && ` by ${item.author}`} · updated <TimeAgo at={item.updatedAt} />
									</p>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}
