import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { GitCommitHorizontal, GitMerge } from "lucide-react";
import type { Commit } from "../lib/api.ts";
import { shortOid } from "../lib/format.ts";
import { TimeAgo } from "./ui.tsx";
import { repoParams } from "../lib/api.ts";

const TASK_MERGE = /^Merge task (t[0-9a-f]+): /;

/** One line per commit, linking to its commit page. `refName` keeps task-fork commits readable. */
export function CommitList({ commits, project, refName, links = true }: { commits: Commit[]; project: string; refName?: string; links?: boolean }) {
	return (
		<ol className="divide-y divide-line/60">
			{commits.map((c) => {
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
								{taskId && links && (
									<>
										<Link to="/$owner/$repo/t/$task" params={{ ...repoParams(project), task: taskId }} className="font-mono text-accent hover:underline">
											{taskId}
										</Link>{" "}
									</>
								)}
								<CommitLink hash={c.hash} project={project} refName={refName} links={links}
									className="hover:text-accent hover:underline"
								>
									{taskId ? subject.replace(TASK_MERGE, "") : subject}
								</CommitLink>
							</p>
							{body.join("\n").trim() && <p className="mt-0.5 line-clamp-2 text-xs text-faint">{body.join(" ").trim()}</p>}
							<p className="mt-0.5 text-[11px] text-faint">
								{c.author.name} · <TimeAgo at={c.committedAt} />
							</p>
						</div>
						<CommitLink hash={c.hash} project={project} refName={refName} links={links}
							className="font-mono text-[12px] text-dim hover:text-accent"
						>
							{shortOid(c.hash)}
						</CommitLink>
					</li>
				);
			})}
		</ol>
	);
}

function CommitLink({ hash, project, refName, links, className, children }: { hash: string; project: string; refName?: string; links: boolean; className: string; children: ReactNode }) {
	return links ? (
		<Link to="/$owner/$repo/commit/$hash" params={{ ...repoParams(project), hash }} search={{ ref: refName }} className={className}>
			{children}
		</Link>
	) : <span className={className.replace(/hover:[^ ]+/g, "")}>{children}</span>;
}
