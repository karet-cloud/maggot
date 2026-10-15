// The default branch's tree, indexed in the repository's coordinator: every file and directory with
// its type, size and object id, so listings and "Go to file" need no reads from storage. It also
// drives code search, reading the text of the files that change. An update walks only directories
// whose tree changed since the indexed one, then reads the changed files, in bounded steps the alarm
// runs one after another, so a big repository's first index (or a big push) spreads over many short
// runs. The walk (down to the entry within a directory) and the files still to read are tables, so a
// restart resumes where it stopped.
import type { TreeEntry as ListedEntry } from "./api.ts";
import { isBinary, mapLimit, type ObjectReader, type TreeEntry } from "./git/diff.ts";
import { MAX_TEXT_BYTES, type CodeIndex, type Sql } from "./search.ts";

export interface IndexLimits {
	/** Files and directories one index may hold; past it listings come from storage. */
	maxEntries: number;
	/** Entries one step may write, however they're spread over directories. */
	entriesPerStep: number;
	/** Directories one step reads, at most. */
	dirsPerStep: number;
	/** Distinct tree entries read before yielding (one directory's pair may cross this). */
	entriesReadPerStep: number;
	/** Estimated bytes retained for tree entries per step, including strings and working maps. */
	bytesReadPerStep: number;
	/** Files one step reads; their contents are dropped after it. */
	filesPerStep: number;
	/** Files one update reads (for sizes and search, which holds as many); the rest keep no size and aren't searchable. */
	maxReads: number;
}

const LIMITS: IndexLimits = { maxEntries: 300_000, entriesPerStep: 2_000, dirsPerStep: 64, entriesReadPerStep: 20_000, bytesReadPerStep: 8 * 1024 * 1024, filesPerStep: 32, maxReads: 20_000 };
const CONCURRENCY = 4;
/** Failed steps in a row after which the index is dropped, to start over when next asked. */
const MAX_FAILURES = 5;
/** Never searchable, so not worth downloading for a size: their sizes stay unknown. */
const UNREAD =
	/\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|tiff?|psd|xcf|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|ear|whl|egg|nupkg|deb|rpm|dmg|iso|img|exe|dll|so|dylib|a|o|obj|lib|class|pyc|wasm|bin|dat|db|sqlite3?|mp[34]|m4[av]|aac|wav|flac|ogg|opus|mov|avi|mkv|webm|woff2?|ttf|otf|eot|glb|fbx|blend|npy|npz|pt|onnx|safetensors|parquet|arrow)$/i;

interface Update {
	commit: string;
	tree: string;
	/** While walking, entries mix two trees; after it, files are still being read. */
	walking: boolean;
	queued: number;
	partial: boolean;
	/** Started from nothing: code search holds nothing older to clean up. */
	fresh: boolean;
}

interface State {
	/** The commit the entries describe once no walk is running; null before the first, or after an overflow. */
	commit: string | null;
	tree: string | null;
	/** Rows in tree_entries. */
	entries: number;
	/** The commit whose tree exceeded an indexing limit: nothing is listed, and it isn't tried again. */
	overflow: string | null;
	update: Update | null;
	/** Where to go next, if the branch moved during a walk. */
	next: { commit: string; tree: string } | null;
}

const EMPTY: State = { commit: null, tree: null, entries: 0, overflow: null, update: null, next: null };

/** Rows under the directory `path`: from `path/` up to (not including) `path0`, `0` sorting right after `/`. */
const below = (path: string) => [`${path}/`, `${path}0`] as const;
/** Regular files: the only entries whose content is searchable text. */
const regular = (e: TreeEntry | null) => e?.type === "blob" || e?.type === "exec";

type WalkItem = {
	dir: string;
	before: string | null;
	after: string;
	/** The last name applied, when a directory takes more than one step. */
	cursor: string | null;
};

export class TreeIndex {
	private readonly sql: Sql;
	private readonly code: CodeIndex;
	private readonly limits: IndexLimits;

	constructor(sql: Sql, code: CodeIndex, limits: Partial<IndexLimits> = {}) {
		this.sql = sql;
		this.code = code;
		this.limits = { ...LIMITS, ...limits };
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
			CREATE TABLE IF NOT EXISTS tree_walk (dir TEXT PRIMARY KEY, before TEXT, after TEXT NOT NULL, cursor TEXT) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS tree_reads (path TEXT PRIMARY KEY, hash TEXT NOT NULL) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS tree_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
	}

	state(): State {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM tree_state WHERE key = 'state'").toArray()[0];
		return row ? { ...EMPTY, ...(JSON.parse(row.value) as Partial<State>) } : { ...EMPTY };
	}

	private save(state: State) {
		this.sql.exec("INSERT OR REPLACE INTO tree_state (key, value) VALUES ('state', ?)", JSON.stringify(state));
	}

	/** Forgets everything, code search included; the next target starts from nothing. */
	reset(): void {
		this.sql.exec("DELETE FROM tree_entries; DELETE FROM tree_walk; DELETE FROM tree_reads; DELETE FROM tree_state;");
		this.code.clear();
	}

	// ── Retries ──────────────────────────────────────────────────────────────
	// Kept with the index, not in memory, so an evicted coordinator doesn't retry at once.

	private retry(): { failures: number; at: number } {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM tree_state WHERE key = 'retry'").toArray()[0];
		return row ? JSON.parse(row.value) : { failures: 0, at: 0 };
	}

	/** When a step may run again after failing (0: any time). */
	retryAt(): number {
		return this.retry().at;
	}

	/** Records a failed step: the next waits longer each time, and after MAX_FAILURES in a row the index is dropped. */
	failed(now = Date.now()): void {
		const failures = this.retry().failures + 1;
		if (failures >= MAX_FAILURES) return this.reset();
		this.sql.exec("INSERT OR REPLACE INTO tree_state (key, value) VALUES ('retry', ?)", JSON.stringify({ failures, at: now + 5_000 * 2 ** failures }));
	}

	succeeded(): void {
		this.sql.exec("DELETE FROM tree_state WHERE key = 'retry'");
	}

	// ── Updates ──────────────────────────────────────────────────────────────

	/** True while an update has work left; the alarm keeps calling step. */
	busy(): boolean {
		return this.state().update !== null;
	}

	/** The entries describe `commit` and can be listed. */
	current(commit: string): boolean {
		const s = this.state();
		return s.overflow === null && s.commit === commit && !s.update?.walking;
	}

	/** `commit` is indexed, being indexed, or known to be too big to: asking for it again changes nothing. */
	settled(commit: string): boolean {
		const s = this.state();
		return s.update ? s.update.commit === commit : s.commit === commit || s.overflow === commit;
	}

	/** Moves the index towards `commit` (root tree `tree`), now or after the walk under way. */
	target(commit: string, tree: string): void {
		const s = this.state();
		if (this.settled(commit)) {
			// Back where the update is going: a newer head queued meanwhile is no longer the head.
			if (s.next) {
				s.next = null;
				this.save(s);
			}
			return;
		}
		if (s.update?.walking) {
			s.next = { commit, tree };
			this.save(s);
			return;
		}
		s.next = null;
		this.start(s, commit, tree);
	}

	private start(s: State, commit: string, tree: string) {
		const base = s.overflow !== null ? null : s.tree;
		let partial = s.update?.partial ?? this.code.state()?.partial ?? false;
		const fresh = base === null;
		if (fresh) {
			// From nothing: whatever is here (an overflowed index, or code search from before this index) goes.
			this.sql.exec("DELETE FROM tree_entries; DELETE FROM tree_walk; DELETE FROM tree_reads;");
			this.code.clear();
			partial = false;
			Object.assign(s, { commit: null, tree: null, entries: 0, overflow: null });
		}
		if (base !== tree) this.sql.exec("INSERT OR REPLACE INTO tree_walk (dir, before, after, cursor) VALUES ('', ?, ?, NULL)", base, tree);
		s.update = { commit, tree, walking: base !== tree, queued: 0, partial, fresh };
		if (base === tree) s.commit = commit;
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
		// read found nothing to do without awaiting, so `s` is still current.
		this.code.finish(s.update.commit, s.update.tree, s.update.partial);
		s.update = null;
		if (s.next) {
			const next = s.next;
			s.next = null;
			this.start(s, next.commit, next.tree);
			return true;
		}
		this.save(s);
		return false;
	}

	/**
	 * Read and apply one directory at a time, stopping before another read once writes or reads are
	 * spent. Content-addressed trees are shared within the step. The cache has a byte cap as well as
	 * an entry quota: long names must not let a small number of entries retain unlimited memory.
	 * readTree is indivisible, so one incoming tree can temporarily exceed the cache cap; it is never
	 * retained if it won't fit. A directory pair too large even for an empty step uses partial search
	 * and the ordinary listing fallback, just like an index that exceeds maxEntries.
	 */
	private async walk(repo: ObjectReader) {
		const items = this.sql.exec<WalkItem>("SELECT dir, before, after, cursor FROM tree_walk ORDER BY dir LIMIT ?", this.limits.dirsPerStep).toArray();
		const trees = new Map<string, TreeEntry[]>();
		let heldEntries = 0;
		let heldBytes = 0;
		const read = async (hash: string): Promise<TreeEntry[] | null> => {
			const cached = trees.get(hash);
			if (cached) return cached;
			const tree = await repo.readTree(hash);
			if (!tree) throw new Error(`Tree ${hash} is missing`);
			// UTF-16 strings plus conservative room for objects, arrays and apply's maps/name set.
			let bytes = 0;
			for (const entry of tree) bytes += 256 + 2 * (entry.name.length + entry.hash.length + entry.mode.length + entry.type.length);
			if (heldBytes + bytes > this.limits.bytesReadPerStep) return null;
			trees.set(hash, tree);
			heldEntries += tree.length;
			heldBytes += bytes;
			return tree;
		};
		let budget = this.limits.entriesPerStep;
		let applied = false;
		for (const item of items) {
			if (budget <= 0 || heldEntries >= this.limits.entriesReadPerStep || heldBytes >= this.limits.bytesReadPerStep) break;
			// An earlier directory may have dropped this one (replaced it with a file).
			if (this.sql.exec("SELECT 1 FROM tree_walk WHERE dir = ? AND after = ?", item.dir, item.after).toArray().length === 0) continue;
			const before = item.before ? await read(item.before) : [];
			const after = before ? await read(item.after) : null;
			// Read state afresh: requests can queue a newer head while a tree is read.
			const s = this.state();
			const update = s.update;
			if (!update?.walking) return;
			if (!before || !after) {
				// If other directories used the cache, retry this one with a fresh budget next step.
				if (applied) break;
				this.overflowed(s, update);
				this.save(s);
				return;
			}
			// From apply through save, nothing awaits: this directory's writes land together.
			const done = this.apply(s, update, item, before, after, budget);
			applied = true;
			budget -= done.used;
			if (done.overflow) {
				this.overflowed(s, update);
				this.save(s);
				return;
			}
			if (done.cursor === null) this.sql.exec("DELETE FROM tree_walk WHERE dir = ?", item.dir);
			else this.sql.exec("UPDATE tree_walk SET cursor = ? WHERE dir = ?", done.cursor, item.dir);
			this.save(s);
		}
		const s = this.state();
		const update = s.update;
		if (update?.walking && this.sql.exec("SELECT 1 FROM tree_walk LIMIT 1").toArray().length === 0) {
			update.walking = false;
			s.commit = update.commit;
			s.tree = update.tree;
			this.save(s);
		}
	}

	/**
	 * Too many entries or tree bytes to index from here. From nothing, the files queued so far are still read for
	 * (partial) search. Partway through an update, directories not reached yet still hold deletions
	 * never applied, so the commit starts over from nothing instead (and overflows again, cleanly).
	 */
	private overflowed(s: State, update: Update) {
		this.sql.exec("DELETE FROM tree_entries; DELETE FROM tree_walk;");
		Object.assign(s, { commit: null, tree: null, entries: 0, overflow: update.commit });
		if (update.fresh) {
			update.walking = false;
			update.partial = true;
			return;
		}
		this.start(s, update.commit, update.tree);
	}

	/**
	 * Applies a directory's changes in name order after its cursor, writing at most `budget` entries.
	 * `cursor` is where to resume (null when the directory is done); `overflow` means the next new
	 * entry would pass maxEntries, so nothing more was written.
	 */
	private apply(s: State, update: Update, item: WalkItem, before: TreeEntry[], after: TreeEntry[], budget: number): { used: number; cursor: string | null; overflow: boolean } {
		const left = new Map(before.map((e) => [e.name, e]));
		const right = new Map(after.map((e) => [e.name, e]));
		const names = [...new Set([...left.keys(), ...right.keys()])].sort();
		let used = 0;
		let last = item.cursor;
		for (const name of names) {
			if (item.cursor !== null && name <= item.cursor) continue;
			const x = left.get(name) ?? null;
			const y = right.get(name) ?? null;
			if (x && y && x.hash === y.hash && x.mode === y.mode) {
				last = name;
				continue;
			}
			if (used >= budget) return { used, cursor: last, overflow: false };
			const path = item.dir ? `${item.dir}/${name}` : name;
			const wasDir = x?.type === "tree";
			const isDir = y?.type === "tree";
			const replaced = Boolean(x && (!y || wasDir !== isDir));
			if (y && (!x || replaced) && s.entries >= this.limits.maxEntries) return { used, cursor: last, overflow: true };
			used++;
			last = name;
			if (x && replaced) this.drop(s, path, wasDir);
			if (!y) continue;
			if (!x || replaced) s.entries++;
			// A size stays only while the object does and it's still a regular file (a mode change keeps it).
			this.sql.exec(
				`INSERT INTO tree_entries (path, dir, name, type, mode, hash, size) VALUES (?, ?, ?, ?, ?, ?, NULL)
				ON CONFLICT (path) DO UPDATE SET type = excluded.type, mode = excluded.mode, hash = excluded.hash,
					size = CASE WHEN tree_entries.hash = excluded.hash AND excluded.type IN ('blob', 'exec') THEN tree_entries.size ELSE NULL END`,
				path,
				item.dir,
				name,
				y.type,
				y.mode,
				y.hash,
			);
			if (isDir) {
				this.sql.exec("INSERT OR REPLACE INTO tree_walk (dir, before, after, cursor) VALUES (?, ?, ?, NULL)", path, wasDir ? (x?.hash ?? null) : null, y.hash);
			} else if (regular(x) && regular(y) && x?.hash === y.hash) {
				// Only the mode changed (blob and executable): the content, and its search entry, stand.
			} else if (regular(y)) {
				this.code.remove(path);
				if (update.queued < this.limits.maxReads) {
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
		return { used, cursor: null, overflow: false };
	}

	/** Forgets `path`, and with `dir`, everything below it. */
	private drop(s: State, path: string, dir: boolean) {
		this.sql.exec("DELETE FROM tree_entries WHERE path = ?", path);
		s.entries--;
		this.sql.exec("DELETE FROM tree_reads WHERE path = ?", path);
		this.code.remove(path);
		if (!dir) return;
		s.entries -= this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tree_entries WHERE path >= ? AND path < ?", ...below(path)).one().n;
		for (const table of ["tree_entries", "tree_reads"]) this.sql.exec(`DELETE FROM ${table} WHERE path >= ? AND path < ?`, ...below(path));
		this.sql.exec("DELETE FROM tree_walk WHERE dir >= ? AND dir < ?", ...below(path));
		this.code.remove(path, true);
	}

	/** Reads a batch of changed files: their sizes, and their text for search. False when none are left. */
	private async read(repo: ObjectReader): Promise<boolean> {
		const rows = this.sql.exec<{ path: string; hash: string }>("SELECT path, hash FROM tree_reads LIMIT ?", this.limits.filesPerStep).toArray();
		if (rows.length === 0) return false;
		const contents = await mapLimit(rows, CONCURRENCY, async (row) => {
			if (UNREAD.test(row.path)) return { size: null, text: null };
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

	// ── Reading ──────────────────────────────────────────────────────────────

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
