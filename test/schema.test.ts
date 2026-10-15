import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { schemaEnsurer, type SchemaStatements } from "../src/db.ts";

/** The part of D1 ensureSchema uses, over node:sqlite, counting the statements it runs. */
function d1(sqlite = new DatabaseSync(":memory:"), opts: { failOn?: RegExp } = {}) {
	const ran: string[] = [];
	const exec = (sql: string, args: unknown[]) => {
		ran.push(sql);
		if (opts.failOn?.test(sql)) throw new Error(`simulated failure: ${sql}`);
		const stmt = sqlite.prepare(sql);
		return stmt.columns().length > 0 ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
	};
	const prepare = (sql: string) => {
		const statement = {
			args: [] as unknown[],
			sql,
			bind(...args: unknown[]) {
				statement.args = args;
				return statement;
			},
			async first() {
				return (exec(sql, statement.args)[0] as unknown) ?? null;
			},
			async run() {
				exec(sql, statement.args);
				return { meta: { changes: 0 } };
			},
		};
		return statement;
	};
	const database = {
		prepare,
		async batch(statements: ReturnType<typeof prepare>[]) {
			sqlite.exec("begin");
			try {
				for (const s of statements) exec(s.sql, s.args);
				sqlite.exec("commit");
			} catch (err) {
				sqlite.exec("rollback");
				throw err;
			}
			return [];
		},
	};
	return { database: database as unknown as D1Database, ran, sqlite };
}

const V1: SchemaStatements = {
	tables: [`create table if not exists "thing" ("id" text primary key)`],
	columns: [`alter table "thing" add column "size" integer not null default 0`],
	lateIndexes: [`create index if not exists "thing_size_idx" on "thing" ("size")`],
};
const V2: SchemaStatements = { ...V1, columns: [...V1.columns, `alter table "thing" add column "color" text`] };

const ddl = (ran: string[]) => ran.filter((sql) => /^(create|alter)/.test(sql));

test("ensureSchema runs the DDL once, then only reads the recorded version", async () => {
	const first = d1();
	await schemaEnsurer(V1)(first.database);
	assert.ok(ddl(first.ran).length > 0);
	// A new isolate (a fresh ensurer) against the same database.
	const second = d1(first.sqlite);
	await schemaEnsurer(V1)(second.database);
	assert.deepEqual(ddl(second.ran), []);
	assert.equal(second.ran.length, 1);
	// And the same isolate again does nothing at all.
	const ensure = schemaEnsurer(V1);
	const third = d1(first.sqlite);
	await ensure(third.database);
	await ensure(third.database);
	assert.equal(third.ran.length, 1);
});

test("ensureSchema reruns the DDL when the statements change", async () => {
	const { sqlite } = d1();
	await schemaEnsurer(V1)(d1(sqlite).database);
	const after = d1(sqlite);
	await schemaEnsurer(V2)(after.database);
	assert.ok(ddl(after.ran).some((sql) => sql.includes(`"color"`)));
	const columns = sqlite.prepare(`select "name" from pragma_table_info('thing')`).all().map((r) => (r as { name: string }).name);
	assert.deepEqual(columns, ["id", "size", "color"]);
});

test("a failed migration isn't recorded, so the next request tries again", async () => {
	const { sqlite } = d1();
	const failing = d1(sqlite, { failOn: /thing_size_idx/ });
	const ensure = schemaEnsurer(V1);
	await assert.rejects(ensure(failing.database), /simulated failure/);
	assert.equal(sqlite.prepare(`select count(*) as n from "maggot_schema"`).get()?.n, 0);
	const retry = d1(sqlite);
	await ensure(retry.database);
	assert.ok(ddl(retry.ran).length > 0);
	assert.equal(sqlite.prepare(`select count(*) as n from "maggot_schema"`).get()?.n, 1);
});

test("concurrent requests share one check, and stop waiting for one that hangs", async () => {
	const { sqlite } = d1();
	const shared = d1(sqlite);
	const ensure = schemaEnsurer(V1);
	await Promise.all([ensure(shared.database), ensure(shared.database), ensure(shared.database)]);
	assert.equal(shared.ran.filter((sql) => sql.startsWith("select")).length, 1, "one version check for three requests");

	// A check that never settles (its request was cancelled) holds the others up only briefly.
	const hung = d1(new DatabaseSync(":memory:"));
	let stuck = true;
	const real = hung.database.prepare.bind(hung.database);
	(hung.database as unknown as { prepare: typeof real }).prepare = (sql: string) => {
		const statement = real(sql);
		if (stuck && sql.startsWith("select")) {
			stuck = false;
			return { ...statement, bind: () => statement, first: () => new Promise(() => {}) } as unknown as ReturnType<typeof real>;
		}
		return statement;
	};
	const waiting = schemaEnsurer(V1, 50);
	void waiting(hung.database);
	const started = Date.now();
	await waiting(hung.database);
	assert.ok(Date.now() - started < 2_000);
	assert.ok(ddl(hung.ran).length > 0);
});
