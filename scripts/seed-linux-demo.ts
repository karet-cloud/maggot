#!/usr/bin/env node
// Production CI seeds this snapshot using Git; the Artifacts URL importer cannot import Linux reliably.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { seedSourceBatches, cleanupSourceBatches, type SeedAccess } from "./git-source-batches.ts";

const base = process.env.MAGGOT_URL ?? "https://maggot.karet.cloud";
const username = "maggot-mirror";
const password = process.env.MAGGOT_MIRROR_PASSWORD;
const adminKey = process.env.MAGGOT_API_KEY;
if (!password || !adminKey) throw new Error("Configure MAGGOT_MIRROR_PASSWORD and MAGGOT_API_KEY in the production environment.");
const email = "maggot-mirror@maggot.invalid";
const repoPath = "/api/repos/maggot-mirror/linux";
const exec = promisify(execFile);

async function request(path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") {
	return fetch(`${base}${path}`, { method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
}
async function failure(response: Response, action: string): Promise<never> {
	const data = await response.json().catch(() => null) as { error?: { message?: string }; message?: string } | null;
	throw new Error(`${action}: HTTP ${response.status}: ${data?.error?.message ?? data?.message ?? response.statusText}`);
}
async function rootTree() {
	const response = await request(`${repoPath}/tree?path=`);
	if (!response.ok) await failure(response, "Read public Linux root");
	return (await response.json() as { tree: { commit: string | null; entries: { name: string }[] } }).tree;
}
const firstLogin = await request("/api/auth/sign-in/email", { email, password });
if (!firstLogin.ok) {
	if (firstLogin.status !== 401) await failure(firstLogin, "Sign in mirror user");
	const signup = await request("/api/auth/sign-up/email", { email, password, username, name: "Maggot OSS Mirrors" }, { authorization: `Bearer ${adminKey}` });
	if (!signup.ok) await failure(signup, "Create mirror user");
}
// Also recover accounts whose earlier signup was interrupted before verification.
const verification = await request("/api/admin/verify-email", { username }, { authorization: `Bearer ${adminKey}` });
if (verification.ok) {
	const { url } = await verification.json() as { url: string };
	if (new URL(url).origin !== new URL(base).origin) throw new Error("Unexpected verification origin");
	const confirmed = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!confirmed.ok) await failure(confirmed, "Verify mirror user");
} else if (verification.status !== 409) await failure(verification, "Issue mirror verification");
const login = await request("/api/auth/sign-in/email", { email, password });
if (!login.ok) await failure(login, "Sign in mirror user");
const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
if (!cookie) throw new Error("Mirror login returned no session cookie");
// Deployment concurrency serializes this service account's seeds. Recover PATs left by cancellation.
const tokensResponse = await request("/api/tokens", undefined, { cookie });
if (!tokensResponse.ok) await failure(tokensResponse, "List leftover seed tokens");
const { tokens } = await tokensResponse.json() as { tokens: { id: string; name: string }[] };
for (const token of tokens.filter(t => t.name === "Temporary Linux seed")) {
	const revoked = await request(`/api/tokens/${encodeURIComponent(token.id)}`, undefined, { cookie }, "DELETE");
	if (!revoked.ok) await failure(revoked, "Revoke leftover seed token");
}
let exists = false;
let populated = false;
const existing = await request(repoPath);
if (existing.ok) {
	const data = await existing.json() as { repo: { visibility: string; description: string | null } };
	if (data.repo.visibility !== "public" || !data.repo.description?.includes("https://github.com/torvalds/linux")) throw new Error("An existing linux repository does not match the public demo mirror; leaving it unchanged.");
	exists = true;
	populated = Boolean((await rootTree()).commit);
} else if (existing.status !== 404) await failure(existing, "Check demo repository");

{
	const scratch = await mkdtemp(join(tmpdir(), "maggot-linux-seed-"));
	try {
		const mirror = join(scratch, "linux.git");
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
		// Child Git processes only need the temporary user token, not deployment/account credentials.
		delete env.MAGGOT_API_KEY;
		delete env.MAGGOT_MIRROR_PASSWORD;
		delete env.CLOUDFLARE_API_TOKEN;
		if (!populated) {
			await exec("git", ["clone", "--quiet", "--bare", "--depth", "1", "--single-branch", "--branch", "master", "--no-tags", "https://github.com/torvalds/linux.git", mirror], { env, timeout: 300_000 });
			const source = (await exec("git", ["-C", mirror, "remote", "get-url", "origin"], { env })).stdout.trim();
			if (source !== "https://github.com/torvalds/linux.git") throw new Error("Unexpected Linux source remote");
		} else await exec("git", ["init", "--quiet", "--bare", "-b", "master", mirror], { env });
		if (!exists) {
			const created = await request("/api/repos", { name: "linux", visibility: "public", defaultBranch: "master", readme: false, description: "Linux kernel source mirror of https://github.com/torvalds/linux — master source snapshot. Upstream copyright and licensing apply." }, { cookie });
			if (!created.ok) await failure(created, "Create public Linux mirror");
		}
		let access: SeedAccess | undefined;
		let refreshAt = 0;
		const getAccess = async (): Promise<SeedAccess> => {
			if (access && Date.now() < refreshAt) return access;
			const issued = await request(`${repoPath}/credentials`, { scope: "write", ttlSeconds: 300 }, { authorization: `Bearer ${adminKey}` });
			if (!issued.ok) await failure(issued, "Issue short-lived storage credentials");
			const credentials = await issued.json() as SeedAccess;
			const remote = new URL(credentials.remote);
			if (remote.protocol !== "https:" || !remote.hostname.endsWith(".artifacts.cloudflare.net") || remote.username || remote.password) throw new Error("Unexpected storage Git remote");
			access = credentials; refreshAt = Date.now() + 120_000;
			return credentials;
		};
		if (populated) await cleanupSourceBatches(mirror, getAccess, env);
		else await seedSourceBatches(mirror, getAccess, env);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
const recount = await request(`${repoPath}/storage/recount`, {}, { authorization: `Bearer ${adminKey}` });
if (!recount.ok) await failure(recount, "Recount Linux storage and refresh views");
const tree = await rootTree();
if (!tree.commit || !tree.entries.some(entry => entry.name === "README") || !tree.entries.some(entry => entry.name === "kernel")) throw new Error("Public Linux mirror has no usable kernel source tree");
const readme = await request(`${repoPath}/files/README?ref=${encodeURIComponent(tree.commit)}`);
if (!readme.ok) await failure(readme, "Read public Linux README");
if (!(await readme.text()).includes("Linux")) throw new Error("Public mirror README does not identify Linux");
console.log(`Verified anonymous Linux source access: ${base}/maggot-mirror/linux`);
