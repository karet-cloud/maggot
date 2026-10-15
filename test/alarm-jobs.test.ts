// Persistent alarm scheduling against SQLite. An interrupted alarm stops running JavaScript while a
// job awaits I/O: its retry gets a fresh scheduler over the same stored queue and due time.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { JobSchedule } from "../src/alarm-jobs.ts";
import type { Sql } from "../src/search.ts";

function storage(db: DatabaseSync): Sql {
	return {
		exec(query: string, ...params: unknown[]) {
			const rows = db.prepare(query).all(...params as never[]);
			return { toArray: () => rows, one: () => rows[0] };
		},
	} as Sql;
}

function setup() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const sql = storage(db);
	return { db, sql, jobs: new JobSchedule(sql) };
}

test("an alarm interrupted mid-merge leaves jobs due, and its retry drains merging and queued tasks", async () => {
	const { db, sql, jobs } = setup();
	using database = db;
	db.exec("CREATE TABLE queue (seq INTEGER PRIMARY KEY, status TEXT); INSERT INTO queue VALUES (1, 'queued'), (2, 'queued')");
	jobs.want(100);
	let started!: () => void;
	const merging = new Promise<void>((resolve) => { started = resolve; });
	// Leave the old alarm suspended forever, modelling eviction during a remote merge operation.
	void jobs.run(100, async () => {
		db.exec("UPDATE queue SET status = 'merging' WHERE seq = 1");
		started();
		await new Promise<void>(() => {});
	});
	await merging;
	assert.equal(jobs.due(), 100, "starting the jobs must not mark them finished");
	const retry = new JobSchedule(sql);
	const drained: string[] = [];
	assert.equal(await retry.run(101, async () => {
		for (const row of db.prepare("SELECT seq, status FROM queue ORDER BY seq").all()) {
			drained.push(String(row.status));
			db.prepare("DELETE FROM queue WHERE seq = ?").run(row.seq);
		}
	}), true);
	assert.deepEqual(drained, ["merging", "queued"]);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM queue").get()?.n, 0);
	assert.equal(retry.due(), Number.MAX_SAFE_INTEGER);
});

test("a rejected alarm leaves its jobs due for a fresh instance", async () => {
	const { db, sql, jobs } = setup();
	using database = db;
	await assert.rejects(jobs.run(100, async () => { throw new Error("interrupted"); }), /interrupted/);
	assert.equal(await new JobSchedule(sql).run(101, async () => {}), true);
});

test("requests during a running job aren't erased when that job finishes", async () => {
	const { db, jobs } = setup();
	using database = db;
	jobs.want(100);
	await jobs.run(100, async () => { jobs.want(200); });
	assert.equal(jobs.due(), 100, "even a later request than the due job must survive completion");
	assert.equal(await jobs.run(201, async () => {}), true);
	assert.equal(jobs.due(), Number.MAX_SAFE_INTEGER);
	jobs.want(300);
	assert.equal(await jobs.run(299, async () => { assert.fail("index-only wake-up ran jobs early"); }), false);
	assert.equal(await jobs.run(300, async () => {}), true);
});
