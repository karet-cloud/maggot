// The default branch's tree, indexed in the repository's coordinator: every file and directory with
// its type, size and object id, so listings and "Go to file" need no reads from storage. It also
// drives code search, reading the text of the files that change. An update walks only directories
// whose tree changed since the indexed one, then reads the changed files, in bounded steps the alarm
// runs one after another, so a big repository's first index (or a big push) spreads over many short
// runs. The walk and the files still to read are tables, so a restart resumes where it stopped.
import type { TreeEntry as ListedEntry } from "./api.ts";
import { isBinary, mapLimit, type ObjectReader, type TreeEntry } from "./git/diff.ts";
import { MAX_TEXT_BYTES, type CodeIndex, type Sql } from "./search.ts";

/** Files and directories one index may hold; past it listings come from storage. */
const MAX_ENTRIES = 300_000;
/** Files one update reads (for sizes and search, which holds as many); the rest keep no size and aren't searchable. */
const MAX_READS_PER_UPDATE = 20_000;
/** Directories one step reads. */
const DIRS_PER_STEP = 64;
/** Files one step reads; their contents are dropped after it. */
const FILES_PER_STEP = 32;
const CONCURRENCY = 8;

interface State {
	/** The commit the entries describe once no walk is running; null before the first, or after an overflow. */
	commit: string | null;
	tree: string | null;
	/** More entries than MAX_ENTRIES: nothing is listed from here. */
	overflow: boolean;
	/** The update under way. While `walking`, entries mix two trees; after it, files are still being read. */
	update: { commit: string; tree: string; walking: boolean; queued: number; partial: boolean } | null;
	/** Where to go next, if the branch moved during a walk. */
	next: { commit: string; tree: string } | null;
}

const EMPTY: State = { commit: null, tree: null, overflow: false, update: null, next: null };

/** Rows under the directory `path`: from `path/` up to (not including) `path0`, `0` sorting right after `/`. */
const below = (path: string) => [`${path}/`, `${path}0`] as const;

export class TreeIndex {
	private readonly sql: Sql;
	private readonly code: CodeIndex;

	constructor(sql: Sql, code: CodeIndex) {
		this.sql = sql;
		this.code = code;
		sql.exec(`
			CREATE TABLE IF NOT EXISTS tree_entries (
				path TEXT PRIMARY KEY,
				dir TEXT NOT NULL,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				mode TEXT NOT NULL,
				hash TEXT NOT NULL,
				size INTEGER
			) WITHOUT ROWID;
			CREATE INDEX IF NOT EXISTS tree_entries_dir ON tree_entries (dir);
			CREATE TABLE IF NOT EXISTS tree_walk (dir TEXT PRIMARY KEY, before TEXT, after TEXT NOT NULL) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS tree_reads (path TEXT PRIMARY KEY, hash TEXT NOT NULL) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS tree_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
	}

	state(): State {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM tree_state WHERE key = 'state'").toArray()[0];
		return row ? (JSON.parse(row.value) as State) : { ...EMPTY };
	}

	private save(state: State) {
		this.sql.exec("INSERT OR REPLACE INTO tree_state (key, value) VALUES ('state', ?)", JSON.stringify(state));
	}

	/** Forgets everything, code search included; the next target starts from nothing. */
	reset(): void {
		this.sql.exec("DELETE FROM tree_entries; DELETE FROM tree_walk; DELETE FROM tree_reads; DELETE FROM tree_state;");
		this.code.clear();
	}

	/** True while an update has work left; the alarm keeps calling step. */
	busy(): boolean {
		return this.state().update !== null;
	}

	/** The entries describe `commit` and can be listed. */
	current(commit: string): boolean {
		const s = this.state();
		return !s.overflow && s.commit === commit && !s.update?.walking;
	}

	/** Moves the index towards `commit` (root tree `tree`), now or after the walk under way. */
	target(commit: string, tree: string): void {
		const s = this.state();
		if (s.update?.commit === commit || (!s.update && s.commit === commit)) return;
		if (s.update?.walking) {
			s.next = { commit, tree };
			this.save(s);
			return;
		}
		this.start(s, commit, tree);
	}

	private start(s: State, commit: string, tree: string) {
		const base = s.overflow ? null : s.tree;
		let partial = s.update?.partial ?? this.code.state()?.partial ?? false;
		if (base === null) {
			// From nothing: whatever is here (an overflowed index, or code search from before this index) goes.
			this.sql.exec("DELETE FROM tree_entries; DELETE FROM tree_walk; DELETE FROM tree_reads;");
			this.code.clear();
			partial = false;
			s.overflow = false;
		}
		if (base !== tree) this.sql.exec("INSERT OR REPLACE INTO tree_walk (dir, before, after) VALUES ('', ?, ?)", base, tree);
		s.update = { commit, tree, walking: base !== tree, queued: 0, partial };
		if (base === tree) s.commit = commit;
		s.next = null;
		this.save(s);
	}

	/** Does one bounded piece of the update. True if there's more. */
	async step(repo: ObjectReader): Promise<boolean> {
		const s = this.state();
		if (!s.update) return false;
		if (s.update.walking) {
			await this.walk(repo);
			return true;
		}
		if (await this.read(repo)) return true;
		this.code.finish(s.update.commit, s.update.tree, s.update.partial);
		s.update = null;
		this.save(s);
		if (s.next) {
			this.start(s, s.next.commit, s.next.tree);
			return true;
		}
		return false;
	}

	/** Reads a batch of changed directories and applies the difference between their old and new trees. */
	private async walk(repo: ObjectReader) {
		const items = this.sql.exec<{ dir: string; before: string | null; after: string }>("SELECT dir, before, after FROM tree_walk LIMIT ?", DIRS_PER_STEP).toArray();
		const read = async (hash: string) => {
			const tree = await repo.readTree(hash);
			if (!tree) throw new Error(`Tree ${hash} is missing`);
			return tree;
		};
		const trees = await mapLimit(items, CONCURRENCY, (item) => Promise.all([item.before ? read(item.before) : [], read(item.after)]));
		// From here to the save, nothing awaits: the step's writes land together.
		const s = this.state();
		const update = s.update;
		if (!update) return;
		for (const [i, item] of items.entries()) {
			this.apply(update, item.dir, trees[i][0], trees[i][1]);
			this.sql.exec("DELETE FROM tree_walk WHERE dir = ?", item.dir);
		}
		if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tree_entries").one().n > MAX_ENTRIES) {
			// Too big to list from here. The files queued so far are still read for search, which is partial.
			this.sql.exec("DELETE FROM tree_entries; DELETE FROM tree_walk;");
			s.overflow = true;
			s.commit = null;
			s.tree = null;
			update.walking = false;
			update.partial = true;
		} else if (this.sql.exec("SELECT 1 FROM tree_walk LIMIT 1").toArray().length === 0) {
			update.walking = false;
			s.commit = update.commit;
			s.tree = update.tree;
		}
		this.save(s);
	}

	private apply(update: NonNullable<State["update"]>, dir: string, before: TreeEntry[], after: TreeEntry[]) {
		const left = new Map(before.map((e) => [e.name, e]));
		const right = new Map(after.map((e) => [e.name, e]));
		for (const name of new Set([...left.keys(), ...right.keys()])) {
			const x = left.get(name) ?? null;
			const y = right.get(name) ?? null;
			if (x && y && x.hash === y.hash && x.mode === y.mode) continue;
			const path = dir ? `${dir}/${name}` : name;
			const wasDir = x?.type === "tree";
			const isDir = y?.type === "tree";
			if (x && (!y || wasDir !== isDir)) this.drop(path, wasDir);
			if (!y) continue;
			// A size stays only while the object does (a mode change keeps it).
			this.sql.exec(
				`INSERT INTO tree_entries (path, dir, name, type, mode, hash, size) VALUES (?, ?, ?, ?, ?, ?, NULL)
				ON CONFLICT (path) DO UPDATE SET type = excluded.type, mode = excluded.mode, hash = excluded.hash,
					size = CASE WHEN tree_entries.hash = excluded.hash THEN tree_entries.size ELSE NULL END`,
				path,
				dir,
				name,
				y.type,
				y.mode,
				y.hash,
			);
			if (isDir) {
				this.sql.exec("INSERT OR REPLACE INTO tree_walk (dir, before, after) VALUES (?, ?, ?)", path, wasDir ? (x?.hash ?? null) : null, y.hash);
			} else if (x?.hash === y.hash && !wasDir) {
				// Only the mode changed: the content (and its search entry) stands.
			} else if (y.type === "blob" || y.type === "exec") {
				this.code.remove(path);
				if (update.queued < MAX_READS_PER_UPDATE) {
					this.sql.exec("INSERT OR REPLACE INTO tree_reads (path, hash) VALUES (?, ?)", path, y.hash);
					update.queued++;
				} else {
					this.sql.exec("DELETE FROM tree_reads WHERE path = ?", path);
					update.partial = true;
				}
			} else {
				// Symlinks and submodules have no text to search.
				this.code.remove(path);
				this.sql.exec("DELETE FROM tree_reads WHERE path = ?", path);
			}
		}
	}

	/** Forgets `path`, and with `dir`, everything below it. */
	private drop(path: string, dir: boolean) {
		this.sql.exec("DELETE FROM tree_entries WHERE path = ?", path);
		this.sql.exec("DELETE FROM tree_reads WHERE path = ?", path);
		this.code.remove(path);
		if (!dir) return;
		for (const table of ["tree_entries", "tree_reads"]) this.sql.exec(`DELETE FROM ${table} WHERE path >= ? AND path < ?`, ...below(path));
		this.sql.exec("DELETE FROM tree_walk WHERE dir >= ? AND dir < ?", ...below(path));
		this.code.remove(path, true);
	}

	/** Reads a batch of changed files: their sizes, and their text for search. False when none are left. */
	private async read(repo: ObjectReader): Promise<boolean> {
		const rows = this.sql.exec<{ path: string; hash: string }>("SELECT path, hash FROM tree_reads LIMIT ?", FILES_PER_STEP).toArray();
		if (rows.length === 0) return false;
		const contents = await mapLimit(rows, CONCURRENCY, async (row) => {
			let blob: Blob | null;
			try {
				blob = await repo.readBlob(row.hash);
			} catch (err) {
				// Too big to buffer: no size, no search.
				if ((err as { code?: string }).code === "MEMORY_LIMIT") return { size: null, text: null };
				throw err;
			}
			if (!blob) return { size: null, text: null };
			if (blob.size > MAX_TEXT_BYTES) return { size: blob.size, text: null };
			const bytes = new Uint8Array(await blob.arrayBuffer());
			return { size: blob.size, text: isBinary(bytes) ? null : new TextDecoder().decode(bytes) };
		});
		const s = this.state();
		for (const [i, row] of rows.entries()) {
			const { size, text } = contents[i];
			// The row may have moved on (or gone) while this step read; then this read is stale.
			if (this.sql.exec("DELETE FROM tree_reads WHERE path = ? AND hash = ? RETURNING path", row.path, row.hash).toArray().length === 0) continue;
			this.sql.exec("UPDATE tree_entries SET size = ? WHERE path = ? AND hash = ?", size, row.path, row.hash);
			if (text !== null && !this.code.put(row.path, text) && s.update) s.update.partial = true;
		}
		this.save(s);
		return true;
	}

	/**
	 * A directory of `commit`, if the index describes it: its entries, directories first. `missing`
	 * names the first part of `dir` that isn't a directory. Null if the index can't answer.
	 */
	listing(commit: string, dir: string): { entries: ListedEntry[] } | { missing: string } | null {
		if (!this.current(commit)) return null;
		const parts = dir.split("/").filter(Boolean);
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const row = this.sql.exec<{ type: string }>("SELECT type FROM tree_entries WHERE path = ?", prefix).toArray()[0];
			if (row?.type !== "tree") return { missing: prefix };
		}
		const rows = this.sql
			.exec<{ path: string; name: string; type: ListedEntry["type"]; hash: string; size: number | null }>("SELECT path, name, type, hash, size FROM tree_entries WHERE dir = ?", parts.join("/"))
			.toArray();
		return {
			entries: rows
				.map((r) => ({ name: r.name, path: r.path, type: r.type, hash: r.hash, size: r.type === "tree" ? null : r.size }))
				.sort((a, b) => Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name)),
		};
	}

	/** Every file path of `commit` (not directories or submodules), sorted, up to `limit`; null if the index can't answer. */
	paths(commit: string, limit: number): { paths: string[]; truncated: boolean } | null {
		if (!this.current(commit)) return null;
		const rows = this.sql.exec<{ path: string }>("SELECT path FROM tree_entries WHERE type NOT IN ('tree', 'gitlink') ORDER BY path LIMIT ?", limit + 1).toArray();
		return { paths: rows.slice(0, limit).map((r) => r.path), truncated: rows.length > limit };
	}
}
