// node:sqlite standing in for a Durable Object's SqlStorage, in tests.
import type { DatabaseSync } from "node:sqlite";

/** SqlStorage's cursor, as far as runs.ts uses it. */
export function sqlStorage(db: DatabaseSync): SqlStorage {
	const cursor = (rows: Record<string, unknown>[], written: number) => ({
		toArray: () => rows,
		one: () => {
			if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
			return rows[0];
		},
		rowsWritten: written,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	});
	return {
		exec(query: string, ...params: unknown[]) {
			if (params.length === 0 && query.split(";").filter((q) => q.trim()).length > 1) {
				db.exec(query);
				return cursor([], 0);
			}
			const stmt = db.prepare(query);
			const args = params as (string | number | null)[];
			if (stmt.columns().length > 0) {
				const rows = stmt.all(...args) as Record<string, unknown>[];
				return cursor(rows, /^\s*(INSERT|UPDATE|DELETE)/i.test(query) ? rows.length : 0);
			}
			return cursor([], Number(stmt.run(...args).changes));
		},
	} as unknown as SqlStorage;
}

/** D1Database, as far as db.ts uses it: prepare, bind, first, all, run and batch. */
export function d1Database(db: DatabaseSync): D1Database {
	const statement = (query: string, args: unknown[] = []) => {
		const params = args as (string | number | null)[];
		// Like D1, a statement that returns rows gives them in `results`, whether it was run or listed.
		const run = () => {
			const stmt = db.prepare(query);
			if (stmt.columns().length > 0) return { results: stmt.all(...params), meta: { changes: 0 } };
			return { results: [], meta: { changes: Number(stmt.run(...params).changes) } };
		};
		return {
			bind: (...next: unknown[]) => statement(query, next),
			first: async <T>() => (db.prepare(query).get(...params) as T | undefined) ?? null,
			all: async () => run(),
			run: async () => run(),
			runSync: run,
		};
	};
	return {
		prepare: (query: string) => statement(query),
		batch: async (stmts: { runSync: () => unknown }[]) => stmts.map((s) => s.runSync()),
	} as unknown as D1Database;
}
