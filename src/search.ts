// Code search for one repository: the default branch's text files in an FTS5 trigram index inside the
// repository's coordinator, so any substring of three or more characters matches. The index follows
// the branch incrementally: each update reads only the files that changed since the indexed tree.
import type { CodeSearch } from "./api.ts";
import { changedFiles, mapLimit, type ObjectReader } from "./git/diff.ts";

/** Files bigger than this aren't indexed (minified bundles, data files). */
const MAX_FILE_BYTES = 256 * 1024;
/** Changed files one update indexes; past it the index is marked partial. */
const MAX_FILES_PER_UPDATE = 5_000;
/** Text one repository's index may hold. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_RESULTS = 50;
const MAX_LINES_PER_FILE = 5;

interface IndexState {
	commit: string;
	tree: string;
	files: number;
	bytes: number;
	/** Some files were skipped because a limit was reached. */
	partial: boolean;
	at: string;
}

export class CodeIndex {
	private readonly sql: SqlStorage;
	/** False where SQLite lacks FTS5; search then says it's unavailable. */
	readonly available: boolean;

	constructor(sql: SqlStorage) {
		this.sql = sql;
		let available = true;
		try {
			sql.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS code USING fts5(path, content, tokenize = 'trigram');
				CREATE TABLE IF NOT EXISTS code_files (path TEXT PRIMARY KEY, doc INTEGER NOT NULL, bytes INTEGER NOT NULL);
				CREATE TABLE IF NOT EXISTS code_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			`);
		} catch (err) {
			console.error("code search unavailable", err);
			available = false;
		}
		this.available = available;
	}

	state(): IndexState | null {
		if (!this.available) return null;
		const row = this.sql.exec<{ value: string }>("SELECT value FROM code_state WHERE key = 'state'").toArray()[0];
		return row ? (JSON.parse(row.value) as IndexState) : null;
	}

	/** Brings the index up to `commit` (whose root tree is `tree`). */
	async update(repo: ObjectReader, commit: string, tree: string): Promise<void> {
		if (!this.available) return;
		const previous = this.state();
		if (previous?.commit === commit) return;
		const { changes, truncated } = await changedFiles(repo, previous?.tree ?? null, tree, MAX_FILES_PER_UPDATE, 20_000);
		let bytes = previous?.bytes ?? 0;
		let partial = (previous?.partial ?? false) || truncated;
		const contents = await mapLimit(changes, 8, async (change) => {
			if (!change.after || change.after.type === "gitlink" || change.after.type === "symlink") return null;
			const blob = await repo.readBlob(change.after.hash);
			if (!blob || blob.size > MAX_FILE_BYTES) return null;
			const data = new Uint8Array(await blob.arrayBuffer());
			// Binary files (a NUL in the first 8 KB, as git decides) aren't searchable text.
			if (data.subarray(0, 8192).includes(0)) return null;
			return new TextDecoder().decode(data);
		});
		for (const [i, change] of changes.entries()) {
			const old = this.sql.exec<{ doc: number; bytes: number }>("SELECT doc, bytes FROM code_files WHERE path = ?", change.path).toArray()[0];
			if (old) {
				this.sql.exec("DELETE FROM code WHERE rowid = ?", old.doc);
				this.sql.exec("DELETE FROM code_files WHERE path = ?", change.path);
				bytes -= old.bytes;
			}
			const text = contents[i];
			if (text === null) continue;
			const size = text.length;
			if (bytes + size > MAX_INDEX_BYTES) {
				partial = true;
				continue;
			}
			const { doc } = this.sql.exec<{ doc: number }>("INSERT INTO code (path, content) VALUES (?, ?) RETURNING rowid AS doc", change.path, text).one();
			this.sql.exec("INSERT INTO code_files (path, doc, bytes) VALUES (?, ?, ?)", change.path, doc, size);
			bytes += size;
		}
		const files = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM code_files").one().n;
		const next: IndexState = { commit, tree, files, bytes, partial, at: new Date().toISOString() };
		this.sql.exec("INSERT OR REPLACE INTO code_state (key, value) VALUES ('state', ?)", JSON.stringify(next));
	}

	/** Files whose path or content contains `query` (case-insensitive), with the matching lines. */
	search(query: string): Omit<CodeSearch, "indexing"> {
		const state = this.state();
		const base = { commit: state?.commit ?? null, partial: state?.partial ?? false, files: state?.files ?? 0 };
		const q = query.trim();
		if (!this.available || !state || q.length === 0) return { ...base, results: [] };
		// Trigrams need three characters; shorter queries only match file names.
		const rows =
			q.length >= 3
				? this.sql
						.exec<{ path: string; content: string }>(
							"SELECT path, content FROM code WHERE code MATCH ? ORDER BY rank LIMIT ?",
							`"${q.replaceAll('"', '""')}"`,
							MAX_RESULTS,
						)
						.toArray()
				: this.sql
						.exec<{ path: string; content: string }>(
							"SELECT path, '' AS content FROM code_files WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT ?",
							`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`,
							MAX_RESULTS,
						)
						.toArray();
		const needle = q.toLowerCase();
		return {
			...base,
			results: rows.map((row) => {
				const lines: { line: number; text: string }[] = [];
				let total = 0;
				for (const [i, text] of row.content.split("\n").entries()) {
					if (!text.toLowerCase().includes(needle)) continue;
					total++;
					if (lines.length < MAX_LINES_PER_FILE) lines.push({ line: i + 1, text: text.length > 300 ? `${text.slice(0, 300)}…` : text });
				}
				return { path: row.path, lines, matches: total };
			}),
		};
	}

	clear(): void {
		if (!this.available) return;
		this.sql.exec("DELETE FROM code; DELETE FROM code_files; DELETE FROM code_state;");
	}
}
