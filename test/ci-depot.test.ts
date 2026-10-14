import assert from "node:assert/strict";
import { test } from "node:test";
import { DepotApi, DepotError, DepotSandbox } from "../src/ci/depot.ts";
import { DepotMachine, newJobState, type JobLaunch } from "../src/ci/runner.ts";
import { ExecTimeoutError } from "../src/ci/sandbox.ts";
import { JobRunner, type JobReport } from "../src/ci/runner.ts";
import { LocalSandbox } from "./ci-local.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVICE = "https://api.depot.dev/depot.sandbox.v1.SandboxService/";

interface Call {
	method: string;
	headers: Headers;
	/** A unary request, or a stream's first message. */
	body: unknown;
	/** Every message of a streaming request. */
	frames: unknown[];
	raw: string;
}

/** One Connect stream message (flags, big-endian length, JSON). */
function frame(message: unknown, flags = 0): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify(message));
	const out = new Uint8Array(5 + json.length);
	out[0] = flags;
	new DataView(out.buffer).setUint32(1, json.length);
	out.set(json, 5);
	return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(c);
			controller.close();
		},
	});
}

/** Splits bytes at every `size`, so frames arrive cut in awkward places. */
function shred(bytes: Uint8Array, size: number): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
	return out;
}

const concat = (parts: Uint8Array[]) => {
	const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		all.set(p, at);
		at += p.length;
	}
	return all;
};

/** Decodes every message of an enveloped request body. */
function unframeAll(bytes: Uint8Array): unknown[] {
	const out: unknown[] = [];
	for (let at = 0; at < bytes.length; ) {
		assert.equal(bytes[at], 0, "request messages have no flags");
		const length = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(1);
		out.push(JSON.parse(new TextDecoder().decode(bytes.subarray(at + 5, at + 5 + length))));
		at += 5 + length;
	}
	return out;
}

function mockDepot(handlers: Record<string, (body: any, call: Call) => Response | Promise<Response>>) {
	const calls: Call[] = [];
	const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		assert.ok(url.startsWith(SERVICE), url);
		const method = url.slice(SERVICE.length);
		const headers = new Headers(init?.headers);
		const raw = init?.body;
		const frames = raw instanceof Uint8Array ? unframeAll(raw) : [JSON.parse(String(raw))];
		const call = { method, headers, body: frames[0], frames, raw: raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw) };
		calls.push(call);
		const handler = handlers[method];
		if (!handler) return Response.json({ code: "unimplemented", message: method }, { status: 404 });
		return handler(frames[0], call);
	}) as typeof globalThis.fetch;
	return { fetch: mock, calls };
}

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

test("requests carry the token, the organization and Connect's headers", async () => {
	const { fetch, calls } = mockDepot({ ListSandboxes: () => Response.json({ sandboxes: [] }) });
	await new DepotApi({ token: "dpt_x", orgId: "org123" }, { fetch }).check();
	const { headers, body } = calls[0];
	assert.equal(headers.get("authorization"), "Bearer dpt_x");
	assert.equal(headers.get("x-depot-org"), "org123");
	assert.equal(headers.get("connect-protocol-version"), "1");
	assert.equal(headers.get("content-type"), "application/json");
	assert.deepEqual(body, { pageSize: 1 });
	// A user token in one organization needs no org header.
	const plain = mockDepot({ ListSandboxes: () => Response.json({}) });
	await new DepotApi({ token: "t" }, { fetch: plain.fetch }).check();
	assert.equal(plain.calls[0].headers.get("x-depot-org"), null);
});

test("Connect errors become DepotErrors that say whether to retry", async () => {
	const { fetch } = mockDepot({
		ListSandboxes: () => Response.json({ code: "unauthenticated", message: "bad token" }, { status: 401 }),
		GetSandbox: () => Response.json({ code: "unavailable", message: "try later" }, { status: 503 }),
		KillSandbox: () => Response.json({ code: "failed_precondition", message: "already stopped" }, { status: 400 }),
		StopSandbox: () => new Response("<html>bad gateway</html>", { status: 502 }),
	});
	const api = new DepotApi({ token: "t" }, { fetch });
	await assert.rejects(api.check(), (e: unknown) => e instanceof DepotError && e.code === "unauthenticated" && !e.transient && e.message === "bad token");
	await assert.rejects(api.get("sb1"), (e: unknown) => e instanceof DepotError && e.transient);
	await api.kill("sb1"); // already stopped is fine
	await assert.rejects(api.unary("StopSandbox", {}), (e: unknown) => e instanceof DepotError && e.code === "http_502" && e.transient);
	const down = new DepotApi({ token: "t" }, { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
	await assert.rejects(down.check(), (e: unknown) => e instanceof DepotError && e.code === "unavailable" && e.transient);
});

test("create asks for the resources and lifetime, and reads the sandbox back", async () => {
	const { fetch, calls } = mockDepot({
		CreateSandbox: () => Response.json({ sandbox: { sandboxId: "sb1", name: "megit-j", status: "SANDBOX_STATUS_CREATED" } }),
		GetSandbox: () => Response.json({ sandbox: { sandboxId: "sb1", status: "SANDBOX_STATUS_RUNNING" } }),
	});
	const api = new DepotApi({ token: "t" }, { fetch });
	const created = await api.create({ name: "megit-j", vcpus: 4, timeoutMinutes: 45.5 });
	assert.deepEqual(created, { id: "sb1", name: "megit-j", status: "created", errorMessage: null });
	assert.deepEqual(calls[0].body, { name: "megit-j", resources: { vcpus: 4, memoryMb: 8192, diskGb: 100 }, env: {}, timeoutMinutes: 46, disableTailnet: true });
	assert.equal((await api.get("sb1")).status, "running");
	assert.deepEqual(calls[1].body, { id: "sb1" });
	await assert.rejects(api.create({ name: "x", vcpus: 3, timeoutMinutes: 1 }), /2, 4, 8/);
});

test("RunCommand streams are read across awkward chunk boundaries", async () => {
	const text = "héllo wörld 🎉\n".repeat(50);
	const bytes = new TextEncoder().encode(text);
	const messages = [
		frame({ started: { cmdId: "c1" } }),
		frame({ stdout: { data: b64(new TextDecoder().decode(bytes.slice(0, 7)) ), byteOffset: "0" } }),
		frame({ stderr: { data: b64("warning\n") } }),
		frame({ stdout: { data: btoa(String.fromCharCode(...bytes.slice(7))) } }),
		frame({ finished: {} }),
		frame({}, 0x02),
	];
	for (const size of [1, 3, 7, 1000]) {
		const { fetch, calls } = mockDepot({ RunCommand: () => new Response(streamOf(shred(concat(messages), size)), { headers: { "content-type": "application/connect+json" } }) });
		const box = new DepotSandbox(new DepotApi({ token: "t" }, { fetch }), "sb1");
		const result = await box.exec(["sh", "-c", "echo hi"], { env: { A: "1" }, root: true });
		assert.equal(result.exitCode, 0, "a missing exit code in Finished is 0 (proto3 leaves zeros out)");
		assert.equal(result.stdout, text);
		assert.equal(result.stderr, "warning\n");
		assert.equal(calls[0].headers.get("content-type"), "application/connect+json");
		assert.deepEqual(calls[0].body, { sandbox: { id: "sb1" }, cmd: "sh", args: ["-c", "echo hi"], env: { A: "1" }, sudo: true });
	}
});

test("RunCommand failures: end-of-stream errors, Error events, cut streams, dropped output", async () => {
	const run = (chunks: Uint8Array[]) => {
		const { fetch } = mockDepot({ RunCommand: () => new Response(streamOf(chunks)) });
		return new DepotSandbox(new DepotApi({ token: "t" }, { fetch }), "sb1").exec(["true"]);
	};
	await assert.rejects(run([frame({ started: {} }), frame({ error: { code: "not_found", message: "no such sandbox" } }, 0x02)]), (e: unknown) => e instanceof DepotError && e.code === "not_found");
	await assert.rejects(run([frame({ error: { reason: "exec failed" } }), frame({}, 0x02)]), /exec failed/);
	await assert.rejects(run([frame({ started: {} })]), (e: unknown) => e instanceof DepotError && e.transient);
	await assert.rejects(run([frame({ started: {} }), frame({ finished: { exitCode: 1 } }).slice(0, 4)]), (e: unknown) => e instanceof DepotError && e.transient);
	await assert.rejects(run([frame({ evicted: { droppedBytesStdout: "10" } }), frame({ finished: { exitCode: 0 } }), frame({}, 0x02)]), /dropped 10 bytes/);
	await assert.rejects(run([frame({ started: {} }), frame({}, 0x02)]), /without an exit code/);
	assert.equal((await run([frame({ finished: { exitCode: 7 } }), frame({}, 0x02)])).exitCode, 7);
});

test("a command that outlasts its time limit is a timeout", async () => {
	const fetch = ((_: unknown, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
		})) as typeof globalThis.fetch;
	const box = new DepotSandbox(new DepotApi({ token: "t" }, { fetch }), "sb1");
	await assert.rejects(box.exec(["sleep", "9"], { timeoutMs: 50 }), (e: unknown) => e instanceof DepotError && e.code === "deadline_exceeded");
	// A stream that stops sending is cut off by the same limit (fetch errors the body when the signal aborts).
	const stalls = (async (_: unknown, init?: RequestInit) =>
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(frame({ started: {} }));
					init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
				},
			}),
		)) as typeof globalThis.fetch;
	const slow = new DepotSandbox(new DepotApi({ token: "t" }, { fetch: stalls }), "sb1");
	await assert.rejects(slow.exec(["sleep", "9"], { timeoutMs: 50 }), (e: unknown) => e instanceof ExecTimeoutError);
});

const launch = { jobId: "j1", timeoutMinutes: 10 } as JobLaunch;

test("the Depot machine creates once, finds its sandbox again after a restart, and waits for it to run", async () => {
	let status = "SANDBOX_STATUS_STARTING";
	const { fetch, calls } = mockDepot({
		CreateSandbox: () => Response.json({ sandbox: { sandboxId: "sb1", name: "megit-j1", status: "SANDBOX_STATUS_CREATED" } }),
		GetSandbox: (body) => Response.json({ sandbox: { sandboxId: body.id, status } }),
		KillSandbox: () => Response.json({ sandbox: { sandboxId: "sb1", status: "SANDBOX_STATUS_CANCELLED" } }),
	});
	const machine = new DepotMachine({ token: "t" }, 2, { fetch });
	const state = newJobState({ ...launch, steps: [], checkout: { url: "", auth: "", ref: "", sha: "" } } as JobLaunch);
	let saves = 0;
	assert.equal(await machine.provision(state, launch, async () => void saves++), false);
	assert.equal(state.sandboxId, "sb1");
	assert.equal(saves, 1, "the id is saved as soon as it's known");
	const create = calls.find((c) => c.method === "CreateSandbox")!.body as { name: string; timeoutMinutes: number };
	assert.equal(create.name, "megit-j1");
	assert.ok(create.timeoutMinutes >= 25 && create.timeoutMinutes <= 26, "the job's limit plus a margin");
	status = "SANDBOX_STATUS_RUNNING";
	assert.equal(await machine.provision(state, launch, async () => {}), true);
	assert.equal(calls.filter((c) => c.method === "CreateSandbox").length, 1);
	await machine.destroy(state);
	assert.deepEqual(calls.at(-1)!.body, { sandbox: { id: "sb1" } });

	// A restart lost the create's answer: the name is taken, so the sandbox is found by it.
	const again = mockDepot({
		CreateSandbox: () => Response.json({ code: "already_exists", message: "name taken" }, { status: 409 }),
		ListSandboxes: (body) =>
			Response.json(
				body.pageToken
					? { sandboxes: [{ sandboxId: "sb9", name: "megit-j1", status: "SANDBOX_STATUS_RUNNING" }] }
					: { sandboxes: [{ sandboxId: "old", name: "megit-j1", status: "SANDBOX_STATUS_FINISHED" }, { sandboxId: "x", name: "other", status: 4 }], nextPageToken: "p2" },
			),
		GetSandbox: (body) => Response.json({ sandbox: { sandboxId: body.id, status: "SANDBOX_STATUS_RUNNING" } }),
	});
	const restarted = newJobState({ ...launch, steps: [], checkout: { url: "", auth: "", ref: "", sha: "" } } as JobLaunch);
	assert.equal(await new DepotMachine({ token: "t" }, 2, { fetch: again.fetch }).provision(restarted, launch, async () => {}), true);
	assert.equal(restarted.sandboxId, "sb9");

	// A sandbox that failed to start fails the job with Depot's reason.
	const failed = mockDepot({
		CreateSandbox: () => Response.json({ sandbox: { sandboxId: "sb2", status: "SANDBOX_STATUS_CREATED" } }),
		GetSandbox: () => Response.json({ sandbox: { sandboxId: "sb2", status: "SANDBOX_STATUS_FAILED", errorMessage: "no capacity" } }),
	});
	const s3 = newJobState({ ...launch, steps: [], checkout: { url: "", auth: "", ref: "", sha: "" } } as JobLaunch);
	await assert.rejects(new DepotMachine({ token: "t" }, 2, { fetch: failed.fetch }).provision(s3, launch, async () => {}), /no capacity/);
});

test("WriteFile is a client stream: Init, then the bytes in chunks, checked against the count written", async () => {
	const content = `${"x".repeat(300 * 1024)}é`;
	let received = "";
	const { fetch, calls } = mockDepot({
		WriteFile: (_, call) => {
			const bytes = call.frames.slice(1).map((f: any) => Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)));
			received = new TextDecoder().decode(concat(bytes));
			return new Response(streamOf([frame({ bytesWritten: String(concat(bytes).length) }), frame({}, 0x02)]));
		},
	});
	const api = new DepotApi({ token: "t" }, { fetch });
	await api.writeFile("sb1", "/tmp/megit-inbox/step-0.sh", content);
	assert.equal(received, content);
	const call = calls[0];
	assert.equal(call.headers.get("content-type"), "application/connect+json");
	assert.deepEqual(call.frames[0], { init: { sandbox: { id: "sb1" }, path: "/tmp/megit-inbox/step-0.sh", mode: 0o600, createDirectories: true } });
	assert.equal(call.frames.length, 3, "two data chunks");
	// A short write is an error worth retrying.
	const short = mockDepot({ WriteFile: () => new Response(streamOf([frame({ bytesWritten: "1" }), frame({}, 0x02)])) });
	await assert.rejects(new DepotApi({ token: "t" }, { fetch: short.fetch }).writeFile("sb1", "/x", "hello"), (e: unknown) => e instanceof DepotError && e.transient);
});

test("a detached command returns once Depot says it started", async () => {
	const { fetch, calls } = mockDepot({ RunCommand: () => new Response(streamOf([frame({ started: { cmdId: "c" } }), frame({}, 0x02)])) });
	const result = await new DepotSandbox(new DepotApi({ token: "t" }, { fetch }), "sb1").exec(["sh", "-c", "x"], { detached: true });
	assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
	assert.equal((calls[0].body as { detached?: boolean }).detached, true);
	await assert.rejects(new DepotSandbox(new DepotApi({ token: "t" }, { fetch: mockDepot({ RunCommand: () => new Response(streamOf([frame({}, 0x02)])) }).fetch }), "sb1").exec(["x"], { detached: true }), /without starting it/);
});

/** A Depot API whose sandbox is this machine (a LocalSandbox), speaking Connect like the real one. */
function localDepot(box: LocalSandbox) {
	const enc = new TextEncoder();
	/** What every command printed: what Depot would keep in its command history. */
	const outputs: string[] = [];
	const depot = mockDepot({
		ReadFile: async (body: { path: string }) => {
			const content = enc.encode(await box.readFile(body.path));
			return new Response(streamOf([frame({ data: btoa(String.fromCharCode(...content)) }), frame({ eof: true }), frame({}, 0x02)]));
		},
		CreateSandbox: () => Response.json({ sandbox: { sandboxId: "sb1", name: "megit-j1", status: "SANDBOX_STATUS_CREATED" } }),
		GetSandbox: () => Response.json({ sandbox: { sandboxId: "sb1", status: "SANDBOX_STATUS_RUNNING" } }),
		KillSandbox: () => Response.json({ sandbox: { sandboxId: "sb1", status: "SANDBOX_STATUS_CANCELLED" } }),
		WriteFile: async (_, call) => {
			const init = (call.frames[0] as { init: { path: string } }).init;
			const bytes = concat(call.frames.slice(1).map((f: any) => Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))));
			await box.writeFile(init.path, new TextDecoder().decode(bytes));
			return new Response(streamOf([frame({ bytesWritten: String(bytes.length) }), frame({}, 0x02)]));
		},
		RunCommand: async (body: { cmd: string; args: string[]; env: Record<string, string>; detached?: boolean }) => {
			const result = await box.exec([body.cmd, ...body.args], { env: body.env, detached: body.detached, root: (body as { sudo?: boolean }).sudo === true });
			outputs.push(result.stdout + result.stderr);
			if (body.detached) return new Response(streamOf([frame({ started: {} }), frame({}, 0x02)]));
			const b64 = (t: string) => btoa(String.fromCharCode(...enc.encode(t)));
			return new Response(streamOf([frame({ started: {} }), ...(result.stdout ? [frame({ stdout: { data: b64(result.stdout) } })] : []), ...(result.stderr ? [frame({ stderr: { data: b64(result.stderr) } })] : []), frame({ finished: { exitCode: result.exitCode } }), frame({}, 0x02)]));
		},
	});
	return { ...depot, outputs };
}

test("a Depot job never puts secrets or the checkout token in a command's environment or arguments", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mgci-repo-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
	git("init", "-q", "-b", "master");
	writeFileSync(join(dir, "f"), "x");
	git("add", ".");
	git("commit", "-q", "-m", "c");
	const SECRET = "repo-secret-value-9876";
	const TOKEN = "mgci_payload.sig";
	const AUTH = btoa(`x:${TOKEN}`);
	const box = new LocalSandbox();
	box.asyncDetached = true;
	const { fetch, calls, outputs } = localDepot(box);
	const launch: JobLaunch = {
		jobId: "j1",
		repo: "r",
		runner: { kind: "depot", vcpus: 2, credentials: { token: "dpt" } },
		timeoutMinutes: 5,
		steps: [
			{ name: "Use", run: `echo "len=\${#API_KEY}"; echo "$API_KEY"; echo "TOK=$API_KEY" >> "$GITHUB_ENV"`, shell: "bash", workingDirectory: null, env: { STEP_SECRET: SECRET }, if: "success", continueOnError: false, timeoutMinutes: null },
			{ name: "Next", run: `echo "tok-len=\${#TOK}"`, shell: "bash", workingDirectory: null, env: {}, if: "success", continueOnError: false, timeoutMinutes: null },
		],
		env: { API_KEY: SECRET },
		mask: [SECRET],
		checkout: { url: `file://${dir}`, auth: AUTH, ref: "refs/heads/master", sha: git("rev-parse", "HEAD") },
	};
	const runner = new JobRunner(launch, newJobState(launch), new DepotMachine({ token: "dpt" }, 2, { fetch }));
	const reports: JobReport[] = [];
	// Generous: it stops once the job settles, and a loaded machine needs more ticks.
	for (let i = 0; i < 1500 && !runner.settled; i++) {
		await runner.tick();
		const r = runner.nextReport(1 << 20);
		reports.push(r);
		runner.acked(r);
		await new Promise((res) => setTimeout(res, 20));
	}
	assert.equal(reports.at(-1)!.conclusion, "success");
	const log = reports.flatMap((r) => r.logs.map((l) => l.text)).join("");
	assert.match(log, /len=22/);
	assert.ok(!log.includes(SECRET), "masked in the log");
	const writes = calls.filter((c) => c.method === "WriteFile" && (c.body as { init: { path: string } }).init.path.endsWith(".sh"));
	assert.equal(writes.length, 3, "the checkout's file and the two steps'");
	assert.ok(calls.some((c) => c.method === "ReadFile" && (c.body as { path: string }).path.endsWith("collect-0.env")), "$GITHUB_ENV came back by ReadFile");
	assert.match(log, new RegExp(`tok-len=${SECRET.length}`));
	// What Depot would keep of each command's output: no secret, plain or base64 (checking every line as base64).
	const decoded = (text: string) => text.split("\n").map((l) => { try { return atob(l.trim()); } catch { return ""; } }).join("\n");
	for (const out of outputs) {
		for (const needle of [SECRET, TOKEN, AUTH, btoa(`TOK=${SECRET}\n`)]) {
			assert.ok(!out.includes(needle) && !decoded(out).includes(needle), `a command printed ${needle}: ${out.slice(0, 120)}`);
		}
	}
	const written = writes.map((c) => new TextDecoder().decode(concat(c.frames.slice(1).map((f: any) => Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0))))));
	assert.ok(written[0].includes(AUTH) && written[1].includes(SECRET), "they travel in files");
	for (const c of calls) {
		if (c.method === "WriteFile") continue;
		for (const needle of [SECRET, TOKEN, AUTH]) assert.ok(!c.raw.includes(needle), `${c.method} request carries ${needle}`);
	}
	const runs = calls.filter((c) => c.method === "RunCommand").map((c) => c.body as { env: Record<string, string>; detached?: boolean; args: string[]; sudo?: boolean });
	for (const r of runs) assert.ok(Object.keys(r.env).every((k) => ["MEGIT_ID", "MEGIT_ATTEMPT", "MEGIT_AS_USER", "MEGIT_INTERPRETER", "MEGIT_OFFSET", "MEGIT_MAX", "MEGIT_SIGNAL"].includes(k)), JSON.stringify(r.env));
	assert.equal(runs.filter((r) => r.detached).length, 3, "every launch detached");
	assert.ok(runs.every((r) => r.sudo === true), "control commands run as root");
	assert.ok(calls.some((c) => c.method === "KillSandbox"), "the sandbox was stopped");
	// The log on the machine is masked already, so the polls that read it (whose output Depot may keep) never carry the secret.
	const onMachine = execFileSync("cat", [join(box.state, "step-0.log")]).toString();
	assert.match(onMachine, /^\*\*\*$/m);
	// The checkout's token was in the checkout's mask only; the step's mask held just its own secret.
	const masks = calls.filter((c) => c.method === "WriteFile" && (c.body as { init: { path: string } }).init.path.endsWith(".mask"));
	const maskText = masks.map((c) => new TextDecoder().decode(concat(c.frames.slice(1).map((f: any) => Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0))))));
	assert.ok(maskText[0].includes(TOKEN) && !maskText[0].includes(SECRET), "the checkout's mask");
	assert.ok(maskText.slice(1).every((m) => !m.includes(TOKEN) && !m.includes(AUTH)), "no step mask holds the token");
	assert.ok(!onMachine.includes(SECRET));
});

test("ReadFile streams a file's chunks back, refusing one that's too large", async () => {
	const { fetch, calls } = mockDepot({ ReadFile: () => new Response(streamOf([frame({ data: btoa("TOK=") }), frame({ data: btoa("abc\n") }), frame({ eof: true }), frame({}, 0x02)])) });
	const box = new DepotSandbox(new DepotApi({ token: "t" }, { fetch }), "sb1");
	assert.equal(await box.readFile("/tmp/megit-user/collect-0.env"), "TOK=abc\n");
	assert.deepEqual(calls[0].body, { sandbox: { id: "sb1" }, path: "/tmp/megit-user/collect-0.env" });
	assert.equal(calls[0].headers.get("content-type"), "application/connect+json");
	const big = mockDepot({ ReadFile: () => new Response(streamOf([frame({ data: btoa("x".repeat(20)) }), frame({}, 0x02)])) });
	await assert.rejects(new DepotApi({ token: "t" }, { fetch: big.fetch }).readFile("sb1", "/x", 10), /larger than 10 bytes/);
	const missing = mockDepot({ ReadFile: () => new Response(streamOf([frame({ error: { code: "not_found", message: "no such file" } }, 0x02)])) });
	await assert.rejects(new DepotApi({ token: "t" }, { fetch: missing.fetch }).readFile("sb1", "/x"), (e: unknown) => e instanceof DepotError && e.code === "not_found");
});
