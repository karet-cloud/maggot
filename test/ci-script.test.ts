import assert from "node:assert/strict";
import { test } from "node:test";
import {
	COLLECT_BYTES,
	COLLECT_SCRIPT,
	completeUtf8,
	inboxMaskPath,
	inboxPath,
	maskFile,
	KILL_SCRIPT,
	LAUNCH_SCRIPT,
	LogMasker,
	maskValues,
	MIN_MASKED_LENGTH,
	parseCollectSizes,
	collectedPath,
	secretsIn,
	parseEnvFile,
	parsePathFile,
	parsePoll,
	POLL_SCRIPT,
	ScriptOutputError,
	shellQuote,
	stepFile,
	stepInterpreter,
} from "../src/ci/script.ts";
import type { StepSpec } from "../src/ci/workflow.ts";
import { LocalSandbox } from "./ci-local.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const step = (run: string, extra: Partial<StepSpec> = {}): StepSpec => ({
	kind: "run",
	id: null,
	uses: null,
	with: {},
	name: "s",
	run,
	shell: "bash",
	workingDirectory: null,
	env: {},
	if: "success()",
	continueOnError: false,
	timeoutMinutes: null,
	...extra,
});

/** Feeds `text` through a fresh masker per chunk (as the alarm does), passing the held tail along. */
function maskInChunks(secrets: string[], chunks: string[]): string {
	let tail = "";
	let out = "";
	for (const c of chunks) {
		const m = new LogMasker(secrets, tail);
		out += m.push(c);
		tail = m.tail;
	}
	return out + new LogMasker(secrets, tail).flush();
}

test("secrets are masked, even when split across chunks", () => {
	const secret = "hunter2-very-secret";
	const text = `before ${secret} middle ${secret}after`;
	const expected = "before *** middle ***after";
	for (let a = 0; a <= text.length; a++) {
		for (const b of [a, Math.min(text.length, a + 3), text.length]) {
			assert.equal(maskInChunks([secret], [text.slice(0, a), text.slice(a, b), text.slice(b)]), expected, `cut at ${a}/${b}`);
		}
	}
	// One character at a time.
	assert.equal(maskInChunks([secret], [...text]), expected);
});

test("masking: longest secret wins, overlaps and short values", () => {
	assert.equal(maskInChunks(["abcd", "abcdefgh"], ["xx abcdefgh yy abcd"]), "xx *** yy ***");
	assert.equal(maskInChunks(["ab"], ["ab is too short to mask"]), "ab is too short to mask");
	// Three characters is the shortest masked, as runs.ts keeps secrets of three and up.
	assert.equal(MIN_MASKED_LENGTH, 3);
	assert.equal(maskInChunks(["abc"], ["x abc y", "ab", "c"]), "x *** y***");
	assert.equal(maskInChunks(["aaaa"], ["aaaaaa"]), "***aa");
	assert.equal(maskInChunks([], ["nothing", " to hide"]), "nothing to hide");
	// Each line of a multi-line secret is masked on its own, as logs print them line by line.
	const key = "-----BEGIN KEY-----\nAAAAsecretbody\n-----END KEY-----";
	assert.equal(maskInChunks([key], ["line: AAAAsecretbody\n"]), "line: ***\n");
	assert.ok(maskValues([key]).includes(key));
});

test("output that can't start a secret is shown at once", () => {
	const m = new LogMasker(["supersecret-value"]);
	assert.equal(m.push("started\n"), "started\n");
	assert.equal(m.push("next: sup"), "next: ");
	assert.equal(m.tail, "sup");
});

test("a masker's held tail never shows a secret's start", () => {
	const m = new LogMasker(["supersecret"]);
	const shown = m.push("token: super");
	assert.ok(!shown.includes("super"), shown);
	const rest = new LogMasker(["supersecret"], m.tail);
	assert.equal(shown + rest.push("secret done") + rest.flush(), "token: *** done");
});

test("UTF-8 characters cut by a slice are carried over whole", () => {
	const text = "héllo → wörld 🎉 done";
	const bytes = enc.encode(text);
	for (let cut = 0; cut <= bytes.length; cut++) {
		const [whole, rest] = completeUtf8(bytes.subarray(0, cut));
		const [second, rest2] = completeUtf8(new Uint8Array([...rest, ...bytes.subarray(cut)]));
		assert.equal(rest2.length, 0);
		assert.equal(dec.decode(whole) + dec.decode(second), text, `cut at ${cut}`);
		assert.ok(!dec.decode(whole).includes("\ufffd"), `no replacement character at ${cut}`);
	}
});

test("poll output parses strictly: exit codes and states, nothing else", () => {
	assert.deepEqual(parsePoll(`0\n5\n${btoa("hello")}\n`), { state: 0, size: 5, bytes: enc.encode("hello") });
	for (const state of ["running", "missing", "lost", "pending"] as const) assert.equal(parsePoll(`${state}\n0\n\n`).state, state);
	assert.equal(parsePoll("137\n0\n\n").state, 137);
	// A failed or garbled command is an error, not "still running".
	for (const bad of ["", "\n", "0\n", "oops\n0\n\n", "0\nlots\n\n", "0\n3\n!!notbase64\n", "1234\n0\n\n"]) {
		assert.throws(() => parsePoll(bad), ScriptOutputError, JSON.stringify(bad));
	}
});

test("collect prints only sizes", () => {
	assert.deepEqual(parseCollectSizes("8\n70000\n0\n12\n"), [8, 70000, 0, 12]);
	assert.throws(() => parseCollectSizes("8\n70000\n"), ScriptOutputError, "all four files");
	assert.throws(() => parseCollectSizes("nope"), ScriptOutputError);
	assert.throws(() => parseCollectSizes(`8\n${btoa("A=1")}\n`), ScriptOutputError);
});

test("a step's mask holds only the secrets in its own script", () => {
	const file = "export A='used-secret'\nexport Q='it'\\''s-quoted'\necho run\n";
	assert.deepEqual(secretsIn(file, ["used-secret", "unused-secret", "it's-quoted"]), ["used-secret", "it's-quoted"]);
	assert.deepEqual(secretsIn("export K='x\nline-two-of-key'\n", ["line-one-of-key\nline-two-of-key"]), ["line-one-of-key\nline-two-of-key"]);
});

test("$GITHUB_ENV: lines, heredocs, protected names and garbage", () => {
	const { env, errors } = parseEnvFile("A=1\nB=x=y\nMULTI<<EOF\nline 1\nline 2\nEOF\nPATH=/evil\nnot a line\n\nEMPTY=\n");
	assert.deepEqual(env, { A: "1", B: "x=y", MULTI: "line 1\nline 2", EMPTY: "" });
	assert.equal(errors.length, 2);
	assert.match(errors.join("\n"), /can't set PATH/);
	assert.match(parseEnvFile("X<<END\nnever ends").errors[0], /never ends/);
	assert.deepEqual(parsePathFile("/a/bin\n\n /b/bin \n"), ["/a/bin", "/b/bin"]);
});

test("step files quote values and set the environment in order", () => {
	const file = stepFile(step("echo hi", { env: { STEP: "it's" }, workingDirectory: "sub dir" }), { JOB: "j", STEP: "job" }, { ADDED: "a" }, ["/one", "/two"]);
	assert.match(file, /export STEP='it'\\''s'/);
	assert.match(file, /export JOB='j'/);
	assert.match(file, /export ADDED='a'/);
	assert.match(file, /export PATH='\/two:\/one':"\$PATH"/);
	assert.match(file, /cd '\/workspace\/sub dir'/);
	assert.equal(shellQuote("a'b"), `'a'\\''b'`);
	assert.equal(stepInterpreter({ shell: "sh" }), "sh -e");
});

const BASH = "bash --noprofile --norc -eo pipefail";

/** Writes the script to the inbox and runs the launch, as the runner does. */
async function launch(box: LocalSandbox, id: string, script: string, opts: { write?: boolean; attempt?: number } = {}) {
	const attempt = opts.attempt ?? 1;
	if (opts.write !== false) await box.writeFile(inboxPath(id, attempt), script);
	return box.exec(["sh", "-c", LAUNCH_SCRIPT], { env: { MAGGOT_ID: id, MAGGOT_ATTEMPT: String(attempt), MAGGOT_INTERPRETER: BASH, MAGGOT_AS_USER: "1" }, root: true });
}

const poll = async (box: LocalSandbox, id: string, offset = 0, max = 1 << 20) =>
	parsePoll((await box.exec(["sh", "-c", POLL_SCRIPT], { env: { MAGGOT_ID: id, MAGGOT_OFFSET: String(offset), MAGGOT_MAX: String(max) } })).stdout);

async function waitForExit(box: LocalSandbox, id: string) {
	for (let i = 0; i < 200; i++) {
		const p = await poll(box, id);
		if (typeof p.state === "number" || p.state === "lost") return p;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("the step never ended");
}

/** Kills one of this test's own step process groups, by the pid its launch recorded. */
async function killOwnGroup(box: LocalSandbox, id: string) {
	const pid = (await box.exec(["cat", `${box.state}/step-${id}.pid`])).stdout.trim();
	if (/^\d+$/.test(pid)) await box.exec(["sh", "-c", `kill -KILL -${pid} 2>/dev/null || true`]);
}

test("the launch takes its script from the inbox, starts it once, and the poll reads its log and exit code", async () => {
	const box = new LocalSandbox();
	const script = "echo run >> \"$0.count\"; printf 'out\\n'; echo err >&2; exit 3\n";
	assert.equal((await launch(box, "0", script)).exitCode, 0);
	assert.equal((await launch(box, "0", script)).exitCode, 0, "a retried launch is fine");
	const p = await waitForExit(box, "0");
	assert.equal(p.state, 3);
	assert.equal(dec.decode(p.bytes), "out\nerr\n");
	assert.equal(p.size, 8);
	assert.equal((await box.exec(["cat", `${box.state}/step-0.sh.count`])).stdout, "run\n", "the step ran once");
	assert.equal((await box.exec(["sh", "-c", `ls ${box.inbox}`])).stdout, "", "the retried launch's copy was thrown away");
	// Slices: offset and max.
	assert.equal(dec.decode((await poll(box, "0", 2, 3)).bytes), "t\ne");
	// The script file (which holds the environment) is gone once the step ends.
	const left = await box.exec(["sh", "-c", `ls ${box.state}`]);
	assert.ok(!left.stdout.split("\n").includes("step-0.sh"), left.stdout);
	assert.equal((await poll(box, "9")).state, "missing");
	// Only the script's name reaches the launch command, never its content.
	for (const c of box.calls) assert.ok(!JSON.stringify(c).includes("printf 'out"), "no script in a command");
});

test("a script waiting for its launch is pending; a launch without one fails the step", async () => {
	const box = new LocalSandbox();
	await box.writeFile(inboxPath("5", 1), "echo hi\n");
	assert.equal((await poll(box, "5")).state, "pending");
	const result = await launch(box, "6", "", { write: false });
	assert.notEqual(result.exitCode, 0);
	const p = await waitForExit(box, "6");
	assert.equal(p.state, 126);
	assert.match(dec.decode(p.bytes), /never reached the machine/);
});

test("a launch that can't take its lock fails rather than claiming it started", async () => {
	const box = new LocalSandbox();
	// Something that isn't a lock is in the lock's place, so mkdir fails for a reason other than a launch.
	await box.exec(["sh", "-c", `mkdir -p ${box.state} && : > ${box.state}/step-0.lock`]);
	const result = await launch(box, "0", "echo hi\n");
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr, /lock/);
});

test("a step whose wrapper died without an exit code is lost, not running forever", async () => {
	const box = new LocalSandbox();
	await launch(box, "3", "sleep 30\n");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((await poll(box, "3")).state, "running");
	// Kill the wrapper alone (as the OOM killer might), then the rest of this test's own group.
	const pid = (await box.exec(["cat", `${box.state}/step-3.pid`])).stdout.trim();
	await box.exec(["kill", "-KILL", pid]);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal((await poll(box, "3")).state, "lost");
	await killOwnGroup(box, "3");
});

test("the kill script stops a step's whole process group", async () => {
	const box = new LocalSandbox();
	await launch(box, "1", "sleep 30 & sleep 30\n");
	await new Promise((r) => setTimeout(r, 200));
	await box.exec(["sh", "-c", KILL_SCRIPT], { env: { MAGGOT_ID: "1", MAGGOT_SIGNAL: "TERM" } });
	assert.equal((await waitForExit(box, "1")).state, 143, "the wrapper outlives SIGTERM and records it");
	const pid = (await box.exec(["cat", `${box.state}/step-1.pid`])).stdout.trim();
	const alive = await box.exec(["sh", "-c", `ps -o pid= -g ${pid} | grep -v "^ *${pid}$" || true`]);
	assert.equal(alive.stdout.trim(), "", "no sleep left behind");
	// A hard kill of a step that ignores SIGTERM still settles it.
	await launch(box, "2", "trap '' TERM; sleep 30\n");
	await new Promise((r) => setTimeout(r, 200));
	await box.exec(["sh", "-c", KILL_SCRIPT], { env: { MAGGOT_ID: "2", MAGGOT_SIGNAL: "KILL" } });
	assert.equal((await waitForExit(box, "2")).state, 137);
	await killOwnGroup(box, "2");
});

test("the collect script copies $GITHUB_ENV, $GITHUB_PATH, $GITHUB_OUTPUT and $GITHUB_STATE to files, prints only sizes, and empties them", async () => {
	const box = new LocalSandbox();
	await box.exec([
		"sh",
		"-c",
		`mkdir -p ${box.user} && printf 'TOK=s3cr3t-value\\n' > ${box.user}/github-env && head -c ${COLLECT_BYTES + 5} /dev/zero | tr '\\0' 'x' > ${box.user}/github-path && printf 'dir=out\\n' > ${box.user}/github-output`,
	]);
	const out = (await box.exec(["sh", "-c", COLLECT_SCRIPT], { env: { MAGGOT_ID: "0" } })).stdout;
	assert.deepEqual(parseCollectSizes(out), [17, COLLECT_BYTES + 5, 8, 0]);
	assert.equal(await box.readFile(collectedPath("0", "output")), "dir=out\n");
	assert.equal(await box.readFile(collectedPath("0", "state")), "", "a file that wasn't there reads as empty");
	assert.ok(!out.includes("s3cr3t") && !out.includes(btoa("TOK=s3cr3t-value\n").slice(0, 12)), "no content in the output");
	assert.equal(await box.readFile(collectedPath("0", "env")), "TOK=s3cr3t-value\n");
	assert.equal((await box.readFile(collectedPath("0", "path"))).length, COLLECT_BYTES);
	assert.equal(await box.readFile(`${box.user}/github-env`), "", "emptied for the next step");
	// Run again for the same step (its answer lost): the same sizes, the copies untouched.
	assert.equal((await box.exec(["sh", "-c", COLLECT_SCRIPT], { env: { MAGGOT_ID: "0" } })).stdout, out);
	assert.equal(await box.readFile(collectedPath("0", "env")), "TOK=s3cr3t-value\n");
});

test("steps run with umask 022, though the state they're launched from is private", async () => {
	const box = new LocalSandbox();
	await launch(box, "4", `cd ${box.root} && umask && mkdir made && touch made/file && stat -c '%a' made made/file\n`);
	const p = await waitForExit(box, "4");
	assert.equal(p.state, 0);
	assert.equal(dec.decode(p.bytes), "0022\n755\n644\n");
	assert.equal((await box.exec(["stat", "-c", "%a", box.state])).stdout.trim(), "700");
});

test("a delayed launch from an earlier try takes only its own complete files", async () => {
	const box = new LocalSandbox();
	// Try 1 was written whole and launched (late); try 2's files are being written meanwhile.
	await box.writeFile(inboxPath("6", 1), "echo from-try-1\n");
	await box.writeFile(inboxPath("6", 2), "echo from-try-2\n");
	await launch(box, "6", "", { write: false, attempt: 1 });
	assert.equal(dec.decode((await waitForExit(box, "6")).bytes), "from-try-1\n");
	await launch(box, "6", "", { write: false, attempt: 2 });
	assert.equal((await box.exec(["sh", "-c", `ls -A ${box.inbox}`])).stdout, "", "every try's files cleared");
});

test("a launch with a mask but no awk fails closed instead of logging secrets", async () => {
	const box = new LocalSandbox();
	await box.writeFile(inboxMaskPath("9", 1), maskFile(["hunter2-secret"]));
	await box.writeFile(inboxPath("9", 1), "echo hunter2-secret\n");
	// A PATH with sh and the basics, but no awk.
	const bin = `${box.root}/bin`;
	await box.exec(["sh", "-c", `mkdir -p ${bin} && for t in sh mkdir rm mv chmod cat printf id setsid head tail wc base64 tr find ls kill; do p=$(command -v $t) && ln -s "$p" ${bin}/$t; done`]);
	const result = await box.exec(["sh", "-c", LAUNCH_SCRIPT], { env: { PATH: bin, MAGGOT_ID: "9", MAGGOT_ATTEMPT: "1", MAGGOT_INTERPRETER: BASH, MAGGOT_AS_USER: "1" }, root: true });
	assert.notEqual(result.exitCode, 0);
	const p = await waitForExit(box, "9");
	assert.equal(p.state, 126);
	assert.match(dec.decode(p.bytes), /awk is needed/);
	assert.ok(!dec.decode(p.bytes).includes("hunter2"));
});

test("with a mask file, the log on the machine is masked, and exit codes and SIGTERM still come through", async () => {
	const box = new LocalSandbox();
	const secret = "hunter2-on-the-box";
	await box.writeFile(inboxMaskPath("7", 1), maskFile([secret, "line-one\nline-two", "ab"]));
	await launch(box, "7", `echo "a ${secret} b ${secret}"; echo line-two; printf 'no newline ${secret}'; exit 5\n`);
	const p = await waitForExit(box, "7");
	assert.equal(p.state, 5);
	assert.equal(dec.decode(p.bytes), "a *** b ***\n***\nno newline ***\n");
	const files = (await box.exec(["sh", "-c", `ls ${box.state}`])).stdout;
	assert.ok(!/step-7\.(mask|sh|code)\b/.test(files), files);
	// Cancelled: the filter outlives SIGTERM and writes what came before it.
	await box.writeFile(inboxMaskPath("8", 1), maskFile([secret]));
	await launch(box, "8", `echo "before ${secret}"; sleep 30\n`);
	await new Promise((r) => setTimeout(r, 300));
	await box.exec(["sh", "-c", KILL_SCRIPT], { env: { MAGGOT_ID: "8", MAGGOT_SIGNAL: "TERM" } });
	const killed = await waitForExit(box, "8");
	assert.equal(killed.state, 143);
	assert.equal(dec.decode(killed.bytes), "before ***\n");
	await killOwnGroup(box, "8");
});

test("mask files hold one value per line, longest first, without multi-line values or short ones", () => {
	// A multi-line value is masked by its lines, and by its escaped one-line form (bash's $'x\ny-line').
	assert.equal(maskFile(["abc", "abcdef", "x\ny-line", "ab"]), "x\\ny-line\nabcdef\ny-line\nabc\n");
	assert.equal(maskFile([]), "");
});

test("secrets are masked in bash's set -x trace, printf %q and JSON, unusual characters and all", () => {
	for (const secret of ["abc'def", "p@ss w0rd$!", "line1\nline2x", "tab\there\\x", `q"uo'te`]) {
		const shown = [
			// What `set -x` prints for `: "$SECRET"`: single quotes with '\'' inside, or $'…' for control characters.
			/[\n\t\\]/.test(secret) ? `+ : $'${secret.replace(/[\\']/g, "\\$&").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}'` : `+ : '${secret.replaceAll("'", "'\\''")}'`,
			secret.replace(/[^A-Za-z0-9_\-.,:/@%+=]/g, "\\$&"),
			JSON.stringify(secret),
		].join("\n");
		const m = new LogMasker([secret]);
		const out = m.push(`${shown}\n`) + m.flush();
		assert.ok(!/abc|w0rd|line1|here|uo/.test(out), `${JSON.stringify(secret)} leaked: ${out}`);
	}
});

test("$GITHUB_ENV keeps a variable called __proto__ as a value", () => {
	const { env } = parseEnvFile("__proto__=x\n");
	assert.ok(Object.hasOwn(env, "__proto__"));
	assert.deepEqual(Object.entries(env), [["__proto__", "x"]]);
});
