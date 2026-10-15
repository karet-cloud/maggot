import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Columns2, FileCode2, Rows2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Diff, DiffHunk, FileDiff } from "../lib/api.ts";
import { highlightLines, languageFor } from "../lib/highlight.ts";
import { cx, Panel } from "./ui.tsx";
import { repoParams } from "../lib/api.ts";

type Layout = "unified" | "split";
const LAYOUT_KEY = "maggot.diff.layout";
/** Files with more changed lines than this start collapsed. */
const COLLAPSE_ABOVE = 400;

function useLayout(): [Layout, (l: Layout) => void] {
	const [layout, setLayout] = useState<Layout>("unified");
	useEffect(() => {
		if (localStorage.getItem(LAYOUT_KEY) === "split") setLayout("split");
	}, []);
	return [
		layout,
		(l) => {
			localStorage.setItem(LAYOUT_KEY, l);
			setLayout(l);
		},
	];
}

/**
 * Line comments in a diff (code review): what to show under a line, keyed by `lineKey`, and how to
 * start a new one. Comments show in both layouts; new ones start from the unified one.
 */
export interface DiffNotes {
	under: Map<string, ReactNode>;
	onAdd?: (path: string, side: "new" | "old", line: number) => void;
}

export const lineKey = (path: string, side: "new" | "old", line: number) => `${side}:${line}:${path}`;

/**
 * A full diff: a summary with a file index, then each file's hunks. `viewRef` is where "View file"
 * links point (the new side of the diff).
 */
export function DiffView({ diff, project, viewRef, title, notes, links = true }: { diff: Diff; project: string; viewRef?: string; title?: ReactNode; notes?: DiffNotes; links?: boolean }) {
	const [layout, setLayout] = useLayout();
	const [indexOpen, setIndexOpen] = useState(diff.files.length <= 12);
	if (diff.files.length === 0) {
		return (
			<Panel title={title ?? "Changes"}>
				<p className="px-4 py-6 text-center text-xs text-faint">No changes.</p>
			</Panel>
		);
	}
	return (
		<div className="space-y-3">
			<Panel
				title={title ?? "Changes"}
				actions={
					<div className="flex items-center gap-3">
						<span className="text-xs text-dim">
							{diff.files.length}
							{diff.truncated ? "+" : ""} {diff.files.length === 1 ? "file" : "files"}{" "}
							<span className="font-mono text-emerald-300">+{diff.additions}</span>{" "}
							<span className="font-mono text-rose-300">−{diff.deletions}</span>
						</span>
						<div className="flex overflow-hidden rounded-md border border-line-strong">
							<LayoutButton active={layout === "unified"} onClick={() => setLayout("unified")} label="Unified">
								<Rows2 className="size-3.5" />
							</LayoutButton>
							<LayoutButton active={layout === "split"} onClick={() => setLayout("split")} label="Split">
								<Columns2 className="size-3.5" />
							</LayoutButton>
						</div>
					</div>
				}
			>
				<button
					type="button"
					onClick={() => setIndexOpen(!indexOpen)}
					className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-dim hover:text-fg"
				>
					{indexOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
					Files changed
				</button>
				{indexOpen && (
					<ul className="border-t border-line/60 py-1">
						{diff.files.map((f) => (
							<li key={f.path}>
								<a href={`#diff-${encodeURIComponent(f.path)}`} className="flex items-center gap-2 px-4 py-1 font-mono text-xs text-dim hover:bg-raised hover:text-fg">
									<StatusMark status={f.status} />
									<span className="min-w-0 flex-1 truncate">{f.path}</span>
									<Counts file={f} />
								</a>
							</li>
						))}
					</ul>
				)}
				{diff.truncated && (
					<p className="border-t border-line/60 px-4 py-2 text-xs text-amber-300">
						Only the first {diff.files.length} files are shown. Clone the repository to see the full diff.
					</p>
				)}
			</Panel>
			{diff.files.map((f) => (
				<FileSection key={f.path} file={f} layout={layout} project={project} viewRef={viewRef} notes={notes} links={links} />
			))}
		</div>
	);
}

function LayoutButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={label}
			aria-pressed={active}
			className={cx("flex items-center gap-1 px-2 py-1 text-[11px]", active ? "bg-raised text-fg" : "text-faint hover:text-fg")}
		>
			{children}
			{label}
		</button>
	);
}

function StatusMark({ status }: { status: FileDiff["status"] }) {
	const s = { added: ["A", "text-emerald-300"], deleted: ["D", "text-rose-300"], modified: ["M", "text-amber-300"] }[status];
	return <span className={cx("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", s[1])}>{s[0]}</span>;
}

function Counts({ file }: { file: FileDiff }) {
	if (file.binary) return <span className="text-[11px] text-faint">binary</span>;
	if (file.tooLarge) return <span className="text-[11px] text-faint">large</span>;
	return (
		<span className="shrink-0 font-mono text-[11px]">
			<span className="text-emerald-300">+{file.additions}</span> <span className="text-rose-300">−{file.deletions}</span>
		</span>
	);
}

function FileSection({ file, layout, project, viewRef, notes, links }: { file: FileDiff; layout: Layout; project: string; viewRef?: string; notes?: DiffNotes; links: boolean }) {
	const [open, setOpen] = useState(file.additions + file.deletions <= COLLAPSE_ABOVE);
	const modeChange = file.oldMode && file.newMode && file.oldMode !== file.newMode ? `${file.oldMode} → ${file.newMode}` : null;
	const parent = file.path.split("/").slice(0, -1).join("/") || undefined;
	return (
		<section id={`diff-${encodeURIComponent(file.path)}`} className="scroll-mt-16 overflow-clip rounded-lg border border-line bg-panel">
			<header className="sticky top-[49px] z-[1] flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
				<button type="button" onClick={() => setOpen(!open)} className="text-faint hover:text-fg" aria-label={open ? "Collapse" : "Expand"}>
					{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
				</button>
				<StatusMark status={file.status} />
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{file.path}</span>
				{modeChange && <span className="font-mono text-[11px] text-faint">{modeChange}</span>}
				<Counts file={file} />
				{links && file.status !== "deleted" && (
					<Link
						to="/$owner/$repo"
						params={repoParams(project)}
						search={{ ref: viewRef, path: parent, file: file.path }}
						className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-raised hover:text-fg"
					>
						<FileCode2 className="size-3.5" />
						View
					</Link>
				)}
			</header>
			{open &&
				(file.binary ? (
					<p className="px-4 py-3 text-xs text-faint">Binary file {file.status}.</p>
				) : file.tooLarge ? (
					<p className="px-4 py-3 text-xs text-faint">This diff is too large to show here.</p>
				) : file.hunks.length === 0 ? (
					<p className="px-4 py-3 text-xs text-faint">{modeChange ? "File mode changed." : file.status === "added" ? "Empty file added." : "Empty file."}</p>
				) : layout === "unified" ? (
					<Unified file={file} notes={notes} />
				) : (
					<Split file={file} notes={notes} />
				))}
			{!open && !file.binary && !file.tooLarge && (
				<button type="button" onClick={() => setOpen(true)} className="w-full px-4 py-3 text-xs text-accent hover:underline">
					Load diff ({file.additions + file.deletions} lines)
				</button>
			)}
		</section>
	);
}

interface Row {
	kind: " " | "+" | "-" | "\\";
	text: string;
	html: string | null;
	old: number | null;
	new: number | null;
}

/** Numbers each hunk line and highlights the old and new sides separately, so tokens spanning lines stay right. */
function useRows(file: FileDiff): Row[][] {
	return useMemo(() => {
		const oldText: string[] = [];
		const newText: string[] = [];
		for (const h of file.hunks) {
			for (const line of h.lines) {
				if (line[0] === " " || line[0] === "-") oldText.push(line.slice(1));
				if (line[0] === " " || line[0] === "+") newText.push(line.slice(1));
			}
		}
		// Highlighting runs on the main thread; very long diffs are shown plain so the page stays responsive.
		const language = oldText.length + newText.length > 4000 ? undefined : languageFor(file.path);
		const oldHtml = highlightLines(oldText.join("\n"), language);
		const newHtml = highlightLines(newText.join("\n"), language);
		let o = 0;
		let n = 0;
		return file.hunks.map((h: DiffHunk) => {
			let oldNo = h.oldStart;
			let newNo = h.newStart;
			return h.lines.map((line): Row => {
				const kind = line[0] as Row["kind"];
				const text = line.slice(1);
				if (kind === "\\") return { kind, text: line.slice(2), html: null, old: null, new: null };
				if (kind === "-") return { kind, text, html: oldHtml?.[o++] ?? null, old: oldNo++, new: null };
				if (kind === "+") return { kind, text, html: newHtml?.[n++] ?? null, old: null, new: newNo++ };
				o++;
				return { kind, text, html: newHtml?.[n++] ?? null, old: oldNo++, new: newNo++ };
			});
		});
	}, [file]);
}

const ROW_TONE = { " ": "", "+": "bg-emerald-500/10", "-": "bg-rose-500/10", "\\": "" } as const;
const NUM_TONE = { " ": "text-faint/70", "+": "bg-emerald-500/15 text-emerald-300/70", "-": "bg-rose-500/15 text-rose-300/70", "\\": "text-faint/70" } as const;

function Code({ row }: { row: Row }) {
	if (row.kind === "\\") return <span className="text-faint italic">{row.text}</span>;
	return row.html !== null ? <span dangerouslySetInnerHTML={{ __html: row.html || " " }} /> : <>{row.text || " "}</>;
}

function HunkHeader({ hunk, colSpan }: { hunk: DiffHunk; colSpan: number }) {
	return (
		<tr className="bg-accent/5">
			<td colSpan={colSpan} className="px-3 py-1 font-mono text-[11px] text-accent/80">
				@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
			</td>
		</tr>
	);
}

/** Where a line can be commented on: its new-side number, or its old-side one for a deleted line. */
function anchor(r: Row): { side: "new" | "old"; line: number } | null {
	if (r.kind === "\\") return null;
	return r.new !== null ? { side: "new", line: r.new } : r.old !== null ? { side: "old", line: r.old } : null;
}

function AddNote({ notes, path, row }: { notes?: DiffNotes; path: string; row: Row }) {
	const at = anchor(row);
	if (!notes?.onAdd || !at) return null;
	return (
		<button
			type="button"
			onClick={() => notes.onAdd?.(path, at.side, at.line)}
			className="absolute top-0 left-0 hidden size-5 items-center justify-center rounded bg-accent text-[13px] leading-none text-on-accent group-hover:flex"
			aria-label="Comment on this line"
		>
			+
		</button>
	);
}

function NoteRow({ notes, path, row, colSpan }: { notes?: DiffNotes; path: string; row: Row | null; colSpan: number }) {
	const at = row ? anchor(row) : null;
	const node = at && notes?.under.get(lineKey(path, at.side, at.line));
	if (!node) return null;
	return (
		<tr>
			<td colSpan={colSpan} className="border-y border-line bg-bg px-3 py-2 font-sans">
				{node}
			</td>
		</tr>
	);
}

function Unified({ file, notes }: { file: FileDiff; notes?: DiffNotes }) {
	const hunks = useRows(file);
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse font-mono text-[12px] leading-5">
				<tbody>
					{hunks.map((rows, h) => (
						<HunkRows key={h}>
							<HunkHeader hunk={file.hunks[h]} colSpan={4} />
							{rows.map((r, i) => (
								<Fragment key={i}>
								<tr className={cx(ROW_TONE[r.kind], "group")}>
									<td className={cx("relative w-px select-none px-2 text-right align-top", NUM_TONE[r.kind])}>
										<AddNote notes={notes} path={file.path} row={r} />
										{r.old ?? ""}
									</td>
									<td className={cx("w-px select-none px-2 text-right align-top", NUM_TONE[r.kind])}>{r.new ?? ""}</td>
									<td className={cx("w-px select-none pl-2 align-top", r.kind === "+" ? "text-emerald-300" : r.kind === "-" ? "text-rose-300" : "text-faint")}>
										{r.kind === "\\" ? "" : r.kind}
									</td>
									<td className="pr-4 pl-1 whitespace-pre text-fg/90">
										<Code row={r} />
									</td>
								</tr>
								<NoteRow notes={notes} path={file.path} row={r} colSpan={4} />
								</Fragment>
							))}
						</HunkRows>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** Pairs each run of deletions with the additions that follow it, side by side. */
function Split({ file, notes }: { file: FileDiff; notes?: DiffNotes }) {
	const hunks = useRows(file);
	return (
		<div className="overflow-x-auto">
			<table className="w-full table-fixed border-collapse font-mono text-[12px] leading-5">
				<colgroup>
					<col className="w-12" />
					<col />
					<col className="w-12" />
					<col />
				</colgroup>
				<tbody>
					{hunks.map((rows, h) => (
						<HunkRows key={h}>
							<HunkHeader hunk={file.hunks[h]} colSpan={4} />
							{pair(rows).map(([left, right], i) => (
								<Fragment key={i}>
									<tr className="group">
										{/* A deleted line is commented on from the left; everything else from the right. */}
										<Side row={left} number={left?.old} add={left?.kind === "-" ? { notes, path: file.path } : undefined} />
										<Side row={right} number={right?.new} add={right ? { notes, path: file.path } : undefined} />
									</tr>
									<NoteRow notes={notes} path={file.path} row={right ?? left} colSpan={4} />
									{left && left.kind === "-" && <NoteRow notes={notes} path={file.path} row={left} colSpan={4} />}
								</Fragment>
							))}
						</HunkRows>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Side({ row, number, add }: { row: Row | null; number: number | null | undefined; add?: { notes?: DiffNotes; path: string } }) {
	if (!row) return <td colSpan={2} className="bg-raised/40" />;
	return (
		<>
			<td className={cx("relative select-none px-2 text-right align-top", NUM_TONE[row.kind])}>
				{add && <AddNote notes={add.notes} path={add.path} row={row} />}
				{number ?? ""}
			</td>
			<td className={cx("overflow-hidden pr-3 pl-2 align-top whitespace-pre-wrap break-all text-fg/90", ROW_TONE[row.kind])}>
				<Code row={row} />
			</td>
		</>
	);
}

function pair(rows: Row[]): [Row | null, Row | null][] {
	const out: [Row | null, Row | null][] = [];
	for (let i = 0; i < rows.length; ) {
		const r = rows[i];
		if (r.kind === " " || r.kind === "\\") {
			out.push([r, r]);
			i++;
			continue;
		}
		const del: Row[] = [];
		const add: Row[] = [];
		while (rows[i]?.kind === "-") del.push(rows[i++]);
		while (rows[i]?.kind === "+") add.push(rows[i++]);
		for (let k = 0; k < Math.max(del.length, add.length); k++) out.push([del[k] ?? null, add[k] ?? null]);
	}
	return out;
}

const HunkRows = ({ children }: { children: ReactNode }) => <>{children}</>;
