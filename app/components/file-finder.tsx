import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileSearch } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { api, keys, repoParams } from "../lib/api.ts";
import { fuzzyFilter, type FuzzyMatch } from "../lib/fuzzy.ts";
import { Button, cx, ErrorNote, Modal, Spinner } from "./ui.tsx";

/** "Go to file": a button, and `t` anywhere on the page, open a fuzzy finder over every path at `refName`. */
export function GoToFile({ project, refName, commit }: { project: string; refName?: string; commit: string }) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "t" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog[open]")) return;
			e.preventDefault();
			setOpen(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return (
		<>
			<Button className="px-2.5 text-xs" onClick={() => setOpen(true)} title="Go to file (t)">
				<FileSearch className="size-3.5" />
				Go to file
				<kbd className="ml-1 rounded border border-line px-1 font-mono text-[10px] text-faint">t</kbd>
			</Button>
			<Modal open={open} onClose={() => setOpen(false)} title="Go to file">
				<Finder project={project} refName={refName} commit={commit} onClose={() => setOpen(false)} />
			</Modal>
		</>
	);
}

function Finder({ project, refName, commit, onClose }: { project: string; refName?: string; commit: string; onClose: () => void }) {
	const navigate = useNavigate();
	// By commit: a commit's files never change, so the list is cached for good, here and in the browser.
	const files = useQuery({ queryKey: keys.paths(project, commit), queryFn: () => api.paths(project, commit), staleTime: Number.POSITIVE_INFINITY });
	const [query, setQuery] = useState("");
	const deferred = useDeferredValue(query);
	const matches = useMemo(() => fuzzyFilter(deferred, files.data?.paths ?? []), [deferred, files.data]);
	const [selected, setSelected] = useState(0);
	const list = useRef<HTMLUListElement>(null);
	useEffect(() => setSelected(0), [deferred]);
	useEffect(() => {
		list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	const go = (path: string) => {
		onClose();
		const parent = path.split("/").slice(0, -1).join("/") || undefined;
		void navigate({ to: "/$owner/$repo", params: repoParams(project), search: { ref: refName, path: parent, file: path } });
	};

	return (
		<div className="space-y-3">
			<input
				// biome-ignore lint/a11y/noAutofocus: the dialog exists to type into
				autoFocus
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setSelected((i) => Math.min(i + 1, matches.length - 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setSelected((i) => Math.max(i - 1, 0));
					} else if (e.key === "Enter" && matches[selected]) {
						e.preventDefault();
						go(matches[selected].path);
					}
				}}
				placeholder="Type part of a file name"
				aria-label="File name"
				role="combobox"
				aria-expanded
				aria-controls="file-finder-results"
				aria-activedescendant={matches[selected] ? `file-finder-${selected}` : undefined}
				className="w-full rounded-md border border-line-strong bg-bg px-3 py-2 font-mono text-sm text-fg placeholder:font-sans placeholder:text-faint focus:border-accent focus:outline-none"
			/>
			{files.isPending && <Spinner />}
			<ErrorNote error={files.error} />
			{files.data && (
				<>
					<ul ref={list} id="file-finder-results" role="listbox" className="max-h-[50vh] overflow-y-auto rounded-md border border-line">
						{matches.length === 0 && <li className="px-3 py-2 text-xs text-faint">{files.data.paths.length ? "No matching files." : "No files yet."}</li>}
						{matches.map((m, i) => (
							<li
								key={m.path}
								id={`file-finder-${i}`}
								data-index={i}
								role="option"
								aria-selected={i === selected}
								onMouseMove={() => setSelected(i)}
								onClick={() => go(m.path)}
								className={cx("cursor-pointer truncate px-3 py-1.5 font-mono text-xs", i === selected ? "bg-accent/15 text-fg" : "text-dim")}
							>
								<Highlighted match={m} />
							</li>
						))}
					</ul>
					<p className="text-[11px] text-faint">
						{files.data.paths.length.toLocaleString()} files
						{files.data.truncated && " (the first ones; the repository has more)"} · ↑↓ to move, Enter to open
					</p>
				</>
			)}
		</div>
	);
}

function Highlighted({ match }: { match: FuzzyMatch }) {
	const hit = new Set(match.positions);
	const nameStart = match.path.lastIndexOf("/") + 1;
	return (
		<>
			{Array.from(match.path, (ch, i) => (
				<span key={i} className={cx(hit.has(i) ? "font-semibold text-accent" : i >= nameStart && "text-fg")}>
					{ch}
				</span>
			))}
		</>
	);
}
