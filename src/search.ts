// Code search for one repository: the default branch's text files in an FTS5 trigram index inside the
// repository's coordinator, so any substring of three or more characters matches. The tree index
// (tree-index.ts) keeps it following the branch: it puts and removes files as they change.
import type { CodeSearch } from "./api.ts";

/** Files bigger than this aren't indexed (minified bundles, data files). */
export const MAX_TEXT_BYTES = 256 * 1024;
/** Text one repository's index may hold. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_RESULTS = 50;
/** Files one index may hold, whatever their size. */
const MAX_INDEX_FILES = 20_000;
/** What a file costs the budget beyond its text: its path and row, roughly. */
const FILE_OVERHEAD = 256;
const utf8 = new TextEncoder();
const cost = (path: string, text: string) => utf8.encode(text).length + utf8.encode(path).length + FILE_OVERHEAD;
/** Longer phrases make FTS5's position matching expensive; nobody needs them to find code. */
export const MAX_QUERY_LENGTH = 100;
const MAX_LINES_PER_FILE = 5;

/**
 * The part of a Durable Object's SqlStorage the index uses, written out so this module also
 * type-checks (and runs) outside the Worker, in tests.
 */
export interface Sql {
	exec<T extends Record<string, ArrayBuffer | string | number | null>>(query: string, ...bindings: unknown[]): { toArray(): T[]; one(): T };
}

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
	private readonly sql: Sql;
	/** False where SQLite lacks FTS5; search then says it's unavailable. */
	readonly available: boolean;
	private totals: { files: number; bytes: number } | null = null;

	constructor(sql: Sql) {
		this.sql = sql;
		let available = true;
		try {
			// The first version keyed documents on an FTS rowid that SQLite never reported; its index can't
			// be trusted, so it's dropped and rebuilt.
			sql.exec("DROP TABLE IF EXISTS code_files");
			if (sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'code_docs'").toArray().length === 0) {
				sql.exec("DROP TABLE IF EXISTS code; DROP TABLE IF EXISTS code_state;");
			}
			sql.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS code USING fts5(path, content, tokenize = 'trigram');
				CREATE TABLE IF NOT EXISTS code_docs (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL);
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

	/** Files and bytes held, kept here once counted: this index is the only writer of its tables. */
	private held(): { files: number; bytes: number } {
		this.totals ??= this.sql.exec<{ files: number; bytes: number }>("SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM code_docs").one();
		return this.totals;
	}

	/** Indexes `text` as the content of `path`, replacing what was there. False if the index is full, leaving the file out. */
	put(path: string, text: string): boolean {
		if (!this.available) return true;
		this.remove(path);
		const size = cost(path, text);
		const held = this.held();
		if (held.bytes + size > MAX_INDEX_BYTES || held.files >= MAX_INDEX_FILES) return false;
		// The id comes from the ordinary table (FTS5 doesn't report rowids it assigns) and is given to FTS.
		const { id } = this.sql.exec<{ id: number }>("INSERT INTO code_docs (path, bytes) VALUES (?, ?) RETURNING id", path, size).one();
		this.sql.exec("INSERT INTO code (rowid, path, content) VALUES (?, ?, ?)", id, path, text);
		held.files++;
		held.bytes += size;
		return true;
	}

	/** Drops `path`, or with `under`, every file below the directory `path`. */
	remove(path: string, under = false): void {
		if (!this.available) return;
		const rows = under
			? this.sql.exec<{ id: number; bytes: number }>("SELECT id, bytes FROM code_docs WHERE path >= ? AND path < ?", `${path}/`, `${path}0`).toArray()
			: this.sql.exec<{ id: number; bytes: number }>("SELECT id, bytes FROM code_docs WHERE path = ?", path).toArray();
		const held = this.held();
		for (const row of rows) {
			this.sql.exec("DELETE FROM code WHERE rowid = ?", row.id);
			this.sql.exec("DELETE FROM code_docs WHERE id = ?", row.id);
			held.files--;
			held.bytes -= row.bytes;
		}
	}

	/** Records that the index now reflects `commit` (whose root tree is `tree`). */
	finish(commit: string, tree: string, partial: boolean): void {
		if (!this.available) return;
		const { files, bytes } = this.held();
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
							"SELECT path, '' AS content FROM code_docs WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT ?",
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
		this.sql.exec("DELETE FROM code; DELETE FROM code_docs; DELETE FROM code_state;");
		this.totals = { files: 0, bytes: 0 };
	}
}
