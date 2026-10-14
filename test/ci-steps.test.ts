// Steps as jobs run them, on this machine (LocalSandbox): expressions filled in as each step starts,
// outputs and hashFiles, actions in the repository (composite and JavaScript, with pre and post steps),
// and caches and artifacts through megit's job API (src/ci/job-api.ts) to an in-memory R2.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { parseActionMeta } from "../src/ci/actions.ts";
import jobApi from "../src/ci/job-api.ts";
import { buildPlan, type ResolvedAction } from "../src/ci/plan.ts";
import { JobRunner, newJobState, type JobLaunch, type JobReport, type JobState, type Machine } from "../src/ci/runner.ts";
import type { Sandbox } from "../src/ci/sandbox.ts";
import { WORKSPACE } from "../src/ci/script.ts";
import { CiStorage } from "../src/ci/storage.ts";
import { mintJobToken, type JobGrant } from "../src/ci/token.ts";
import { compositeSteps, type StepSpec } from "../src/ci/workflow.ts";
import { LocalSandbox } from "./ci-local.ts";
import { sqlStorage } from "./sql.ts";

const API_KEY = "steps-test-key";

const step = (name: string, extra: Partial<StepSpec> = {}): StepSpec => ({
	kind: "run",
	id: null,
	name,
	run: "true",
	uses: null,
	with: {},
	shell: "bash",
	workingDirectory: null,
	env: {},
	if: "success()",
	continueOnError: false,
	timeoutMinutes: null,
	...extra,
});

/** A repository with `files` in one commit, cloneable over file://. */
function repository(files: Record<string, string>): { url: string; sha: string; dir: string } {
	const dir = execFileSync("mktemp", ["-d", join(tmpdir(), "mgci-steps-XXXXXX")]).toString().trim();
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
	git("init", "-q", "-b", "master");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	git("add", ".");
	git("commit", "-q", "-m", "first");
	return { url: `file://${dir}`, sha: git("rev-parse", "HEAD"), dir };
}

class LocalMachine implements Machine {
	readonly box: LocalSandbox;
	constructor(box: LocalSandbox) {
		this.box = box;
	}
	describe() {
		return "this machine";
	}
	async provision() {
		return true;
	}
	sandbox(): Sandbox {
		return this.box;
	}
	async alive() {
		return true;
	}
	async destroy() {}
}

function launchFor(o: { repo: { url: string; sha: string }; steps: StepSpec[]; actions?: (ResolvedAction | null)[]; outputs?: Record<string, string>; api?: { url: string; token: string } }): JobLaunch {
	return {
		jobId: "job-1",
		repo: "repo-1",
		runner: { kind: "cloudflare" },
		timeoutMinutes: 5,
		plan: buildPlan(o.steps, o.actions ?? o.steps.map(() => null)),
		env: { CI: "true", GITHUB_SHA: o.repo.sha, GITHUB_WORKSPACE: WORKSPACE, GITHUB_SERVER_URL: "https://megit.test", GITHUB_REPOSITORY: "alice/app", GITHUB_RUN_ID: "7" },
		contexts: { github: { sha: o.repo.sha, ref: "refs/heads/master", event_name: "push" }, matrix: { node: 22 }, needs: {}, strategy: {}, inputs: {} },
		secrets: {},
		outputs: o.outputs ?? {},
		mask: [],
		checkout: { url: o.repo.url, auth: btoa("x:mgci_checkout"), ref: "refs/heads/master", sha: o.repo.sha, depth: 50 },
		api: o.api ?? { url: "http://127.0.0.1:1", token: "mgjob_unused" },
	};
}

/** Runs a job to the end, returning its reports and its log by shown step. */
async function run(launch: JobLaunch, box = new LocalSandbox()): Promise<{ state: JobState; reports: JobReport[]; logs: Map<number, string>; box: LocalSandbox }> {
	const state = newJobState(launch);
	const runner = new JobRunner(launch, state, new LocalMachine(box));
	const reports: JobReport[] = [];
	for (let i = 0; i < 2000 && !runner.settled; i++) {
		await runner.tick();
		const r = runner.nextReport(1 << 20);
		reports.push(r);
		runner.acked(r);
		await new Promise((res) => setTimeout(res, 10));
	}
	const logs = new Map<number, string>();
	for (const r of reports) for (const l of r.logs) logs.set(l.step, (logs.get(l.step) ?? "") + l.text);
	return { state, reports, logs, box };
}

const shown = (r: JobReport) => r.steps.map((s) => `${s.name}: ${s.conclusion}`);

test("expressions are filled in as each step starts: outputs, outcomes, conditions, hashFiles and the job's outputs", async () => {
	const repo = repository({ "hello.txt": "hello\n", "nested/hello.txt": "again\n" });
	const launch = launchFor({
		repo,
		steps: [
			step("Check out", { kind: "checkout", run: null }),
			step("Set outputs", { id: "a", run: 'echo "dir=out" >> "$GITHUB_OUTPUT"; printf "multi<<EOF\\nline1\\nline2\\nEOF\\n" >> "$GITHUB_OUTPUT"' }),
			step("Uses ${{ steps.a.outputs.dir }}", { run: 'echo "got ${{ steps.a.outputs.dir }} at ${{ github.sha }} on node ${{ matrix.node }}"', if: "steps.a.outputs.dir == 'out'" }),
			step("Never", { run: "echo never", if: "steps.a.outputs.dir == 'nope'" }),
			step("Hash", { run: "echo \"hash=${{ hashFiles('**/hello.txt', '!nested/**') }}\"" }),
			step("Fails", { id: "f", run: "exit 3", continueOnError: true }),
			step("After", { run: 'echo "outcome=${{ steps.f.outcome }} conclusion=${{ steps.f.conclusion }} job=${{ job.status }}"', if: "steps.f.outcome == 'failure'" }),
			step("Bad expression", { run: "echo ${{ fromJSON('nope') }}", continueOnError: true }),
			step("Skipped first", { run: "echo ${{ hashFiles(fromJSON('nope')) }}", if: "false" }),
		],
		outputs: { d: "${{ steps.a.outputs.dir }}", m: "${{ steps.a.outputs.multi }}" },
	});
	const { reports, logs } = await run(launch);
	const final = reports.at(-1)!;
	assert.equal(final.conclusion, "success");
	assert.deepEqual(shown(final), [
		"Set up job: success",
		"Check out: success",
		"Set outputs: success",
		"Uses out: success",
		"Never: skipped",
		"Hash: success",
		"Fails: success",
		"After: success",
		"Bad expression: success",
		"Skipped first: skipped",
		"Complete job: success",
	]);
	assert.match(logs.get(3)!, new RegExp(`got out at ${repo.sha} on node 22`));
	// GitHub's algorithm: each file's SHA-256 digest (bytes), hashed together.
	const expected = createHash("sha256").update(createHash("sha256").update(readFileSync(join(repo.dir, "hello.txt"))).digest()).digest("hex");
	assert.match(logs.get(5)!, new RegExp(`hash=${expected}`));
	assert.match(logs.get(7)!, /outcome=failure conclusion=success job=success/);
	assert.match(logs.get(8)!, /fromJSON\(\): "nope" isn't JSON/);
	assert.deepEqual(final.outputs, { d: "out", m: "line1\nline2" });
});

test("actions in the repository: a composite action's steps and outputs, and a JavaScript action's pre, main and post with saved state", async () => {
	const repo = repository({
		".github/actions/greet/action.yml": `name: Greet
inputs:
  who:
    default: world
outputs:
  msg:
    value: \${{ steps.g.outputs.msg }}
runs:
  using: composite
  steps:
    - id: g
      shell: bash
      run: |
        echo "hi \${{ inputs.who }} from \${{ github.action_path }} with $CALLER_ENV"
        echo "msg=hello-\${{ inputs.who }}" >> "$GITHUB_OUTPUT"
`,
		".github/actions/js/action.yml": `name: JS
inputs:
  name:
    required: true
  node-version:
    default: "20"
runs:
  using: node20
  pre: pre.js
  main: main.js
  post: post.js
`,
		".github/actions/js/pre.js": "console.log('pre ran');\n",
		".github/actions/js/main.js": `const fs = require("fs");
fs.appendFileSync(process.env.GITHUB_OUTPUT, "greeting=hello " + process.env.INPUT_NAME + "\\n");
fs.appendFileSync(process.env.GITHUB_STATE, "from_main=" + process.env["INPUT_NODE-VERSION"] + "\\n");
console.log("main ran in " + process.cwd() + " from " + process.env.GITHUB_ACTION_PATH);
`,
		".github/actions/js/post.js": "console.log('post saw ' + process.env.STATE_from_main);\n",
	});
	const action = (path: string): ResolvedAction => {
		const meta = parseActionMeta(readFileSync(join(repo.dir, path, "action.yml"), "utf8"), path);
		return { meta, dir: `${WORKSPACE}/${path}`, repository: "alice/app", ref: "", archive: null, nested: meta.runs.using === "composite" ? meta.runs.steps.map(() => null) : [] };
	};
	const steps = [
		step("Check out", { kind: "checkout", run: null }),
		step("Greet", { kind: "action", id: "c", with: { who: "megit" }, env: { CALLER_ENV: "the caller's env" }, uses: { kind: "local", path: ".github/actions/greet" } }),
		step("Show", { run: 'echo "said ${{ steps.c.outputs.msg }}"' }),
		step("JS", { kind: "action", id: "j", with: { name: "Ada" }, uses: { kind: "local", path: ".github/actions/js" } }),
		step("Show JS", { run: 'echo "js said ${{ steps.j.outputs.greeting }}"' }),
	];
	const launch = launchFor({ repo, steps, actions: [null, action(".github/actions/greet"), null, action(".github/actions/js"), null] });
	const { reports, logs, box } = await run(launch);
	const final = reports.at(-1)!;
	assert.equal(final.conclusion, "success", JSON.stringify([...logs]));
	assert.deepEqual(shown(final), ["Set up job: success", "Pre JS: success", "Check out: success", "Greet: success", "Show: success", "JS: success", "Show JS: success", "Post JS: success", "Complete job: success"]);
	assert.match(logs.get(0)!, /Node\.js v\d+/);
	assert.match(logs.get(1)!, /pre ran/);
	assert.match(logs.get(3)!, new RegExp(`hi megit from ${box.workspace}/.github/actions/greet with the caller's env`), "a composite action's steps get the env of the step that used it");
	assert.match(logs.get(4)!, /said hello-megit/);
	assert.match(logs.get(5)!, new RegExp(`main ran in ${box.workspace} from ${box.workspace}/.github/actions/js`));
	assert.match(logs.get(6)!, /js said hello Ada/);
	assert.match(logs.get(7)!, /post saw 20/);
});

test("a failing step inside a composite action fails its step, and continue-on-error on the step keeps the job going", async () => {
	const repo = repository({
		"a/action.yml": "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo first\n    - shell: bash\n      run: exit 4\n    - shell: bash\n      run: echo never\n",
	});
	const meta = parseActionMeta(readFileSync(join(repo.dir, "a/action.yml"), "utf8"), "a");
	const action: ResolvedAction = { meta, dir: `${WORKSPACE}/a`, repository: "alice/app", ref: "", archive: null, nested: [null, null, null] };
	const steps = [
		step("Check out", { kind: "checkout", run: null }),
		step("Tolerated", { kind: "action", id: "t", continueOnError: true, uses: { kind: "local", path: "a" } }),
		step("Seen", { run: 'echo "t=${{ steps.t.outcome }}/${{ steps.t.conclusion }}"' }),
		step("Fatal", { kind: "action", uses: { kind: "local", path: "a" } }),
		step("Skipped", { run: "echo no" }),
		step("On failure", { run: "echo cleaning", if: "failure()" }),
	];
	const { reports, logs } = await run(launchFor({ repo, steps, actions: [null, action, null, action, null, null] }));
	const final = reports.at(-1)!;
	assert.equal(final.conclusion, "failure");
	assert.deepEqual(shown(final), ["Set up job: success", "Check out: success", "Tolerated: success", "Seen: success", "Fatal: failure", "Skipped: skipped", "On failure: success", "Complete job: success"]);
	assert.match(logs.get(2)!, /first[\s\S]*exited with code 4/);
	assert.doesNotMatch(logs.get(2)!, /never/);
	assert.match(logs.get(3)!, /t=failure\/success/);
});

// ── Caches and artifacts, through the job API to R2 ────────────────────────────

/** Enough of R2 for the job API: objects and multipart uploads, in memory. */
class MemoryR2 {
	readonly objects = new Map<string, Uint8Array>();
	private readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
	async get(key: string) {
		const v = this.objects.get(key);
		return v ? { body: new Response(v).body, size: v.length, text: async () => new TextDecoder().decode(v), customMetadata: {} } : null;
	}
	async put(key: string, value: string | Uint8Array) {
		this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
	}
	async delete(key: string) {
		this.objects.delete(key);
	}
	async createMultipartUpload(key: string) {
		const uploadId = randomUUID();
		this.uploads.set(uploadId, { key, parts: new Map() });
		return { key, uploadId };
	}
	resumeMultipartUpload(key: string, uploadId: string) {
		const upload = this.uploads.get(uploadId);
		return {
			uploadPart: async (partNumber: number, body: ReadableStream) => {
				if (!upload || upload.key !== key) throw new Error("no such upload");
				upload.parts.set(partNumber, new Uint8Array(await new Response(body).arrayBuffer()));
				return { partNumber, etag: `etag-${partNumber}` };
			},
			complete: async (parts: { partNumber: number }[]) => {
				if (!upload) throw new Error("no such upload");
				const chunks = parts.map((p) => upload.parts.get(p.partNumber)!);
				const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
				let at = 0;
				for (const c of chunks) {
					data.set(c, at);
					at += c.length;
				}
				this.objects.set(key, data);
				this.uploads.delete(uploadId);
				return { size: data.length };
			},
			abort: async () => {
				this.uploads.delete(uploadId);
			},
		};
	}
}

/** The job API on a local port, with a coordinator that's just CiStorage over SQLite. */
async function apiServer(): Promise<{ url: string; storage: CiStorage; bucket: MemoryR2; server: Server }> {
	const bucket = new MemoryR2();
	const storage = new CiStorage(sqlStorage(new DatabaseSync(":memory:")), bucket as unknown as R2Bucket, () => "repo-1");
	const coordinator = {
		ciCacheLookup: (g: JobGrant, keys: string[], v: string) => storage.lookupCache(g, keys, v),
		ciCacheObject: (g: JobGrant, id: string) => storage.cacheObject(g, id),
		ciCacheReserve: (g: JobGrant, key: string, v: string, size: number) => storage.reserveCache(g, key, v, size),
		ciArtifacts: (run: number) => storage.listArtifacts(run),
		ciArtifactObject: (run: number, id: string) => storage.artifactObject(run, id),
		ciArtifactReserve: (g: JobGrant, name: string, size: number, days: number | null, overwrite: boolean) => storage.reserveArtifact(g, name, size, days, overwrite),
		ciUploadTarget: (kind: "caches" | "artifacts", id: string, g: JobGrant) => storage.uploadTarget(kind, id, g),
		ciUploadPart: (kind: "caches" | "artifacts", id: string, g: JobGrant, part: R2UploadedPart) => storage.recordPart(kind, id, g, part),
		ciUploadCommit: (kind: "caches" | "artifacts", id: string, g: JobGrant) => storage.commit(kind, id, g),
	};
	const env = { MEGIT_API_KEY: API_KEY, CI_BUCKET: bucket, PROJECT: { getByName: () => coordinator } } as unknown as Env;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const body = chunks.length ? Buffer.concat(chunks) : undefined;
		const request = new Request(`http://local${req.url!.replace(/^\/api\/ci/, "")}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === "GET" ? undefined : body });
		const response = await jobApi.fetch(request, env);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}`, storage, bucket, server };
}

const servers: Server[] = [];
after(() => {
	for (const s of servers) s.close();
});

test("caches and artifacts: saved after a job, restored by key or prefix in the next, and downloaded by name", async () => {
	const api = await apiServer();
	servers.push(api.server);
	const grant: JobGrant = { repo: "repo-1", run: 7, job: "job-1", read: ["refs/heads/topic", "refs/heads/master"], write: "refs/heads/topic", expires: Date.now() + 600_000 };
	const token = await mintJobToken(API_KEY, grant);
	const repo = repository({ "package-lock.json": '{"lock":1}\n' });
	const cache = (key: string, extra: Record<string, string> = {}) => step("Cache", { kind: "cache", id: "cache", with: { key, path: "deps\n~/.tool", ...extra } });
	const box = new LocalSandbox();
	// First job: a miss, files made, then saved by the post step; an artifact uploaded.
	const first = await run(
		launchFor({
			repo,
			api: { url: api.url, token },
			steps: [
				step("Check out", { kind: "checkout", run: null }),
				cache("deps-${{ hashFiles('package-lock.json') }}"),
				step("Build", {
					run: 'echo "hit=${{ steps.cache.outputs.cache-hit }}"; mkdir -p deps dist/sub ~/.tool; echo cached > deps/a.txt; echo tool > ~/.tool/t; echo built > dist/app.js; echo deep > dist/sub/x.txt; echo dash > dist/-report.txt; echo back > "dist/back\\\\slash.txt"; echo nl > "dist/new$(printf "\\\\nline").txt"',
				}),
				step("Upload", { kind: "upload-artifact", id: "up", with: { name: "dist", path: "dist/" } }),
				step("Upload nothing", { kind: "upload-artifact", with: { name: "none", path: "missing/**", "if-no-files-found": "warn" } }),
			],
		}),
		box,
	);
	const r1 = first.reports.at(-1)!;
	assert.equal(r1.conclusion, "success", JSON.stringify([...first.logs]));
	assert.deepEqual(shown(r1), ["Set up job: success", "Check out: success", "Cache: success", "Build: success", "Upload: success", "Upload nothing: success", "Post Cache: success", "Complete job: success"]);
	assert.match(first.logs.get(2)!, /No cache was found/);
	assert.match(first.logs.get(3)!, /hit=false/);
	assert.match(first.logs.get(5)!, /Warning: no files were found/);
	assert.match(first.logs.get(6)!, /Saved the cache for deps-[0-9a-f]{64}/);
	assert.ok(!first.logs.get(6)!.includes(token), "the job token never shows in the log");
	assert.deepEqual(
		api.storage.listArtifacts(7).map((a) => a.name),
		["dist"],
	);
	assert.equal(api.storage.listCaches()[0].scope, "refs/heads/topic");

	// A fresh machine: the same key hits exactly, and isn't saved again; the artifact comes back.
	const fresh = () => {
		for (const dir of [box.state, box.inbox, box.user, box.workspace, join(box.root, ".tool")]) rmSync(dir, { recursive: true, force: true });
	};
	fresh();
	const second = await run(
		launchFor({
			repo,
			api: { url: api.url, token },
			steps: [
				step("Check out", { kind: "checkout", run: null }),
				cache("deps-${{ hashFiles('package-lock.json') }}"),
				step("Check", { run: 'echo "hit=${{ steps.cache.outputs.cache-hit }}"; cat deps/a.txt ~/.tool/t' }),
				step("Download", { kind: "download-artifact", id: "down", with: { name: "dist", path: "got" } }),
				step("Look", { run: 'cat got/app.js got/sub/x.txt got/-report.txt "got/back\\\\slash.txt" "got/new$(printf "\\\\nline").txt"; echo "into ${{ steps.down.outputs.download-path }}"' }),
			],
		}),
		box,
	);
	const r2 = second.reports.at(-1)!;
	assert.equal(r2.conclusion, "success", JSON.stringify([...second.logs]));
	assert.match(second.logs.get(3)!, /hit=true\ncached\ntool/);
	assert.match(second.logs.get(5)!, /built\ndeep\ndash\nback\nnl\ninto .*\/got/, "names starting with -, or with a backslash or a newline, come through");
	assert.match(second.logs.get(6)!, /restored from its key/);

	// Another key, restored by its restore-keys prefix: files back, but not a hit.
	fresh();
	const third = await run(
		launchFor({
			repo,
			api: { url: api.url, token },
			steps: [step("Check out", { kind: "checkout", run: null }), cache("deps-other", { "restore-keys": "nothing-\ndeps-" }), step("Check", { run: 'echo "hit=${{ steps.cache.outputs.cache-hit }} matched=${{ steps.cache.outputs.cache-matched-key }}"; cat deps/a.txt' })],
		}),
		box,
	);
	assert.equal(third.reports.at(-1)!.conclusion, "success");
	assert.match(third.logs.get(3)!, /hit=false matched=deps-[0-9a-f]{64}\ncached/);
	assert.equal(api.storage.listCaches().length, 2, "deps-other was saved as well");

	// Another branch's job can't see topic's caches; uploading an artifact twice without overwrite fails.
	const other = await mintJobToken(API_KEY, { ...grant, read: ["refs/heads/other", "refs/heads/master"], write: "refs/heads/other" });
	fresh();
	const fourth = await run(
		launchFor({
			repo,
			api: { url: api.url, token: other },
			steps: [
				step("Check out", { kind: "checkout", run: null }),
				step("Cache", { kind: "cache-restore", id: "cache", with: { key: "deps-other", path: "deps", "fail-on-cache-miss": "true" }, continueOnError: true }),
				step("Make", { run: "mkdir -p dist && echo again > dist/app.js" }),
				step("Upload again", { kind: "upload-artifact", with: { name: "dist", path: "dist" } }),
			],
		}),
		box,
	);
	assert.match(fourth.logs.get(2)!, /No cache was found/);
	assert.match(fourth.logs.get(4)!, /already has an artifact called dist/);
	assert.equal(fourth.reports.at(-1)!.conclusion, "failure");
	assert.ok(existsSync(box.workspace));
});

test("uploads: one at a time per name, nothing committed short, and their size checked when they finish", async () => {
	const bucket = new MemoryR2();
	const storage = new CiStorage(sqlStorage(new DatabaseSync(":memory:")), bucket as unknown as R2Bucket, () => "repo-1");
	const grant: JobGrant = { repo: "repo-1", run: 3, job: "a", read: ["refs/heads/x"], write: "refs/heads/x", expires: Date.now() + 60_000 };
	const part = async (kind: "caches" | "artifacts", id: string, bytes: string) => {
		const target = storage.uploadTarget(kind, id, grant);
		storage.recordPart(kind, id, grant, await bucket.resumeMultipartUpload(target.key, target.uploadId).uploadPart(1, new Response(bytes).body!));
	};
	// Two reservations at once: one wins, the other is told it exists.
	const [one, two] = await Promise.allSettled([storage.reserveArtifact(grant, "dist", 3, null, false), storage.reserveArtifact({ ...grant, job: "b" }, "dist", 3, null, false)]);
	assert.equal(one.status, "fulfilled");
	assert.equal(two.status, "rejected");
	assert.match(String((two as PromiseRejectedResult).reason), /already has an artifact called dist \(still being uploaded\)/);
	const caches = await Promise.all([storage.reserveCache(grant, "k", "a".repeat(64), 5), storage.reserveCache(grant, "k", "a".repeat(64), 5)]);
	assert.equal(caches.filter(Boolean).length, 1, "the same cache key is saved once");
	// An upload short of what it reserved isn't committed.
	const id = (one as PromiseFulfilledResult<string>).value;
	await part("artifacts", id, "a");
	await assert.rejects(storage.commit("artifacts", id, grant), /came to 1 bytes, not the 3/);
	assert.deepEqual(storage.listArtifacts(3), []);
	const again = await storage.reserveArtifact(grant, "dist", 3, null, false);
	await part("artifacts", again, "abc");
	await storage.commit("artifacts", again, grant);
	assert.deepEqual(storage.listArtifacts(3).map((a) => a.size), [3]);
	await assert.rejects(storage.reserveArtifact(grant, "dist", 3, null, false), /set overwrite: true/);
	assert.ok(await storage.reserveArtifact(grant, "dist", 3, null, true), "overwrite replaces it");
});
