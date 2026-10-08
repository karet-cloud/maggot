import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GitCommitHorizontal, GitMerge } from "lucide-react";
import { Empty, ErrorNote, Oid, Panel, Spinner, TimeAgo } from "../components/ui.tsx";
import { api, keys } from "../lib/api.ts";

export const Route = createFileRoute("/p/$project/history")({ component: HistoryPage });

const TASK_MERGE = /^Merge task (t[0-9a-f]+): /;

function HistoryPage() {
	const { project } = Route.useParams();
	const log = useQuery({ queryKey: keys.log(project), queryFn: () => api.log(project, undefined, 100) });

	if (log.isPending) return <Spinner />;
	if (log.error) return <ErrorNote error={log.error} />;
	if (log.data.length === 0) return <Empty icon={<GitCommitHorizontal className="size-6" />} title="No commits yet" />;

	return (
		<Panel title={`Default branch · ${log.data.length} most recent commits`}>
			<ol className="divide-y divide-line/60">
				{log.data.map((c) => {
					const [subject, ...body] = c.message.split("\n");
					const taskId = TASK_MERGE.exec(subject)?.[1];
					const merge = c.parents.length > 1;
					return (
						<li key={c.hash} className="flex items-start gap-3 px-4 py-2.5">
							<span className={merge ? "mt-0.5 text-emerald-300" : "mt-0.5 text-faint"}>
								{merge ? <GitMerge className="size-4" /> : <GitCommitHorizontal className="size-4" />}
							</span>
							<div className="min-w-0 flex-1">
								<p className="truncate text-[13px] text-fg">
									{taskId ? (
										<>
											<Link to="/p/$project/t/$task" params={{ project, task: taskId }} className="font-mono text-accent hover:underline">
												{taskId}
											</Link>{" "}
											{subject.replace(TASK_MERGE, "")}
										</>
									) : (
										subject
									)}
								</p>
								{body.join("\n").trim() && <p className="mt-0.5 line-clamp-2 text-xs text-faint">{body.join(" ").trim()}</p>}
								<p className="mt-0.5 text-[11px] text-faint">
									{c.author.name} · <TimeAgo at={c.committedAt} />
								</p>
							</div>
							<Oid oid={c.hash} />
						</li>
					);
				})}
			</ol>
		</Panel>
	);
}
