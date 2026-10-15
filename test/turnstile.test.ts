import assert from "node:assert/strict";
import { test } from "node:test";
import { turnstileSiteKey, verifyTurnstile, type TurnstileEnv } from "../src/turnstile.ts";

const on: TurnstileEnv = { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
const status = (err: unknown) => (err as { status?: number }).status;

test("Turnstile is off without both keys, and then lets anything through", async () => {
	assert.equal(turnstileSiteKey({ TURNSTILE_SITE_KEY: "site" }), null);
	assert.equal(turnstileSiteKey(on), "site");
	await verifyTurnstile({}, undefined, "sign-up", "local", answer({ success: false }));
});

test("a token passes only when siteverify accepts it for the same action", async () => {
	let sent: FormData | null = null;
	const fetcher = (async (_url: string, init: RequestInit) => {
		sent = init.body as FormData;
		return new Response(JSON.stringify({ success: true, action: "sign-up" }));
	}) as unknown as typeof fetch;
	await verifyTurnstile(on, "token", "sign-up", "198.51.100.7", fetcher);
	assert.equal(sent!.get("secret"), "secret");
	assert.equal(sent!.get("remoteip"), "198.51.100.7");
	await assert.rejects(verifyTurnstile(on, "token", "waitlist", "local", answer({ success: true, action: "sign-up" })), (err) => status(err) === 403);
	await assert.rejects(verifyTurnstile(on, "token", "sign-up", "local", answer({ success: false })), (err) => status(err) === 403);
	await assert.rejects(verifyTurnstile(on, undefined, "sign-up", "local", answer({ success: true, action: "sign-up" })), (err) => status(err) === 403);
	const down = (async () => {
		throw new Error("offline");
	}) as unknown as typeof fetch;
	await assert.rejects(verifyTurnstile(on, "token", "sign-up", "local", down), (err) => status(err) === 503);
});
