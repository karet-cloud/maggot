import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudflareSandbox, CLOUDFLARE_IMAGE, ExecTimeoutError, type ContainerLike } from "../src/ci/sandbox.ts";
import { CHECKOUT_TOKEN_PREFIX, checkoutAllows, mintCheckoutToken, openSecret, sealSecret, verifyCheckoutToken } from "../src/ci/token.ts";

const KEY = "server-api-key";

test("checkout tokens carry their repositories and expire", async () => {
	const token = await mintCheckoutToken(KEY, { repos: ["repo-a"], expires: Date.now() + 60_000 });
	assert.ok(token.startsWith(CHECKOUT_TOKEN_PREFIX));
	const grant = await verifyCheckoutToken(KEY, token);
	assert.deepEqual(grant?.repos, ["repo-a"]);
	assert.ok(checkoutAllows(grant, "repo-a"));
	assert.ok(!checkoutAllows(grant, "repo-b"), "only the repositories named");
	assert.ok(!checkoutAllows(null, "repo-a"));

	const expired = await mintCheckoutToken(KEY, { repos: ["repo-a"], expires: Date.now() - 1 });
	assert.equal(await verifyCheckoutToken(KEY, expired), null);
	assert.ok(!checkoutAllows({ repos: ["repo-a"], expires: Date.now() - 1 }, "repo-a"));
});

test("checkout tokens can't be forged or altered", async () => {
	const token = await mintCheckoutToken(KEY, { repos: ["repo-a"], expires: Date.now() + 60_000 });
	assert.equal(await verifyCheckoutToken("another-key", token), null, "another server's key");
	const [payload, mac] = token.slice(CHECKOUT_TOKEN_PREFIX.length).split(".");
	const widened = btoa(JSON.stringify({ r: ["repo-a", "repo-b"], e: Date.now() + 60_000 })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
	assert.equal(await verifyCheckoutToken(KEY, `${CHECKOUT_TOKEN_PREFIX}${widened}.${mac}`), null, "a widened grant");
	assert.equal(await verifyCheckoutToken(KEY, `${CHECKOUT_TOKEN_PREFIX}${payload}.${mac.slice(0, -2)}AA`), null, "a changed signature");
	for (const junk of ["", "mgci_", "mgci_.", "mgci_abc", "mgci_!!.!!", `mgp_${payload}.${mac}`, token.slice(CHECKOUT_TOKEN_PREFIX.length)]) {
		assert.equal(await verifyCheckoutToken(KEY, junk), null, junk);
	}
});

test("sealed secrets open only for their repository", async () => {
	const sealed = await sealSecret(KEY, "repo-a", "p@ss wörd");
	assert.notEqual(await sealSecret(KEY, "repo-a", "p@ss wörd"), sealed, "a fresh IV each time");
	assert.equal(await openSecret(KEY, "repo-a", sealed), "p@ss wörd");
	await assert.rejects(openSecret(KEY, "repo-b", sealed));
	await assert.rejects(openSecret("another-key", "repo-a", sealed));
	await assert.rejects(openSecret(KEY, "repo-a", "corrupt"), /corrupt/);
});

/** A stand-in for `ctx.container`, as documented: https://developers.cloudflare.com/durable-objects/api/container/ */
class FakeContainer implements ContainerLike {
	running = false;
	images: Record<string, string> = {};
	started: unknown[] = [];
	timeouts: number[] = [];
	destroyed = 0;
	hang = false;
	/** What each command got on stdin, with its arguments and environment. */
	execs: { cmd: string[]; env?: Record<string, string>; stdin: string | null }[] = [];
	/** Every signal handed to exec, and whether any fired after its command had ended (which Cloudflare says crashes the object). */
	signals: AbortSignal[] = [];
	abortedAfterExit = false;
	start(options: Parameters<ContainerLike["start"]>[0]) {
		if (this.running) throw new Error("already running");
		this.started.push(options);
		this.running = true;
	}
	async exec(cmd: string[], options?: { signal?: AbortSignal; env?: Record<string, string>; stdin?: ReadableStream }) {
		if (!this.running) throw new Error("exec() cannot be called on a container that is not running.");
		this.execs.push({ cmd, env: options?.env, stdin: options?.stdin ? await new Response(options.stdin).text() : null });
		const signal = options?.signal;
		if (signal) this.signals.push(signal);
		if (this.hang) {
			await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		}
		const enc = new TextEncoder();
		return {
			output: async () => {
				// From here the process has exited: any abort now is the documented crash.
				signal?.addEventListener("abort", () => (this.abortedAfterExit = true));
				return { exitCode: cmd[0] === "false" ? 1 : 0, stdout: enc.encode(cmd[0] === "cat" ? "file content" : `ran ${cmd.join(" ")}`).buffer as ArrayBuffer, stderr: new ArrayBuffer(0) };
			},
		};
	}
	async destroy() {
		this.running = false;
		this.destroyed++;
	}
	async setInactivityTimeout(ms: number) {
		this.timeouts.push(ms);
	}
}

test("the Cloudflare sandbox starts the container once, keeps it alive and runs commands", async () => {
	const container = new FakeContainer();
	const box = new CloudflareSandbox(container);
	assert.equal(box.image(), CLOUDFLARE_IMAGE);
	container.images = { ci: "registry.cloudflare.com/acct/ci@sha256:abc" };
	assert.equal(box.image(), "registry.cloudflare.com/acct/ci@sha256:abc", "the deployment's CI image wins");
	await assert.rejects(box.exec(["true"]), /not running/);
	box.start();
	box.start();
	assert.equal(container.started.length, 1);
	assert.deepEqual(container.started[0], { image: "registry.cloudflare.com/acct/ci@sha256:abc", instance: "standard-2", entrypoint: ["sleep", "infinity"], enableInternet: true });
	assert.deepEqual(await box.exec(["echo", "hi"]), { exitCode: 0, stdout: "ran echo hi", stderr: "" });
	assert.equal((await box.exec(["false"])).exitCode, 1);
	await box.keepAlive(Date.now() + 10 * 3600_000);
	await box.keepAlive(Date.now());
	assert.deepEqual(container.timeouts, [6 * 3600_000, 60_000], "clamped to Cloudflare's 6 hours, at least a minute");
	container.hang = true;
	await assert.rejects(box.exec(["sleep", "9"], { timeoutMs: 30 }), ExecTimeoutError);
	await box.destroy();
	await box.destroy();
	assert.equal(container.destroyed, 1);
});

test("the Cloudflare sandbox writes files through stdin, never arguments or the environment", async () => {
	const container = new FakeContainer();
	const box = new CloudflareSandbox(container);
	box.start();
	await box.writeFile("/tmp/megit-inbox/step-0.sh", "export TOKEN='s3cret'\n");
	const [write] = container.execs;
	assert.equal(write.stdin, "export TOKEN='s3cret'\n");
	assert.ok(!JSON.stringify(write.cmd).includes("s3cret") && !JSON.stringify(write.env ?? {}).includes("s3cret"));
	assert.equal(write.cmd.at(-1), "/tmp/megit-inbox/step-0.sh");
	assert.match(write.cmd[2], /umask 077/);
});

test("a Cloudflare command's time limit is cleared once it ends, so its signal never aborts afterwards", async () => {
	const container = new FakeContainer();
	const box = new CloudflareSandbox(container);
	box.start();
	await box.exec(["true"], { timeoutMs: 30 });
	await box.writeFile("/tmp/x", "y");
	assert.equal(await box.readFile("/tmp/x"), "file content");
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(container.abortedAfterExit, false);
	assert.ok(container.signals.every((s) => !s.aborted), "no signal fired after its command");
	assert.ok(container.signals.every((s) => s.constructor === AbortSignal), "an AbortController's signal");
});
