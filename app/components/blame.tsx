import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { api, keys, repoParams } from "../lib/api.ts";
import { highlightLines, languageFor } from "../lib/highlight.ts";
import { ErrorNote, Spinner, TimeAgo } from "./ui.tsx";

/** A file with, beside each run of lines, the commit that last changed them. */
export function BlameView({ project, path, refName }: { project: string; path: string; refName?: string }) {
	const blame = useQuery({ queryKey: keys.blame(project, path, refName), queryFn: () => api.blame(project, path, refName), staleTime: 60_000 });
	const html = useMemo(() => (blame.data && !blame.data.tooLarge ? highlightLines(blame.data.lines.map((l) => l.text).join("\n"), languageFor(path)) : null), [blame.data, path]);
	// Newer changes are brighter, so recent work stands out.
	const ages = useMemo(() => {
		const times = Object.values(blame.data?.commits ?? {}).map((c) => c.committedAt);
		return { min: Math.min(...times), max: Math.max(...times) };
	}, [blame.data]);
	if (blame.isPending) return <Spinner className="m-4" />;
	if (blame.error) return <div className="p-3"><ErrorNote error={blame.error} /></div>;
	if (blame.data.tooLarge) return <p className="p-4 text-xs text-faint">This file is binary or too big to blame.</p>;
	const { lines, commits } = blame.data;
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse font-mono text-[12px] leading-5">
				<tbody>
					{lines.map((line, i) => {
						const first = i === 0 || lines[i - 1].commit !== line.commit;
						const commit = commits[line.commit];
						const heat = ages.max > ages.min ? (commit.committedAt - ages.min) / (ages.max - ages.min) : 1;
						return (
							<tr key={i} className={first && i > 0 ? "border-t border-line/60" : undefined}>
								<td className="w-72 max-w-72 border-r border-line/60 px-3 align-top font-sans" style={{ boxShadow: `inset 3px 0 0 hsl(28 90% ${30 + heat * 30}% / ${0.25 + heat * 0.75})` }}>
									{first && (
										<div className="flex items-baseline gap-2 py-0.5">
											<Link
												to="/$owner/$repo/commit/$hash"
												params={{ ...repoParams(project), hash: commit.hash }}
												className="min-w-0 flex-1 truncate text-[12px] text-dim hover:text-accent"
												title={commit.message}
											>
												{line.boundary && "^ "}
												{commit.message.split("\n")[0]}
											</Link>
											<span className="shrink-0 text-[11px] text-faint">
												{commit.author.name} · <TimeAgo at={commit.committedAt} />
											</span>
										</div>
									)}
								</td>
								<td className="w-px px-3 text-right text-faint/70 select-none">{i + 1}</td>
								{html?.[i] !== undefined ? (
									<td className="pr-4 whitespace-pre text-fg/90" dangerouslySetInnerHTML={{ __html: html[i] || " " }} />
								) : (
									<td className="pr-4 whitespace-pre text-fg/90">{line.text || " "}</td>
								)}
							</tr>
						);
					})}
				</tbody>
			</table>
			{lines.some((l) => l.boundary) && <p className="p-3 text-xs text-faint">^ marks lines whose history goes back further than blame looked.</p>}
		</div>
	);
}
