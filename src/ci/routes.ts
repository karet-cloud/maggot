import { Hono, type Context } from "hono";
import { requireVerified, type Principal } from "../auth.ts";
import type { RepoRow } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { ProjectCoordinator } from "../project.ts";

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
	return c.json(
		await project(c).ciRuns({
			before: optionalInt(c.req.query("before"), "before", 1),
			sha,
			pull: optionalInt(c.req.query("pull"), "pull", 1),
			workflow: c.req.query("workflow") || undefined,
			branch: c.req.query("branch") || undefined,
			limit: optionalInt(c.req.query("limit"), "limit", 1),
		}),
	);
});

actions.get("/runs/:number", async (c) => c.json(await project(c).ciRun(runNumber(c))));

actions.get("/runs/:number/jobs/:job/logs", async (c) => c.json(await project(c).ciLogs(runNumber(c), c.req.param("job"), optionalInt(c.req.query("after"), "after"))));

actions.post("/runs/:number/cancel", async (c) => c.json(await project(c).ciCancel(runNumber(c))));

actions.post("/runs/:number/rerun", async (c) => {
	canStart(c);
	return c.json(await project(c).ciRerun(runNumber(c), actor(c)), 201);
});

actions.post("/runs/:number/approve", async (c) => {
	canStart(c);
	return c.json(await project(c).ciApprove(runNumber(c)));
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
