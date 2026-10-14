// Streamed diffs (NDJSON, see DiffEvent in src/api.ts): reading the lines as they arrive, and folding
// them into what DiffView shows. No browser APIs, so tests run it too.
import type { Diff, DiffEntry, DiffEvent, FileDiff } from "../../src/api.ts";

/** A diff as it streams in: every file's name from the header, hunks as they come, totals so far. */
export interface StreamedDiff<M = unknown> {
	/** What the header carried besides files (a commit, or a comparison's commits); null before it. */
	meta: M | null;
	/** The root trees compared, for loading one file on its own; null for a diff that wasn't streamed. */
	trees: { from: string | null; to: string } | null;
	list: DiffEntry[];
	/** Files that have arrived, by path. */
	files: Record<string, FileDiff>;
	truncated: boolean;
	additions: number;
	deletions: number;
	/** Every file has arrived. */
	done: boolean;
}

export const emptyDiff = <M>(): StreamedDiff<M> => ({ meta: null, trees: null, list: [], files: {}, truncated: false, additions: 0, deletions: 0, done: false });

/** A whole diff (from a JSON answer) in the streamed shape. */
export function completeDiff(diff: Diff): StreamedDiff<never> {
	return {
		meta: null,
		trees: null,
		list: diff.files.map(({ path, status, oldMode, newMode }) => ({ path, status, oldMode, newMode })),
		files: Object.fromEntries(diff.files.map((f) => [f.path, f])),
		truncated: diff.truncated,
		additions: diff.additions,
		deletions: diff.deletions,
		done: true,
	};
}

export class StreamError extends Error {}

/**
 * The query key for one file of a streamed diff loaded on its own: under the diff's key, and by the
 * trees compared, so a diff that moved on (a push) loads the file afresh instead of showing the old one.
 */
export const fileDiffKey = (diffKey: readonly unknown[], trees: { from: string | null; to: string }, path: string) =>
	[...diffKey, "file", trees.from ?? "", trees.to, path] as const;

/** Folds a batch of events into the diff, without changing `acc`. An error line throws. */
export function reduceDiff<M>(acc: StreamedDiff<M>, events: DiffEvent<M>[]): StreamedDiff<M> {
	let next = acc;
	let files: Record<string, FileDiff> | null = null;
	for (const event of events) {
		if (event.type === "header") {
			next = { ...emptyDiff<M>(), meta: event.meta, trees: event.trees, list: event.files, truncated: event.truncated };
			files = null;
		} else if (event.type === "file") {
			files ??= { ...next.files };
			files[event.file.path] = event.file;
			next = { ...next, files, additions: next.additions + event.file.additions, deletions: next.deletions + event.file.deletions };
		} else if (event.type === "end") {
			// The server's totals, which the files' already add up to.
			next = { ...next, additions: event.additions, deletions: event.deletions, done: true };
		} else if (event.type === "error") {
			throw new StreamError(event.message);
		}
	}
	return next;
}

/**
 * The lines of an NDJSON body, parsed. Each read's complete lines come out together, so a consumer
 * renders once per network chunk, not once per file. Ends with an error if the body stops before an
 * `end` or `error` line (a dropped connection would otherwise look like a short diff).
 */
export async function* readDiff<M>(body: ReadableStream<Uint8Array>): AsyncGenerator<DiffEvent<M>[]> {
	const reader = body.getReader();
	const utf8 = new TextDecoder();
	let buffer = "";
	let ended = false;
	let drained = false;
	try {
		while (!drained) {
			const { value, done } = await reader.read();
			drained = done;
			// `stream` keeps a character split across two reads whole.
			buffer += utf8.decode(value, { stream: !done });
			const cut = done ? buffer.length : buffer.lastIndexOf("\n") + 1;
			const batch = buffer
				.slice(0, cut)
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as DiffEvent<M>);
			buffer = buffer.slice(cut);
			if (batch.some((e) => e.type === "end" || e.type === "error")) ended = true;
			if (batch.length) yield batch;
		}
	} finally {
		// Left early (the query was cancelled, or a line failed to parse): stop downloading the rest.
		if (!drained) await reader.cancel().catch(() => {});
	}
	if (!ended) throw new StreamError("The diff stopped partway; reload to try again");
}
