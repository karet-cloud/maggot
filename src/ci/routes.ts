import { Hono, type Context } from "hono";
import { requireVerified, type Principal } from "../auth.ts";
import { db, unreadableRepos, type RepoRow } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { ProjectCoordinator } from "../project.ts";
import { privateRun } from "./runs.ts";

/**
 * Actions under /api/repos/:owner/:repo/actions (and /api/projects/:project/actions). The repository
 * router's middleware has already checked access by then: reads need read access, anything else
 * write access, and settings, the Depot token and secrets admin access (see adminAction in index.ts).
 */

type App = { Bindings: Env; Variables: { principal: Principal; projectId: string; repo: RepoRow | null } };

const actions = new Hono<App>();

const project = (c: Context<App>) => (c.env.PROJECT as DurableObjectNamespace<ProjectCoordinator>).getByName(c.var.projectId);

/** Who to name as a run's actor. */
function actor(c: Context<App>): string | null {
	const p = c.var.principal;
	return p.kind === "user" ? p.username : null;
}

/** Starting runs spends the repository's runner time, so it takes a verified account (where that's required). */
function canStart(c: Context<App>) {
	requireVerified(c.env, c.var.principal);
}

function runNumber(c: Context<App>): number {
	const n = Number(c.req.param("number"));
	if (!Number.isInteger(n) || n < 1) throw new HttpError(404, "NOT_FOUND", "Run not found");
	return n;
}

/** A whole number from a query parameter, or undefined when absent. */
function optionalInt(value: string | undefined, name: string, min = 0): number | undefined {
	if (value === undefined || value === "") return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < min) throw new HttpError(400, "INVALID_INPUT", `${name} is a whole number`);
	return n;
}

/**
 * Runs among `numbers` that ran the code of another repository the caller can't read: a private fork's
 * pull request workflows. Their jobs, logs and artifacts are that fork's code and what it printed, so
 * only the fork's readers see them, approve them or re-run them; others see that they ran, and the result.
 */
async function hiddenRuns(c: Context<App>, numbers: number[]): Promise<Set<number>> {
	if (numbers.length === 0) return new Set();
	const heads = await project(c).ciRunHeads(numbers);
	if (Object.keys(heads).length === 0) return new Set();
	const p = c.var.principal;
	const unreadable = await unreadableRepos(db(c.env), Object.values(heads), { viewerId: p.kind === "user" ? p.id : null, everything: p.kind === "admin" });
	return new Set(Object.entries(heads).flatMap(([n, head]) => (unreadable.has(head) ? [Number(n)] : [])));
}

/** Refuses a run that ran a private fork's code the caller can't read (see hiddenRuns). */
async function requireRunReadable(c: Context<App>, number: number): Promise<number> {
	if ((await hiddenRuns(c, [number])).has(number)) {
		throw new HttpError(403, "HEAD_PRIVATE", "This run ran a private fork's code; only people who can read the fork see it, approve it or re-run it");
	}
	return number;
}

async function body<T>(c: Context<App>): Promise<T> {
	try {
		return (await c.req.json()) as T;
	} catch {
		throw new HttpError(400, "INVALID_INPUT", "Expected a JSON body");
	}
}

actions.get("/runs", async (c) => {
	const sha = c.req.query("sha");
	if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(400, "INVALID_INPUT", "sha is a full commit hash");
	const list = await project(c).ciRuns({
		before: optionalInt(c.req.query("before"), "before", 1),
		sha,
		pull: optionalInt(c.req.query("pull"), "pull", 1),
		workflow: c.req.query("workflow") || undefined,
		branch: c.req.query("branch") || undefined,
		limit: optionalInt(c.req.query("limit"), "limit", 1),
	});
	const hidden = await hiddenRuns(c, list.runs.map((r) => r.number));
	return c.json({ ...list, runs: list.runs.map((r) => (hidden.has(r.number) ? privateRun(r) : r)) });
});

actions.get("/runs/:number", async (c) => c.json(await project(c).ciRun(await requireRunReadable(c, runNumber(c)))));

actions.get("/runs/:number/jobs/:job/logs", async (c) =>
	c.json(await project(c).ciLogs(await requireRunReadable(c, runNumber(c)), c.req.param("job"), optionalInt(c.req.query("after"), "after"))),
);

actions.post("/runs/:number/cancel", async (c) => c.json(await project(c).ciCancel(await requireRunReadable(c, runNumber(c)))));

actions.get("/runs/:number/artifacts", async (c) => c.json({ artifacts: await project(c).ciArtifacts(await requireRunReadable(c, runNumber(c))) }));

/** An artifact's files, as the .tar.gz the job uploaded. */
actions.get("/runs/:number/artifacts/:id/download", async (c) => {
	const { key, name } = await project(c).ciArtifactObject(await requireRunReadable(c, runNumber(c)), c.req.param("id"));
	const object = await c.env.CI_BUCKET?.get(key);
	if (!object) throw new HttpError(404, "NOT_FOUND", "The artifact's files are gone");
	const file = `${name.replace(/[^\w.-]+/g, "_")}.tar.gz`;
	return c.body(object.body, 200, {
		"content-type": "application/gzip",
		"content-length": String(object.size),
		"content-disposition": `attachment; filename="${file}"`,
		"x-content-type-options": "nosniff",
	});
});

actions.delete("/runs/:number/artifacts/:id", async (c) => {
	await project(c).ciDeleteArtifact(runNumber(c), c.req.param("id"));
	return c.json({ deleted: true });
});

actions.get("/caches", async (c) => c.json({ caches: await project(c).ciCaches() }));

actions.delete("/caches/:id", async (c) => {
	await project(c).ciDeleteCache(c.req.param("id"));
	return c.json({ deleted: true });
});

actions.post("/runs/:number/rerun", async (c) => {
	canStart(c);
	return c.json(await project(c).ciRerun(await requireRunReadable(c, runNumber(c)), actor(c)), 201);
});

actions.post("/runs/:number/approve", async (c) => {
	canStart(c);
	return c.json(await project(c).ciApprove(await requireRunReadable(c, runNumber(c))));
});

actions.get("/workflows", async (c) => c.json({ workflows: await project(c).ciWorkflows(c.req.query("ref") || undefined) }));

actions.post("/dispatch", async (c) => {
	canStart(c);
	const input = await body<{ path?: unknown; ref?: unknown }>(c);
	if (typeof input.path !== "string" || !input.path) throw new HttpError(400, "INVALID_INPUT", "path names the workflow file");
	if (typeof input.ref !== "string" || !input.ref) throw new HttpError(400, "INVALID_INPUT", "ref is the branch to run it on");
	return c.json({ runs: await project(c).ciDispatch(input.path, input.ref, actor(c)) }, 201);
});

actions.get("/settings", async (c) => c.json(await project(c).ciSettings()));

actions.put("/settings", async (c) => {
	const input = await body<{ defaultRunner?: unknown }>(c);
	return c.json(await project(c).ciSetDefaultRunner(input.defaultRunner));
});

actions.put("/depot", async (c) => {
	const input = await body<{ token?: unknown; orgId?: unknown }>(c);
	return c.json(await project(c).ciSetDepot({ token: input.token, orgId: input.orgId }));
});

actions.delete("/depot", async (c) => c.json(await project(c).ciRemoveDepot()));

actions.put("/secrets/:name", async (c) => {
	const input = await body<{ value?: unknown }>(c);
	return c.json(await project(c).ciSetSecret(c.req.param("name"), input.value));
});

actions.delete("/secrets/:name", async (c) => c.json(await project(c).ciDeleteSecret(c.req.param("name"))));

export default actions;
