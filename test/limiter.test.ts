// The Limiter's counters, refunds and holds, on node:sqlite standing in for its storage.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { sqlStorage } from "./sql.ts";

const workers = `data:text/javascript,${encodeURIComponent(`
export class DurableObject {
	constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}`)}`;
const hooks = registerHooks({
	resolve(specifier, context, next) {
		return specifier === "cloudflare:workers" ? { url: workers, shortCircuit: true } : next(specifier, context);
	},
});
const { Limiter } = await import("../src/policy.ts");
hooks.deregister();

function limiter() {
	let alarm: number | null = null;
	const storage = {
		sql: sqlStorage(new DatabaseSync(":memory:")),
		getAlarm: async () => alarm,
		setAlarm: async (at: number) => void (alarm = at),
	};
	return new Limiter({ storage } as unknown as DurableObjectState, {} as Env);
}

test("a refund gives back one count in the current window, and never goes below zero", async () => {
	const l = limiter();
	const rules = [{ name: "sign-up", limit: 2, windowSeconds: 3600 }];
	assert.ok((await l.take(rules)).ok);
	assert.ok((await l.take(rules)).ok);
	assert.equal((await l.take(rules)).ok, false);
	await l.give(rules);
	assert.ok((await l.take(rules)).ok);
	await l.give(rules);
	await l.give(rules);
	await l.give(rules);
	assert.ok((await l.take(rules)).ok);
	assert.ok((await l.take(rules)).ok);
	assert.equal((await l.take(rules)).ok, false);
});

test("holds share the places left, are freed on release, and expire", async () => {
	const l = limiter();
	// 98 of 100 places are settled: two holds fit, a third doesn't.
	const a = await l.hold(98, 100, 60_000);
	const b = await l.hold(98, 100, 60_000);
	assert.ok(a && b);
	assert.equal(await l.hold(98, 100, 60_000), null);
	await l.release(a);
	assert.ok(await l.hold(98, 100, 60_000));
	// An account that settled counts in `current` instead of as a hold.
	assert.equal(await l.hold(100, 100, 60_000), null);
	// Expired holds don't count.
	const m = limiter();
	assert.ok(await m.hold(99, 100, -1));
	assert.ok(await m.hold(99, 100, 60_000));
});
