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
