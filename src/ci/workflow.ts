import { parse } from "yaml";
import { patternMatches } from "../branch-rules.ts";

/**
 * megit Actions workflows: `.megit/workflows/*.yml`, a subset of GitHub Actions syntax. Jobs run `run`
 * steps in a fresh Linux sandbox (Cloudflare or Depot) after the commit is checked out; `needs` orders
 * them. Anything outside the subset is an error naming the line's key, not something silently skipped:
 * a key is only accepted if megit does what it says.
 */

export const WORKFLOW_DIR = ".megit/workflows";
export const MAX_WORKFLOWS = 20;
export const MAX_JOBS = 20;
export const MAX_STEPS = 50;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 360;

/** Where a job runs. `default` is the repository's default runner. */
export type RunnerKind = "cloudflare" | "depot" | "default";

export interface RunnerSpec {
	kind: RunnerKind;
	/** Depot only: vCPUs (2, 4, 8, 16, 32 or 64). */
	vcpus?: number;
}

/** `notCancelled` is `!cancelled()`: after success or failure, but not once the run is cancelled. */
export type StepCondition = "success" | "always" | "failure" | "cancelled" | "notCancelled";

export interface StepSpec {
	name: string;
	/** A shell script; null for `actions/checkout`, which megit does itself before the first step. */
	run: string | null;
	shell: "bash" | "sh";
	workingDirectory: string | null;
	env: Record<string, string>;
	if: StepCondition;
	continueOnError: boolean;
	/** The step's own limit (timeout-minutes); null for the job's. */
	timeoutMinutes: number | null;
	/** Checkout steps only: commits of history to fetch (with.fetch-depth); 0 is all of it. */
	fetchDepth?: number;
}

export interface JobSpec {
	key: string;
	name: string;
	runsOn: RunnerSpec;
	needs: string[];
	timeoutMinutes: number;
	env: Record<string, string>;
	steps: StepSpec[];
}

export interface BranchFilter {
	branches: string[] | null;
	branchesIgnore: string[] | null;
	/** pull_request only: the activity types that start it (opened, synchronize, reopened); null for all three. */
	types?: PullRequestType[] | null;
}

export const PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened"] as const;
export type PullRequestType = (typeof PULL_REQUEST_TYPES)[number];
/** Commits of history a checkout fetches unless a checkout step asks for another depth. */
export const DEFAULT_FETCH_DEPTH = 50;

export interface WorkflowSpec {
	name: string;
	on: {
		push: BranchFilter | null;
		pullRequest: BranchFilter | null;
		dispatch: boolean;
	};
	env: Record<string, string>;
	jobs: JobSpec[];
}

export class WorkflowError extends Error {}

const fail = (message: string): never => {
	throw new WorkflowError(message);
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, where: string): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
	return fail(`${where} is a string or a list of strings`);
}

/** Environment values are strings in the shell; numbers and booleans are written as YAML shows them. */
function envMap(value: unknown, where: string): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) return fail(`${where} is a map of names to values`);
	const out: [string, string][] = [];
	for (const [key, v] of Object.entries(value)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`${where}: ${key} isn't a valid environment variable name`);
		if (typeof v === "string") out.push([key, v]);
		else if (typeof v === "number" || typeof v === "boolean") out.push([key, String(v)]);
		else fail(`${where}.${key} is a string, number or boolean`);
	}
	// fromEntries defines own properties, so a variable called __proto__ is kept rather than setting the prototype.
	return Object.fromEntries(out);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(`${where}: "${key}" isn't supported by megit Actions (supported: ${allowed.join(", ")})`);
	}
}

function branchFilter(value: unknown, where: string, pull: boolean): BranchFilter {
	const filter: BranchFilter = { branches: null, branchesIgnore: null, ...(pull ? { types: null } : {}) };
	if (value === null || value === undefined) return filter;
	if (!isRecord(value)) return fail(`${where} is a map with branches or branches-ignore`);
	onlyKeys(value, pull ? ["branches", "branches-ignore", "types"] : ["branches", "branches-ignore"], where);
	if (value.branches !== undefined && value["branches-ignore"] !== undefined) fail(`${where} can't have both branches and branches-ignore`);
	if (value.branches !== undefined) filter.branches = strings(value.branches, `${where}.branches`);
	if (value["branches-ignore"] !== undefined) filter.branchesIgnore = strings(value["branches-ignore"], `${where}.branches-ignore`);
	if (pull && value.types !== undefined) {
		const types = strings(value.types, `${where}.types`);
		for (const t of types) {
			if (!(PULL_REQUEST_TYPES as readonly string[]).includes(t)) fail(`${where}.types: "${t}" isn't supported by megit Actions (supported: ${PULL_REQUEST_TYPES.join(", ")})`);
		}
		filter.types = [...new Set(types)] as PullRequestType[];
	}
	return filter;
}

/** Whether a pull request event of this type starts a workflow with this filter. */
export function typeAllows(filter: BranchFilter, type: PullRequestType): boolean {
	return !filter.types || filter.types.includes(type);
}

function triggers(value: unknown): WorkflowSpec["on"] {
	const on: WorkflowSpec["on"] = { push: null, pullRequest: null, dispatch: false };
	const names: Record<string, unknown> = {};
	if (typeof value === "string") names[value] = null;
	else if (Array.isArray(value)) for (const v of strings(value, "on")) names[v] = null;
	else if (isRecord(value)) Object.assign(names, value);
	else fail('"on" names the events that start the workflow: push, pull_request or workflow_dispatch');
	for (const [event, config] of Object.entries(names)) {
		if (event === "push") on.push = branchFilter(config, "on.push", false);
		else if (event === "pull_request") on.pullRequest = branchFilter(config, "on.pull_request", true);
		else if (event === "workflow_dispatch") {
			// Inputs would need a form and ${{ inputs.* }}; neither exists yet.
			if (isRecord(config) && Object.keys(config).length) fail("on.workflow_dispatch: inputs aren't supported by megit Actions yet");
			on.dispatch = true;
		}
		else fail(`on: "${event}" isn't supported by megit Actions (supported: push, pull_request, workflow_dispatch)`);
	}
	if (!on.push && !on.pullRequest && !on.dispatch) fail('"on" needs at least one event');
	return on;
}

/** `runs-on`: cloudflare, depot or depot-<vcpus>; GitHub's hosted Linux x64 labels mean "the repository's default". */
export function runnerFor(value: unknown, where: string): RunnerSpec {
	if (typeof value !== "string") return fail(`${where} is one runner label: cloudflare, depot, depot-<vcpus> or ubuntu-latest`);
	const label = value.trim().toLowerCase();
	if (label.startsWith("blacksmith")) {
		// Blacksmith only runs GitHub Actions jobs through its GitHub App; it has no API for other CI systems.
		fail(`${where}: Blacksmith runners only take jobs from GitHub Actions, so megit can't run on them (use cloudflare or depot)`);
	}
	if (/(^|-)arm(64)?$/.test(label)) fail(`${where}: megit runs jobs on x64 Linux only`);
	if (label === "cloudflare" || label === "megit") return { kind: "cloudflare" };
	if (label === "depot") return { kind: "depot", vcpus: 2 };
	const depot = /^depot-(\d+)$/.exec(label) ?? /^depot-ubuntu-[\w.]+-(\d+)$/.exec(label);
	if (depot) {
		const vcpus = Number(depot[1]);
		if (![2, 4, 8, 16, 32, 64].includes(vcpus)) fail(`${where}: Depot sandboxes come with 2, 4, 8, 16, 32 or 64 vCPUs`);
		return { kind: "depot", vcpus };
	}
	if (/^ubuntu-(latest|\d+\.\d+)$/.test(label) || label === "linux" || label === "default") return { kind: "default" };
	return fail(`${where}: "${value}" isn't a runner megit knows (use cloudflare, depot, depot-<vcpus> or ubuntu-latest)`);
}

function condition(value: unknown, where: string): StepCondition {
	if (value === undefined || value === null) return "success";
	const text = String(value)
		.trim()
		.replace(/^\$\{\{\s*(.*?)\s*\}\}$/, "$1");
	if (/^!\s*cancelled\(\)$/.test(text)) return "notCancelled";
	const match = /^(success|always|failure|cancelled)\(\)$/.exec(text);
	if (!match) fail(`${where}: megit Actions understands success(), always(), failure(), cancelled() and !cancelled(), not "${text}"`);
	return match![1] as StepCondition;
}

/** `defaults.run`: the shell and working directory steps get unless they say otherwise. */
interface RunDefaults {
	shell?: "bash" | "sh";
	workingDirectory?: string;
}

function shellOf(value: unknown, where: string): "bash" | "sh" {
	if (value !== "bash" && value !== "sh") fail(`${where} is bash or sh`);
	return value as "bash" | "sh";
}

function directory(value: unknown, where: string): string {
	if (typeof value !== "string" || !value.trim() || value.startsWith("/") || value.split("/").includes("..") || value.includes("${{")) {
		fail(`${where} is a folder inside the repository`);
	}
	return (value as string).replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
}

function runDefaults(value: unknown, where: string, outer: RunDefaults = {}): RunDefaults {
	if (value === undefined || value === null) return outer;
	if (!isRecord(value)) return fail(`${where} is a map with run`);
	onlyKeys(value, ["run"], where);
	if (!isRecord(value.run)) return fail(`${where}.run is a map with shell or working-directory`);
	onlyKeys(value.run, ["shell", "working-directory"], `${where}.run`);
	return {
		shell: value.run.shell === undefined ? outer.shell : shellOf(value.run.shell, `${where}.run.shell`),
		workingDirectory: value.run["working-directory"] === undefined ? outer.workingDirectory : directory(value.run["working-directory"], `${where}.run.working-directory`),
	};
}

function minutes(value: unknown, where: string, max = MAX_TIMEOUT_MINUTES): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) fail(`${where} is a whole number from 1 to ${max}`);
	return value as number;
}

/** `permissions` only narrows what the job's token can do; megit's is read-only already, so only reads are accepted. */
function permissions(value: unknown, where: string) {
	if (value === undefined || value === null) return;
	if (value === "read-all" || value === "{}") return;
	if (isRecord(value)) {
		for (const [scope, level] of Object.entries(value)) {
			if (level !== "read" && level !== "none") fail(`${where}.${scope}: megit Actions jobs get a read-only token, so only read or none can be asked for`);
		}
		return;
	}
	fail(`${where}: megit Actions jobs get a read-only token, so permissions is read-all or a map of scopes to read or none`);
}

/** Checks the `${{ … }}` in a value now, so a mistake shows when the workflow is listed rather than when it runs. */
function checkExpressions(text: string, where: string) {
	expand(text, { secrets: {}, github: Object.fromEntries(GITHUB_CONTEXT.map((k) => [k, ""])), env: {} }, where);
}

const CHECKOUT_WITH = ["fetch-depth", "clean", "persist-credentials"];

function checkoutStep(value: Record<string, unknown>, where: string): Pick<StepSpec, "name" | "fetchDepth"> {
	let fetchDepth = DEFAULT_FETCH_DEPTH;
	if (value.with !== undefined && value.with !== null) {
		if (!isRecord(value.with)) fail(`${where}.with is a map`);
		const w = value.with as Record<string, unknown>;
		onlyKeys(w, CHECKOUT_WITH, `${where}.with`);
		const depth = w["fetch-depth"];
		if (depth !== undefined) {
			if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) fail(`${where}.with.fetch-depth is a whole number (0 fetches all history)`);
			fetchDepth = depth as number;
		}
		// megit cleans every time (each job gets a fresh machine) and never leaves credentials behind.
		if (w.clean !== undefined && w.clean !== true) fail(`${where}.with.clean: every job starts on a fresh machine, so clean is always true`);
		if (w["persist-credentials"] !== undefined && w["persist-credentials"] !== false) fail(`${where}.with.persist-credentials: megit doesn't leave the checkout's token in .git/config; set it to false or leave it out`);
	}
	return { name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "Check out the code", fetchDepth };
}

function step(value: unknown, where: string, defaults: RunDefaults): StepSpec {
	if (!isRecord(value)) return fail(`${where} is a map with run or uses`);
	onlyKeys(value, ["name", "run", "uses", "with", "shell", "working-directory", "env", "if", "continue-on-error", "id", "timeout-minutes"], where);
	if (value.id !== undefined && (typeof value.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value.id))) fail(`${where}.id starts with a letter or _ and contains only letters, digits, - and _`);
	const continueOnError = value["continue-on-error"] ?? false;
	if (typeof continueOnError !== "boolean") fail(`${where}.continue-on-error is true or false`);
	const env = envMap(value.env, `${where}.env`);
	for (const [k, v] of Object.entries(env)) checkExpressions(v, `${where}.env.${k}`);
	const common = {
		env,
		if: condition(value.if, `${where}.if`),
		continueOnError: continueOnError as boolean,
		timeoutMinutes: value["timeout-minutes"] === undefined ? null : minutes(value["timeout-minutes"], `${where}.timeout-minutes`),
	};
	if (value.uses !== undefined) {
		if (typeof value.uses !== "string") fail(`${where}.uses names an action`);
		if (value.run !== undefined) fail(`${where} has both run and uses`);
		for (const key of ["shell", "working-directory"]) if (value[key] !== undefined) fail(`${where}.${key} is for run steps`);
		// The commit is always checked out before the first step, so checkout steps only choose its depth.
		if (/^actions\/checkout(@[\w.\-/]+)?$/.test(value.uses as string)) {
			return { ...common, ...checkoutStep(value, where), run: null, shell: "bash", workingDirectory: null };
		}
		return fail(`${where}: "uses: ${value.uses}" isn't supported yet. megit Actions runs shell steps; actions/checkout is built in`);
	}
	if (value.with !== undefined) fail(`${where}.with is for uses steps`);
	if (typeof value.run !== "string" || !value.run.trim()) return fail(`${where} needs run (a shell script) or uses: actions/checkout`);
	checkExpressions(value.run, `${where}.run`);
	const shell = value.shell === undefined ? (defaults.shell ?? "bash") : shellOf(value.shell, `${where}.shell`);
	const dir = value["working-directory"] === undefined ? (defaults.workingDirectory ?? null) : directory(value["working-directory"], `${where}.working-directory`);
	const firstLine = value.run.trim().split("\n")[0].slice(0, 80);
	return {
		...common,
		name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : `Run ${firstLine}`,
		run: value.run,
		shell,
		workingDirectory: dir === "." ? null : dir,
	};
}

function job(key: string, value: unknown, defaults: RunDefaults): JobSpec {
	const where = `jobs.${key}`;
	if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key)) fail(`${where}: job ids start with a letter or _ and contain only letters, digits, - and _`);
	if (!isRecord(value)) return fail(`${where} is a map with runs-on and steps`);
	if (value.uses !== undefined) fail(`${where}.uses: reusable workflows aren't supported by megit Actions`);
	onlyKeys(value, ["name", "runs-on", "needs", "timeout-minutes", "env", "steps", "defaults", "permissions"], where);
	permissions(value.permissions, `${where}.permissions`);
	const steps = value.steps;
	if (!Array.isArray(steps) || steps.length === 0) fail(`${where}.steps is a list with at least one step`);
	if ((steps as unknown[]).length > MAX_STEPS) fail(`${where} has more than ${MAX_STEPS} steps`);
	const timeout = value["timeout-minutes"] === undefined ? DEFAULT_TIMEOUT_MINUTES : minutes(value["timeout-minutes"], `${where}.timeout-minutes`);
	const env = envMap(value.env, `${where}.env`);
	for (const [k, v] of Object.entries(env)) checkExpressions(v, `${where}.env.${k}`);
	const jobDefaults = runDefaults(value.defaults, `${where}.defaults`, defaults);
	const parsed = (steps as unknown[]).map((s, i) => step(s, `${where}.steps[${i}]`, jobDefaults));
	for (const [i, s] of parsed.entries()) {
		if (s.timeoutMinutes !== null && s.timeoutMinutes > timeout) fail(`${where}.steps[${i}].timeout-minutes is longer than the job's ${timeout} minutes`);
	}
	return {
		key,
		name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : key,
		runsOn: runnerFor(value["runs-on"] ?? "default", `${where}.runs-on`),
		needs: value.needs === undefined ? [] : [...new Set(strings(value.needs, `${where}.needs`))],
		timeoutMinutes: timeout,
		env,
		steps: parsed,
	};
}

/** How deep a checkout goes for a job: the first checkout step's fetch-depth, or the default. */
export function fetchDepthFor(steps: Pick<StepSpec, "run" | "fetchDepth">[]): number {
	return steps.find((s) => s.run === null)?.fetchDepth ?? DEFAULT_FETCH_DEPTH;
}

/** Orders jobs so each comes after the jobs it needs; throws on unknown names and cycles. */
function checkNeeds(jobs: JobSpec[]) {
	const keys = new Set(jobs.map((j) => j.key));
	for (const j of jobs) for (const n of j.needs) if (!keys.has(n)) fail(`jobs.${j.key}.needs names "${n}", which isn't a job in this workflow`);
	const state = new Map<string, "visiting" | "done">();
	const byKey = new Map(jobs.map((j) => [j.key, j]));
	const visit = (key: string, path: string[]) => {
		if (state.get(key) === "done") return;
		if (state.get(key) === "visiting") fail(`jobs need each other in a loop: ${[...path, key].join(" → ")}`);
		state.set(key, "visiting");
		for (const n of byKey.get(key)!.needs) visit(n, [...path, key]);
		state.set(key, "done");
	};
	for (const j of jobs) visit(j.key, []);
}

/** Parses and checks one workflow file. `path` names it in error messages. */
export function parseWorkflow(source: string, path: string): WorkflowSpec {
	let doc: unknown;
	try {
		// YAML 1.2, so `on:` is a key rather than the boolean it is in YAML 1.1.
		doc = parse(source, { version: "1.2", maxAliasCount: 50, prettyErrors: true, uniqueKeys: true });
	} catch (err) {
		throw new WorkflowError(`${path}: ${(err as Error).message.split("\n")[0]}`);
	}
	try {
		if (!isRecord(doc)) fail("a workflow is a map with on and jobs");
		const top = doc as Record<string, unknown>;
		onlyKeys(top, ["name", "on", "env", "jobs", "defaults", "permissions"], "workflow");
		permissions(top.permissions, "permissions");
		const on = triggers(top.on);
		const env = envMap(top.env, "env");
		for (const [k, v] of Object.entries(env)) checkExpressions(v, `env.${k}`);
		const defaults = runDefaults(top.defaults, "defaults");
		if (!isRecord(top.jobs) || Object.keys(top.jobs).length === 0) fail("jobs is a map with at least one job");
		if (Object.keys(top.jobs as object).length > MAX_JOBS) fail(`a workflow has at most ${MAX_JOBS} jobs`);
		const jobs = Object.entries(top.jobs as Record<string, unknown>).map(([key, value]) => job(key, value, defaults));
		checkNeeds(jobs);
		const file = path.split("/").pop() ?? path;
		return {
			name: typeof top.name === "string" && top.name.trim() ? top.name.trim() : file.replace(/\.ya?ml$/, ""),
			on,
			env,
			jobs,
		};
	} catch (err) {
		if (err instanceof WorkflowError) throw new WorkflowError(`${path}: ${err.message}`);
		throw err;
	}
}

/** GitHub-style branch patterns (`*`, `**`, `?`), in order; a `!` pattern excludes what earlier ones matched. */
export function branchMatches(patterns: string[], branch: string): boolean {
	let matched = false;
	for (const raw of patterns) {
		const negate = raw.startsWith("!");
		if (patternMatches(negate ? raw.slice(1) : raw, branch)) matched = !negate;
	}
	return matched;
}

export function filterAllows(filter: BranchFilter, branch: string): boolean {
	if (filter.branches) return branchMatches(filter.branches, branch);
	if (filter.branchesIgnore) return !branchMatches(filter.branchesIgnore, branch);
	return true;
}

/** The `github.*` names a job's expressions can use (runs.ts fills in each). */
export const GITHUB_CONTEXT = [
	"sha",
	"ref",
	"ref_name",
	"ref_type",
	"head_ref",
	"base_ref",
	"repository",
	"repository_owner",
	"server_url",
	"event_name",
	"run_id",
	"run_number",
	"run_attempt",
	"actor",
	"triggering_actor",
	"workflow",
	"job",
	"workspace",
];

/** What `${{ … }}` can name when a job starts. */
export interface ExpressionContext {
	secrets: Record<string, string>;
	github: Record<string, string>;
	env: Record<string, string>;
}

/**
 * Fills in `${{ secrets.NAME }}`, `${{ github.sha }}`, `${{ env.NAME }}` and `${{ runner.os }}`.
 * Missing secrets are empty, as on GitHub; any other expression is an error rather than a silent blank.
 */
export function expand(text: string, ctx: ExpressionContext, where: string): string {
	return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => {
		const m = /^(secrets|github|env|runner)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expression);
		if (!m) throw new WorkflowError(`${where}: megit Actions understands \${{ secrets.NAME }}, \${{ github.* }}, \${{ env.NAME }} and \${{ runner.os }}, not \${{ ${expression} }}`);
		const [, scope, name] = m;
		if (scope === "runner") {
			if (name === "os") return "Linux";
			if (name === "arch") return "X64";
			throw new WorkflowError(`${where}: runner.${name} isn't available; runner.os and runner.arch are`);
		}
		// Own properties only: `secrets.constructor` is not a secret.
		const own = (values: Record<string, string>) => (Object.hasOwn(values, name) ? values[name] : undefined);
		if (scope === "secrets") {
			if (name === "GITHUB_TOKEN") throw new WorkflowError(`${where}: megit doesn't hand jobs a GITHUB_TOKEN; add a secret of your own instead`);
			return own(ctx.secrets) ?? "";
		}
		if (scope === "env") return own(ctx.env) ?? "";
		const value = own(ctx.github);
		if (value === undefined) throw new WorkflowError(`${where}: github.${name} isn't available (try sha, ref, ref_name, repository, event_name, run_id, run_number, actor, workspace)`);
		return value;
	});
}
