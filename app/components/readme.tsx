import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { api, keys, repoParams } from "../lib/api.ts";
import { Markdown } from "./markdown.tsx";
import { Panel } from "./ui.tsx";

const README = /^readme(\.(md|markdown|txt))?$/i;

/** The README at the root of the default branch, rendered, or nothing if there isn't one. */
export function ReadmePanel({ project }: { project: string }) {
	const tree = useQuery({ queryKey: [...keys.code(project), "tree", "", ""], queryFn: () => api.tree(project, "") });
	const entry = tree.data?.entries.find((e) => e.type !== "tree" && README.test(e.name));
	const file = useQuery({
		queryKey: [...keys.code(project), "file", "", entry?.path ?? ""],
		queryFn: () => api.file(project, entry?.path as string),
		enabled: Boolean(entry),
	});
	if (!entry || file.data === undefined) return null;
	return (
		<Panel
			title={
				<span className="flex items-center gap-1.5">
					<BookOpen className="size-3.5" />
					{entry.name}
				</span>
			}
			actions={
				<Link to="/$owner/$repo" params={repoParams(project)} search={{ file: entry.path }} className="text-[11px] text-dim hover:text-fg">
					View in code
				</Link>
			}
		>
			<div className="p-6">
				{/\.(md|markdown)$/i.test(entry.name) ? (
					<Markdown source={file.data} project={project} path={entry.path} />
				) : (
					<pre className="font-mono text-xs whitespace-pre-wrap text-dim">{file.data}</pre>
				)}
			</div>
		</Panel>
	);
}
