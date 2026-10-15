import { useQuery, type QueryKey } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Columns2, FileCode2, Rows2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, repoParams, type Diff, type DiffEntry, type DiffHunk, type FileDiff } from "../lib/api.ts";
import { completeDiff, fileDiffKey, STREAMED, type StreamedDiff } from "../lib/diff-stream.ts";
import { highlightLines, languageFor } from "../lib/highlight.ts";
import { Button, cx, ErrorNote, Panel, Spinner } from "./ui.tsx";

type Layout = "unified" | "split";
const LAYOUT_KEY = "maggot.diff.layout";
/** Files with more changed lines than this start collapsed. */
const COLLAPSE_ABOVE = 400;
/** How far outside the viewport a file's lines are rendered ahead of scrolling to them. */
const RENDER_MARGIN = "1200px 0px";
/** A diff line's height in px, for holding a not-yet-rendered file's place. */
const LINE_PX = 20;

/** True once `ref`'s element has come near the viewport, and from then on. */
function useNearViewport(ref: RefObject<Element | null>): boolean {
	const [near, setNear] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (near || !el) return;
		if (typeof IntersectionObserver === "undefined") return setNear(true);
		const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: RENDER_MARGIN });
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref, near]);
	return near;
}

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
const keyPath = (key: string) => key.split(":").slice(2).join(":");

/** Where a streamed diff came from, so one file's hunks can load on their own: its query key and endpoint path (from `diffs`). */
export interface DiffSource {
	key: QueryKey;
	path: string;
}

/**
 * A full diff: a summary with a file index, then each file's hunks. `diff` is a whole diff, or one
 * streaming in: files show as they arrive, and with `source`, collapsed large ones load on demand.
 * A file renders its lines only once scrolled near, so hundreds of files stay quick. `viewRef` is
 * where "View file" links point (the new side of the diff). `error` is a stream that broke partway:
 * it shows with what arrived, and `onRetry` fetches the diff again.
 */
export function DiffView({
	diff,
	source,
	project,
	viewRef,
	title,
	notes,
	error,
	onRetry,
}: {
	diff: Diff | StreamedDiff<unknown>;
	source?: DiffSource;
	project: string;
	viewRef?: string;
	title?: ReactNode;
	notes?: DiffNotes;
	error?: unknown;
	onRetry?: () => void;
}) {
	const view = useMemo(() => ("list" in diff ? diff : completeDiff(diff)), [diff]);
	const [layout, setLayout] = useLayout();
	const [indexOpen, setIndexOpen] = useState<boolean | null>(null);
	const commented = useMemo(() => new Set([...(notes?.under.keys() ?? [])].map(keyPath)), [notes]);
	if (view.done && view.list.length === 0) {
		return (
			<Panel title={title ?? "Changes"}>
				<p className="px-4 py-6 text-center text-xs text-faint">No changes.</p>
			</Panel>
		);
	}
	const arrived = view.files.size;
	const showIndex = indexOpen ?? view.list.length <= 12;
	const streaming = !view.done && !error;
	return (
		<div className="space-y-3">
			<Panel
				title={title ?? "Changes"}
				actions={
					<div className="flex items-center gap-3">
						<span className="flex items-center gap-1 text-xs text-dim">
							{streaming && <Spinner className="size-3.5" />}
							{view.list.length}
							{view.truncated ? "+" : ""} {view.list.length === 1 ? "file" : "files"}{" "}
							<span className="font-mono text-emerald-300">+{view.additions}</span>{" "}
							<span className="font-mono text-rose-300">−{view.deletions}</span>
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
					onClick={() => setIndexOpen(!showIndex)}
					className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-dim hover:text-fg"
				>
					{showIndex ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
					Files changed
					{!view.done && (
						<span className="text-faint">
							· {arrived} of {view.list.length} loaded
						</span>
					)}
				</button>
				{showIndex && (
					<ul className="border-t border-line/60 py-1">
						{view.list.map((entry) => (
							<li key={entry.path}>
								<a href={`#diff-${encodeURIComponent(entry.path)}`} className="flex items-center gap-2 px-4 py-1 font-mono text-xs text-dim hover:bg-raised hover:text-fg">
									<StatusMark status={entry.status} />
									<span className="min-w-0 flex-1 truncate">{entry.path}</span>
									<EntryCounts file={view.files.get(entry.path)} />
								</a>
							</li>
						))}
					</ul>
				)}
				{view.truncated && (
					<p className="border-t border-line/60 px-4 py-2 text-xs text-amber-300">
						Only the first {view.list.length} files are shown. Clone the repository to see the full diff.
					</p>
				)}
				{Boolean(error) && (
					<div className="flex flex-wrap items-center gap-2 border-t border-line/60 px-4 py-2">
						<div className="min-w-0 flex-1">
							<ErrorNote error={error} />
						</div>
						{onRetry && (
							<Button className="text-xs" onClick={onRetry}>
								Retry
							</Button>
						)}
					</div>
				)}
			</Panel>
			{view.list.map((entry) => (
				<FileSection
					key={entry.path}
					entry={entry}
					file={view.files.get(entry.path)}
					layout={layout}
					project={project}
					viewRef={viewRef}
					notes={notes}
					commented={commented.has(entry.path)}
					load={source && view.trees ? { source, trees: view.trees } : undefined}
					stalled={!streaming && !view.done}
				/>
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

const EntryCounts = ({ file }: { file: FileDiff | undefined }) => (file ? <Counts file={file} /> : null);

function Counts({ file }: { file: FileDiff }) {
	if (file.binary) return <span className="text-[11px] text-faint">binary</span>;
	if (file.tooLarge) return <span className="text-[11px] text-faint">large</span>;
	return (
		<span className="shrink-0 font-mono text-[11px]">
			<span className="text-emerald-300">+{file.additions}</span> <span className="text-rose-300">−{file.deletions}</span>
		</span>
	);
}

/** Room a file's lines take, roughly, so a placeholder holds its place on the page. */
const estimate = (file: FileDiff) => file.hunks.reduce((n, h) => n + h.lines.length + 1, 0) * LINE_PX;

/** Why a file starts collapsed, if it does; its "Load diff" button says so. */
function collapsedBecause(file: FileDiff): string | null {
	if (file.binary) return null;
	if (file.deferred === "generated") return "Generated or lock file.";
	if (file.deferred === "large" || file.additions + file.deletions > COLLAPSE_ABOVE) return `Large diff (${file.additions + file.deletions} changed lines).`;
	if (file.tooLarge) return "Too large to diff with the rest.";
	return null;
}

function FileSection({
	entry,
	file: streamed,
	layout,
	project,
	viewRef,
	notes,
	commented,
	load,
	stalled,
}: {
	entry: DiffEntry;
	/** Undefined until it arrives. */
	file: FileDiff | undefined;
	layout: Layout;
	project: string;
	viewRef?: string;
	notes?: DiffNotes;
	/** A review comment is on one of its lines, so it opens (and loads) by itself. */
	commented: boolean;
	load?: { source: DiffSource; trees: { from: string | null; to: string } };
	/** The stream stopped; a file that hasn't arrived won't. */
	stalled: boolean;
}) {
	const section = useRef<HTMLElement>(null);
	const near = useNearViewport(section);
	const [opened, setOpened] = useState<boolean | null>(null);
	const reason = streamed ? collapsedBecause(streamed) : null;
	const open = opened ?? (reason === null || commented);
	// Hunks the stream left out (or couldn't fit), fetched for this one file once it's opened.
	const missing = Boolean(streamed && !streamed.binary && (streamed.deferred || streamed.tooLarge));
	const loaded = useQuery({
		meta: STREAMED,
		queryKey: fileDiffKey(load?.source.key ?? [], load?.trees ?? { from: null, to: "" }, entry.path),
		queryFn: () => api.diffFile(load?.source.path ?? "", entry.path, load?.trees ?? { from: null, to: "" }),
		enabled: missing && open && Boolean(load),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const file = loaded.data ?? streamed;
	const modeChange = entry.oldMode && entry.newMode && entry.oldMode !== entry.newMode ? `${entry.oldMode} → ${entry.newMode}` : null;
	const parent = entry.path.split("/").slice(0, -1).join("/") || undefined;
	const note = (text: ReactNode) => <p className="flex items-center gap-2 px-4 py-3 text-xs text-faint">{text}</p>;
	let body: ReactNode;
	if (!file) {
		body = stalled
			? note("Not loaded: the diff stopped before this file.")
			: note(
					<>
						<Spinner className="size-3.5" /> Loading…
					</>,
				);
	} else if (!open) {
		body =
			missing && !load ? (
				note("This diff is too large to show here.")
			) : (
				<button type="button" onClick={() => setOpened(true)} className="w-full px-4 py-3 text-xs text-accent hover:underline">
					{reason} Load diff
				</button>
			);
	} else if (file.binary) body = note(`Binary file ${file.status}.`);
	else if (missing && load && loaded.isPending) {
		body = note(
			<>
				<Spinner className="size-3.5" /> Loading the diff…
			</>,
		);
	} else if (missing && loaded.error) {
		body = (
			<div className="px-4 py-3">
				<ErrorNote error={loaded.error} />
			</div>
		);
	} else if (file.tooLarge || file.deferred) body = note("This diff is too large to show here.");
	else if (file.hunks.length === 0) body = note(modeChange ? "File mode changed." : file.status === "added" ? "Empty file added." : "Empty file.");
	else if (!near) body = <div style={{ height: estimate(file) }} aria-hidden />;
	else body = layout === "unified" ? <Unified file={file} notes={notes} /> : <Split file={file} notes={notes} />;
	return (
		<section ref={section} id={`diff-${encodeURIComponent(entry.path)}`} className="scroll-mt-16 overflow-clip rounded-lg border border-line bg-panel">
			<header className="sticky top-[49px] z-[1] flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
				<button type="button" onClick={() => setOpened(!open)} className="text-faint hover:text-fg" aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}>
					{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
				</button>
				<StatusMark status={entry.status} />
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{entry.path}</span>
				{modeChange && <span className="font-mono text-[11px] text-faint">{modeChange}</span>}
				{file && <Counts file={file} />}
				{entry.status !== "deleted" && (
					<Link
						to="/$owner/$repo"
						params={repoParams(project)}
						search={{ ref: viewRef, path: parent, file: entry.path }}
						className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim hover:bg-raised hover:text-fg"
					>
						<FileCode2 className="size-3.5" />
						View
					</Link>
				)}
			</header>
			{/* Once rendered, files scrolled far away still skip layout and paint. */}
			<div style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${file && open ? Math.max(estimate(file), 40) : 40}px` }}>{body}</div>
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
			className="absolute top-0 left-0 hidden size-5 items-center justify-center rounded bg-accent text-[13px] leading-none text-white group-hover:flex"
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
