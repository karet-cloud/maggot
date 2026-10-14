#!/usr/bin/env node
// Runs in production CI after deployment. Credentials come from GitHub environment secrets.
const base = process.env.MAGGOT_URL ?? "https://maggot.karet.cloud";
const username = "maggot-mirror";
const password = process.env.MAGGOT_MIRROR_PASSWORD;
const adminKey = process.env.MAGGOT_API_KEY;
if (!password || !adminKey) throw new Error("Configure MAGGOT_MIRROR_PASSWORD and MAGGOT_API_KEY in the production environment.");
const email = "maggot-mirror@maggot.invalid";
const repoPath = "/api/repos/maggot-mirror/linux";

async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
	return fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
}
async function failure(response: Response, action: string): Promise<never> {
	const data = await response.json().catch(() => null) as { error?: { message?: string }; message?: string } | null;
	throw new Error(`${action}: HTTP ${response.status}: ${data?.error?.message ?? data?.message ?? response.statusText}`);
}
const existing = await request(repoPath);
if (existing.ok) {
	const data = await existing.json() as { repo: { visibility: string; description: string | null } };
	if (data.repo.visibility !== "public" || !data.repo.description?.includes("https://github.com/torvalds/linux")) throw new Error("An existing linux repository does not match the public demo mirror; leaving it unchanged.");
	console.log("Public Linux demo exists; verifying source access.");
} else {
	if (existing.status !== 404) await failure(existing, "Check demo repository");
	let login = await request("/api/auth/sign-in/email", { email, password });
	if (!login.ok) {
		if (login.status !== 401) await failure(login, "Sign in mirror user");
		const signup = await request("/api/auth/sign-up/email", { email, password, username, name: "Maggot OSS Mirrors" });
		if (!signup.ok) await failure(signup, "Create mirror user");
	}
	// Verification must also recover accounts created by an interrupted earlier run.
	// Explicitly verify the service account; no mail is sent to the reserved example address.
	const verification = await request("/api/admin/verify-email", { username }, { authorization: `Bearer ${adminKey}` });
	if (verification.ok) {
		const { url } = await verification.json() as { url: string };
		if (new URL(url).origin !== new URL(base).origin) throw new Error("Unexpected verification origin");
		const confirmed = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!confirmed.ok) await failure(confirmed, "Verify mirror user");
	} else if (verification.status !== 409) await failure(verification, "Issue mirror verification");
	login = await request("/api/auth/sign-in/email", { email, password });
	if (!login.ok) await failure(login, "Sign in mirror user");
	const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
	if (!cookie) throw new Error("Mirror login returned no session cookie");
	const created = await request("/api/repos", {
		name: "linux", visibility: "public", defaultBranch: "master",
		description: "Linux kernel source mirror of https://github.com/torvalds/linux — master, latest 100 commits. Upstream copyright and licensing apply.",
		importUrl: "https://github.com/torvalds/linux.git", importBranch: "master", importDepth: 100,
	}, { cookie });
	if (!created.ok) await failure(created, "Import Linux mirror");
	const verified = await request(repoPath);
	if (!verified.ok) await failure(verified, "Verify public mirror");
	const data = await verified.json() as { repo: { visibility: string } };
	if (data.repo.visibility !== "public") throw new Error("Linux demo is not public");
	console.log("Linux import completed; verifying source access.");
}

// Check the actual public Git data, including on reruns after an interrupted import.
const treeResponse = await request(`${repoPath}/tree?path=`);
if (!treeResponse.ok) await failure(treeResponse, "Read public Linux root");
const { tree } = await treeResponse.json() as { tree: { commit: string | null; entries: { name: string }[] } };
if (!tree.commit || !tree.entries.some(entry => entry.name === "README") || !tree.entries.some(entry => entry.name === "kernel")) throw new Error("Public Linux mirror has no usable kernel source tree");
const readme = await request(`${repoPath}/files/README?ref=${encodeURIComponent(tree.commit)}`);
if (!readme.ok) await failure(readme, "Read public Linux README");
if (!(await readme.text()).includes("Linux")) throw new Error("Public mirror README does not identify Linux");
console.log(`Verified anonymous Linux source access: ${base}/maggot-mirror/linux`);
