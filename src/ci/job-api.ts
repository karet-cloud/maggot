import { Hono, type Context } from "hono";
import { HttpError, toHttpError } from "../errors.ts";
import type { ProjectCoordinator } from "../project.ts";
import { GitHubActions } from "./actions.ts";
import { verifyJobToken, type JobGrant } from "./token.ts";

/**
 * megit's Actions API for jobs, at /api/ci: what the cache, artifact and action-fetching steps call
 * from inside a sandbox, with the job's own token (`Authorization: Bearer mgjob_…`). Answers are plain
 * text, one record per line with tab-separated fields, so the steps' shell scripts can read them
 * without a JSON parser. Bytes go to and from R2 here, in the Worker; the records are kept by the
 * repository's coordinator.
 */

type App = { Bindings: Env; Variables: { grant: JobGrant } };

const jobs = new Hono<App>();

const coordinator = (c: Context<App>) => (c.env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(c.var.grant.repo);

const bucket = (c: Context<App>): R2Bucket => {
	const b = c.env.CI_BUCKET;
	if (!b) throw new HttpError(503, "NO_STORAGE", "This server has no R2 bucket for Actions");
	return b;
};

const text = (c: Context<App>, body: string, status: 200 | 201 = 200) => c.body(body, status, { "content-type": "text/plain; charset=utf-8" });

async function form(c: Context<App>): Promise<URLSearchParams> {
	return new URLSearchParams(await c.req.text());
}

function size(value: string | null): number {
	const n = Number(value);
	if (!value || !Number.isInteger(n) || n < 1) throw new HttpError(400, "INVALID_INPUT", "size is a number of bytes");
	return n;
}

// Errors as plain text: the steps print them.
jobs.onError((err, c) => {
	const e = toHttpError(err);
	if (e.status >= 500) console.error(err);
	return c.body(`${e.detail}\n`, e.status as 500, { "content-type": "text/plain; charset=utf-8" });
});

jobs.use("*", async (c, next) => {
	const header = c.req.header("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	const key = c.env.MEGIT_API_KEY;
	const grant = key && token ? await verifyJobToken(key, token) : null;
	if (!grant) throw new HttpError(401, "UNAUTHORIZED", "A job token is needed (it may have expired)");
	c.set("grant", grant);
	return next();
});

// ── Caches ──────────────────────────────────────────────────────────────────

jobs.get("/caches", async (c) => {
	const keys = (c.req.query("keys") ?? "").split("\n").map((k) => k.trim());
	const hit = await coordinator(c).ciCacheLookup(c.var.grant, keys, c.req.query("version") ?? "");
	if (!hit) return c.body(null, 204);
	return text(c, `${hit.id}\t${hit.key}\t${hit.size}\n`);
});

jobs.get("/caches/:id", async (c) => {
	const key = await coordinator(c).ciCacheObject(c.var.grant, c.req.param("id"));
	const object = await bucket(c).get(key);
	if (!object) throw new HttpError(404, "NOT_FOUND", "The cache's archive is gone");
	return c.body(object.body, 200, { "content-type": "application/gzip", "content-length": String(object.size) });
});

jobs.post("/caches", async (c) => {
	const f = await form(c);
	const id = await coordinator(c).ciCacheReserve(c.var.grant, f.get("key") ?? "", f.get("version") ?? "", size(f.get("size")));
	if (!id) throw new HttpError(409, "ALREADY_EXISTS", "A cache with that key is already saved");
	return text(c, `${id}\n`, 201);
});

// ── Artifacts ───────────────────────────────────────────────────────────────

jobs.get("/artifacts", async (c) => {
	const list = await coordinator(c).ciArtifacts(c.var.grant.run);
	return text(c, list.map((a) => `${a.id}\t${a.name}\t${a.size}\n`).join(""));
});

jobs.get("/artifacts/:id", async (c) => {
	const { key } = await coordinator(c).ciArtifactObject(c.var.grant.run, c.req.param("id"));
	const object = await bucket(c).get(key);
	if (!object) throw new HttpError(404, "NOT_FOUND", "The artifact's archive is gone");
	return c.body(object.body, 200, { "content-type": "application/gzip", "content-length": String(object.size) });
});

jobs.post("/artifacts", async (c) => {
	const f = await form(c);
	const days = f.get("retention-days");
	const id = await coordinator(c).ciArtifactReserve(c.var.grant, f.get("name") ?? "", size(f.get("size")), days ? Number(days) : null, f.get("overwrite") === "true");
	return text(c, `${id}\n`, 201);
});

// ── Uploads (caches and artifacts alike) ────────────────────────────────────

for (const kind of ["caches", "artifacts"] as const) {
	jobs.put(`/${kind}/:id/parts/:n`, async (c) => {
		const n = Number(c.req.param("n"));
		if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new HttpError(400, "INVALID_INPUT", "Parts are numbered from 1 to 10000");
		const length = Number(c.req.header("content-length"));
		if (!c.req.raw.body || !Number.isInteger(length) || length < 1) throw new HttpError(411, "LENGTH_REQUIRED", "A part needs a Content-Length");
		const id = c.req.param("id");
		const target = await coordinator(c).ciUploadTarget(kind, id, c.var.grant);
		const part = await bucket(c).resumeMultipartUpload(target.key, target.uploadId).uploadPart(n, c.req.raw.body);
		await coordinator(c).ciUploadPart(kind, id, c.var.grant, part);
		return text(c, `${part.etag}\n`);
	});

	jobs.post(`/${kind}/:id/commit`, async (c) => {
		await coordinator(c).ciUploadCommit(kind, c.req.param("id"), c.var.grant);
		return text(c, "ok\n");
	});
}

// ── Actions' files ──────────────────────────────────────────────────────────

/** An action commit's files as a .tar.gz, from megit's copy in R2 (fetched from GitHub the first time). */
jobs.get("/actions/:owner/:repo/:sha", async (c) => {
	const { owner, repo, sha } = c.req.param();
	if (!/^[A-Za-z0-9-_.]+$/.test(owner) || !/^[A-Za-z0-9-_.]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(400, "INVALID_INPUT", "Not an action commit");
	const body = await new GitHubActions(c.env.CI_BUCKET).archive(owner, repo, sha);
	if (!body) throw new HttpError(404, "NOT_FOUND", `${owner}/${repo}@${sha.slice(0, 7)} isn't on GitHub`);
	return c.body(body, 200, { "content-type": "application/gzip" });
});

export default jobs;
