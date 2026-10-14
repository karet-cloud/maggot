import { parse } from "yaml";
import { patternMatches } from "../branch-rules.ts";
import { parseCron } from "./cron.ts";
import { ExpressionError, parseCondition, parseTemplate, propertiesOf, render, STATUS_FUNCTIONS, usage, type Expression, type Value } from "./expr.ts";

/**
 * megit Actions workflows: `.megit/workflows/*.yml`, GitHub Actions syntax. Jobs run steps in a fresh
 * Linux sandbox (Cloudflare or Depot) after the commit is checked out; `needs` orders them, and a
 * matrix makes one job of each combination. Steps are shell scripts, the built-in checkout, cache and
 * artifact actions, or other actions (JavaScript or composite) fetched from GitHub or the repository.
 * Anything outside what megit does is an error naming the line's key, not something silently skipped:
 * a key is only accepted if megit does what it says.
 */

export const WORKFLOW_DIR = ".megit/workflows";
export const MAX_WORKFLOWS = 20;
/** Jobs as written, and jobs once each matrix is expanded. */
export const MAX_JOBS = 50;
export const MAX_EXPANDED_JOBS = 256;
export const MAX_STEPS = 50;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 360;
/** The shortest gap between scheduled runs, as on GitHub. */
export const MIN_SCHEDULE_MINUTES = 5;

/** Where a job runs. `default` is the repository's default runner. */
export type RunnerKind = "cloudflare" | "depot" | "default";

export interface RunnerSpec {
	kind: RunnerKind;
	/** Depot only: vCPUs (2, 4, 8, 16, 32 or 64). */
	vcpus?: number;
}

/**
 * What a step does. checkout, cache (and its restore and save halves) and the artifact actions are
 * megit's own; `action` is any other action, run from its own files.
 */
export type StepKind = "run" | "checkout" | "cache" | "cache-restore" | "cache-save" | "upload-artifact" | "download-artifact" | "action";

/** An action another step `uses`: on GitHub (owner/repo, maybe a folder in it, at a ref) or in this repository (./path). */
export type ActionRef = { kind: "github"; owner: string; repo: string; path: string; ref: string } | { kind: "local"; path: string };

export interface StepSpec {
	kind: StepKind;
	/** The step's `id`, for steps.<id>.outputs; null when it has none. */
	id: string | null;
	/** May hold `${{ }}`, filled in when the step runs. */
	name: string;
	/** A shell script (with `${{ }}` left in, filled in when the step runs); null for every kind but run. */
	run: string | null;
	/** The action, for kind `action`. */
	uses: ActionRef | null;
	/** `with:`, values as written (with `${{ }}` left in). */
	with: Record<string, string>;
	shell: "bash" | "sh";
	workingDirectory: string | null;
	/** Values as written (with `${{ }}` left in). */
	env: Record<string, string>;
	/** The condition as written; "success()" when there's none. */
	if: string;
	continueOnError: boolean;
	/** The step's own limit (timeout-minutes); null for the job's. */
	timeoutMinutes: number | null;
	/** Checkout steps only: commits of history to fetch (with.fetch-depth); 0 is all of it. */
	fetchDepth?: number;
}

export interface JobSpec {
	/** Unique in the workflow: the job's id, or `<id>.<n>` for the nth combination of its matrix. */
	key: string;
	/** The job's id as written (the same for every combination of a matrix): what `needs` names. */
	group: string;
	name: string;
	runsOn: RunnerSpec;
	/** Keys of the jobs this one waits for (every combination of a matrix job it names). */
	needs: string[];
	/** The ids as written, for the needs context. */
	needsGroups: string[];
	/** The condition as written; "success()" when there's none. */
	if: string;
	timeoutMinutes: number;
	/** Values as written (with `${{ }}` left in). */
	env: Record<string, string>;
	/** `outputs:`, values as written, filled in when the job ends. */
	outputs: Record<string, string>;
	/** This combination's matrix values; null for a job without a matrix. */
	matrix: Record<string, Value> | null;
	strategy: { failFast: boolean; maxParallel: number | null; index: number; total: number };
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
		/** Cron schedules (UTC), run on the default branch. */
		schedule: string[];
	};
	/** Values as written (with `${{ }}` left in). */
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

/** A scalar as YAML shows it: environment values and inputs are strings in the end. */
function scalarText(value: unknown, where: string): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fail(`${where} is a string, number or boolean`);
}

/** Environment values are strings in the shell; numbers and booleans are written as YAML shows them. */
function envMap(value: unknown, where: string, contexts: readonly string[]): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) return fail(`${where} is a map of names to values`);
	const out: [string, string][] = [];
	for (const [key, v] of Object.entries(value)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`${where}: ${key} isn't a valid environment variable name`);
		const text = scalarText(v, `${where}.${key}`);
		checkTemplate(text, `${where}.${key}`, contexts);
		out.push([key, text]);
	}
	// fromEntries defines own properties, so a variable called __proto__ is kept rather than setting the prototype.
	return Object.fromEntries(out);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(`${where}: "${key}" isn't supported by megit Actions (supported: ${allowed.join(", ")})`);
	}
}

// ── Expressions ──────────────────────────────────────────────────────────────

/** The contexts each place may use, as on GitHub (vars and workflow inputs aren't in megit yet). */
const AT = {
	workflowEnv: ["github", "secrets", "inputs"],
	jobIf: ["github", "needs", "inputs"],
	jobName: ["matrix", "strategy"],
	jobEnv: ["github", "needs", "strategy", "matrix", "secrets", "inputs"],
	jobOutputs: ["github", "needs", "strategy", "matrix", "job", "runner", "env", "secrets", "steps", "inputs"],
	step: ["github", "needs", "strategy", "matrix", "job", "runner", "env", "secrets", "steps", "inputs"],
} as const;

const KNOWN_CONTEXTS = ["github", "env", "secrets", "matrix", "steps", "needs", "job", "runner", "inputs", "strategy", "vars"];

function checkUsage(nodes: Expression[], where: string, contexts: readonly string[], opts: { status?: boolean; hashFiles?: boolean } = {}) {
	for (const node of nodes) {
		const used = usage(node);
		for (const c of used.contexts) {
			if (c === "vars") fail(`${where}: vars isn't in megit yet; use env or secrets`);
			if (!KNOWN_CONTEXTS.includes(c)) fail(`${where}: ${c} isn't a context (${KNOWN_CONTEXTS.filter((k) => k !== "vars").join(", ")} are)`);
			if (!contexts.includes(c)) fail(`${where}: ${c} can't be used here (${contexts.join(", ")} can)`);
		}
		for (const f of used.functions) {
			if (STATUS_FUNCTIONS.includes(f) && !opts.status) fail(`${where}: ${f}() can only be used in if:`);
			if (f === "hashFiles" && !opts.hashFiles) fail(`${where}: hashFiles() can only be used in steps`);
		}
		// The secret GitHub hands every job; megit hands none.
		if (propertiesOf(node, "secrets").some((name) => name.toUpperCase() === "GITHUB_TOKEN")) {
			fail(`${where}: megit doesn't hand jobs a GITHUB_TOKEN; add a secret of your own instead`);
		}
	}
}

/** Checks the `${{ … }}` in a value now, so a mistake shows when the workflow is listed rather than when it runs. */
function checkTemplate(text: string, where: string, contexts: readonly string[], opts: { hashFiles?: boolean } = {}) {
	try {
		checkUsage(
			parseTemplate(text).filter((p): p is Expression => typeof p !== "string"),
			where,
			contexts,
			opts,
		);
	} catch (err) {
		if (err instanceof ExpressionError) fail(`${where}: ${err.message}`);
		throw err;
	}
}

function condition(value: unknown, where: string, contexts: readonly string[], hashFiles = false): string {
	if (value === undefined || value === null) return "success()";
	const text = scalarText(value, where).trim();
	if (!text) return "success()";
	try {
		checkUsage([parseCondition(text)], where, contexts, { status: true, hashFiles });
	} catch (err) {
		if (err instanceof ExpressionError) fail(`${where}: ${err.message}`);
		throw err;
	}
	return text;
}

// ── Triggers ─────────────────────────────────────────────────────────────────

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

function schedules(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) return fail("on.schedule is a list of { cron: '…' }");
	if (value.length > 10) fail("on.schedule has at most 10 schedules");
	return value.map((entry, i) => {
		const where = `on.schedule[${i}]`;
		if (!isRecord(entry)) return fail(`${where} is { cron: '…' }`);
		onlyKeys(entry, ["cron"], where);
		if (typeof entry.cron !== "string") return fail(`${where}.cron is a cron expression, like '30 5 * * 1-5'`);
		try {
			const cron = parseCron(entry.cron);
			if (cron.minGapMinutes < MIN_SCHEDULE_MINUTES) fail(`${where}.cron: scheduled runs are at least ${MIN_SCHEDULE_MINUTES} minutes apart`);
		} catch (err) {
			if (err instanceof WorkflowError) throw err;
			fail(`${where}.cron: ${(err as Error).message}`);
		}
		return entry.cron.trim();
	});
}

function triggers(value: unknown): WorkflowSpec["on"] {
	const on: WorkflowSpec["on"] = { push: null, pullRequest: null, dispatch: false, schedule: [] };
	const names: Record<string, unknown> = {};
	if (typeof value === "string") names[value] = null;
	else if (Array.isArray(value)) for (const v of strings(value, "on")) names[v] = null;
	else if (isRecord(value)) Object.assign(names, value);
	else fail('"on" names the events that start the workflow: push, pull_request, workflow_dispatch or schedule');
	for (const [event, config] of Object.entries(names)) {
		if (event === "push") on.push = branchFilter(config, "on.push", false);
		else if (event === "pull_request") on.pullRequest = branchFilter(config, "on.pull_request", true);
		else if (event === "workflow_dispatch") {
			// Inputs would need a form and ${{ inputs.* }}; neither exists yet.
			if (isRecord(config) && Object.keys(config).length) fail("on.workflow_dispatch: inputs aren't supported by megit Actions yet");
			on.dispatch = true;
		} else if (event === "schedule") on.schedule = schedules(config);
		else fail(`on: "${event}" isn't supported by megit Actions (supported: push, pull_request, workflow_dispatch, schedule)`);
	}
	if (!on.push && !on.pullRequest && !on.dispatch && on.schedule.length === 0) fail('"on" needs at least one event');
	return on;
}

// ── Jobs and steps ───────────────────────────────────────────────────────────

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

/** The `with:` each built-in action takes, and which of them it needs. */
const BUILT_IN: Record<Exclude<StepKind, "run" | "action">, { pattern: RegExp; inputs: string[]; required: string[] }> = {
	checkout: { pattern: /^actions\/checkout$/, inputs: ["fetch-depth", "clean", "persist-credentials"], required: [] },
	cache: {
		pattern: /^actions\/cache$/,
		inputs: ["key", "path", "restore-keys", "enableCrossOsArchive", "fail-on-cache-miss", "lookup-only", "upload-chunk-size", "save-always"],
		required: ["key", "path"],
	},
	"cache-restore": { pattern: /^actions\/cache\/restore$/, inputs: ["key", "path", "restore-keys", "enableCrossOsArchive", "fail-on-cache-miss", "lookup-only"], required: ["key", "path"] },
	"cache-save": { pattern: /^actions\/cache\/save$/, inputs: ["key", "path", "upload-chunk-size", "enableCrossOsArchive"], required: ["key", "path"] },
	"upload-artifact": {
		pattern: /^actions\/upload-artifact$/,
		inputs: ["name", "path", "if-no-files-found", "retention-days", "compression-level", "overwrite", "include-hidden-files"],
		required: ["path"],
	},
	"download-artifact": { pattern: /^actions\/download-artifact$/, inputs: ["name", "path", "pattern", "merge-multiple"], required: [] },
};

/** Parses `uses:`: a built-in action, an action in this repository (./path) or one on GitHub (owner/repo[/path]@ref). */
export function parseUses(value: string, where: string): { kind: StepKind; ref: ActionRef | null } {
	const uses = value.trim();
	if (uses.startsWith("docker://")) return fail(`${where}: Docker container actions aren't supported by megit Actions`);
	if (uses.startsWith("./")) {
		const path = uses.slice(2).replace(/\/+$/, "");
		if (!path || path.split("/").some((p) => p === ".." || p === "") || uses.includes("${{")) fail(`${where}: "${uses}" isn't a folder in the repository`);
		return { kind: "action", ref: { kind: "local", path } };
	}
	const m = /^([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)((?:\/[A-Za-z0-9-_.]+)*)@([A-Za-z0-9-_./]+)$/.exec(uses);
	if (!m) return fail(`${where}: "uses: ${uses}" names an action as owner/repo@ref, owner/repo/path@ref or ./path`);
	const [, owner, repo, sub, ref] = m;
	if (sub.split("/").includes("..") || ref.split("/").includes("..")) fail(`${where}: "${uses}" isn't an action`);
	const name = `${owner}/${repo}${sub}`.toLowerCase();
	for (const [kind, b] of Object.entries(BUILT_IN)) if (b.pattern.test(name)) return { kind: kind as StepKind, ref: null };
	return { kind: "action", ref: { kind: "github", owner, repo, path: sub.replace(/^\//, ""), ref } };
}

function withMap(value: unknown, where: string, contexts: readonly string[]): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) return fail(`${where} is a map of inputs`);
	const out: [string, string][] = [];
	for (const [k, v] of Object.entries(value)) {
		const text = scalarText(v, `${where}.${k}`);
		checkTemplate(text, `${where}.${k}`, contexts, { hashFiles: true });
		out.push([k, text]);
	}
	return Object.fromEntries(out);
}

function checkoutInputs(w: Record<string, string>, where: string): number {
	let fetchDepth = DEFAULT_FETCH_DEPTH;
	const depth = w["fetch-depth"];
	if (depth !== undefined) {
		if (!/^\d+$/.test(depth.trim())) fail(`${where}.with.fetch-depth is a whole number (0 fetches all history)`);
		fetchDepth = Number(depth);
	}
	// megit cleans every time (each job gets a fresh machine) and never leaves credentials behind.
	if (w.clean !== undefined && w.clean !== "true") fail(`${where}.with.clean: every job starts on a fresh machine, so clean is always true`);
	if (w["persist-credentials"] !== undefined && w["persist-credentials"] !== "false") {
		fail(`${where}.with.persist-credentials: megit doesn't leave the checkout's token in .git/config; set it to false or leave it out`);
	}
	return fetchDepth;
}

function step(value: unknown, where: string, defaults: RunDefaults, contexts: readonly string[] = AT.step, composite = false): StepSpec {
	if (!isRecord(value)) return fail(`${where} is a map with run or uses`);
	onlyKeys(value, ["name", "run", "uses", "with", "shell", "working-directory", "env", "if", "continue-on-error", "id", "timeout-minutes"], where);
	if (value.id !== undefined && (typeof value.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value.id))) fail(`${where}.id starts with a letter or _ and contains only letters, digits, - and _`);
	const continueOnError = value["continue-on-error"] ?? false;
	if (typeof continueOnError !== "boolean") fail(`${where}.continue-on-error is true or false`);
	if (value.name !== undefined) checkTemplate(scalarText(value.name, `${where}.name`), `${where}.name`, contexts);
	const common = {
		id: (value.id as string | undefined) ?? null,
		env: envMap(value.env, `${where}.env`, contexts),
		if: condition(value.if, `${where}.if`, contexts, true),
		continueOnError: continueOnError as boolean,
		timeoutMinutes: value["timeout-minutes"] === undefined ? null : minutes(value["timeout-minutes"], `${where}.timeout-minutes`),
	};
	const named = (fallback: string) => (typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallback);
	if (value.uses !== undefined) {
		if (typeof value.uses !== "string") fail(`${where}.uses names an action`);
		if (value.run !== undefined) fail(`${where} has both run and uses`);
		for (const key of ["shell", "working-directory"]) if (value[key] !== undefined) fail(`${where}.${key} is for run steps`);
		const uses = (value.uses as string).trim();
		const { kind, ref } = parseUses(uses, `${where}.uses`);
		const w = withMap(value.with, `${where}.with`, contexts);
		const base = { ...common, run: null, uses: ref, with: w, shell: "bash" as const, workingDirectory: null };
		if (kind === "action") return { ...base, kind, name: named(`Run ${uses}`) };
		const builtIn = BUILT_IN[kind as keyof typeof BUILT_IN];
		onlyKeys(w, builtIn.inputs, `${where}.with`);
		for (const r of builtIn.required) if (!w[r]?.trim()) fail(`${where}.with.${r} is required`);
		if (kind === "checkout") return { ...base, kind, name: named("Check out the code"), fetchDepth: checkoutInputs(w, where) };
		if (kind === "upload-artifact" && w["if-no-files-found"] !== undefined && !["warn", "error", "ignore"].includes(w["if-no-files-found"])) {
			fail(`${where}.with.if-no-files-found is warn, error or ignore`);
		}
		if (kind === "upload-artifact" && w["retention-days"] !== undefined && !/^\d+$/.test(w["retention-days"])) fail(`${where}.with.retention-days is a number of days`);
		return { ...base, kind, name: named(`Run ${uses}`) };
	}
	if (value.with !== undefined) fail(`${where}.with is for uses steps`);
	if (typeof value.run !== "string" || !value.run.trim()) return fail(`${where} needs run (a shell script) or uses (an action)`);
	checkTemplate(value.run, `${where}.run`, contexts, { hashFiles: true });
	// A composite action's run steps say their shell, as GitHub requires.
	if (composite && value.shell === undefined) fail(`${where}.shell is required in a composite action (bash or sh)`);
	const shell = value.shell === undefined ? (defaults.shell ?? "bash") : shellOf(value.shell, `${where}.shell`);
	const dir = value["working-directory"] === undefined ? (defaults.workingDirectory ?? null) : directory(value["working-directory"], `${where}.working-directory`);
	const firstLine = value.run.trim().split("\n")[0].slice(0, 80);
	return {
		...common,
		kind: "run",
		name: named(`Run ${firstLine}`),
		run: value.run,
		uses: null,
		with: {},
		shell,
		workingDirectory: dir === "." ? null : dir,
	};
}

// ── Matrix ───────────────────────────────────────────────────────────────────

function matrixValue(value: unknown, where: string): Value {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((v, i) => matrixValue(v, `${where}[${i}]`));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, matrixValue(v, `${where}.${k}`)]));
	return fail(`${where} isn't a value a matrix can hold`);
}

const sameValue = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The combinations of a `strategy.matrix`, as GitHub makes them: every combination of the lists, less
 * those an `exclude` entry matches, then each `include` entry added to every combination it doesn't
 * change a value of (or as a combination of its own where it fits none).
 */
export function expandMatrix(value: unknown, where: string): Record<string, Value>[] {
	if (typeof value === "string") return fail(`${where}: a matrix built by an expression isn't supported by megit Actions; list its values`);
	if (!isRecord(value)) return fail(`${where} is a map of names to lists of values`);
	const lists: [string, Value[]][] = [];
	for (const [key, v] of Object.entries(value)) {
		if (key === "include" || key === "exclude") continue;
		if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) fail(`${where}: "${key}" isn't a valid matrix name`);
		if (!Array.isArray(v) || v.length === 0) fail(`${where}.${key} is a list with at least one value`);
		lists.push([key, (v as unknown[]).map((x, i) => matrixValue(x, `${where}.${key}[${i}]`))]);
	}
	const entries = (key: "include" | "exclude"): Record<string, Value>[] => {
		const v = value[key];
		if (v === undefined || v === null) return [];
		if (!Array.isArray(v)) return fail(`${where}.${key} is a list of maps`);
		return v.map((e, i) => {
			if (!isRecord(e) || Object.keys(e).length === 0) return fail(`${where}.${key}[${i}] is a map of matrix values`);
			return matrixValue(e, `${where}.${key}[${i}]`) as Record<string, Value>;
		});
	};
	let combos: Record<string, Value>[] = lists.length ? [{}] : [];
	for (const [key, values] of lists) {
		combos = combos.flatMap((c) => values.map((v) => ({ ...c, [key]: v })));
		if (combos.length > MAX_EXPANDED_JOBS) fail(`${where} makes more than ${MAX_EXPANDED_JOBS} jobs`);
	}
	const excludes = entries("exclude");
	combos = combos.filter((c) => !excludes.some((e) => Object.entries(e).every(([k, v]) => Object.hasOwn(c, k) && sameValue(c[k], v))));
	const original = new Set(lists.map(([k]) => k));
	const base = combos.map((c) => ({ ...c }));
	for (const inc of entries("include")) {
		let added = false;
		// Only the original combinations are matched, not ones an include added.
		for (let i = 0; i < base.length; i++) {
			const c = combos[i];
			// It fits a combination if every original value it names is that combination's.
			const fits = Object.entries(inc).every(([k, v]) => !original.has(k) || sameValue(base[i][k], v));
			if (!fits) continue;
			// Original values stay; values an earlier include added may be overwritten, as on GitHub.
			Object.assign(c, Object.fromEntries(Object.entries(inc).filter(([k]) => !original.has(k) || sameValue(c[k], inc[k]))));
			added = true;
		}
		if (!added) combos.push({ ...inc });
	}
	if (combos.length === 0) fail(`${where} makes no jobs (exclude removed every combination)`);
	if (combos.length > MAX_EXPANDED_JOBS) fail(`${where} makes more than ${MAX_EXPANDED_JOBS} jobs`);
	return combos;
}

function strategyOf(value: unknown, where: string): { combos: Record<string, Value>[] | null; failFast: boolean; maxParallel: number | null } {
	if (value === undefined || value === null) return { combos: null, failFast: true, maxParallel: null };
	if (!isRecord(value)) return fail(`${where} is a map with matrix, fail-fast or max-parallel`);
	onlyKeys(value, ["matrix", "fail-fast", "max-parallel"], where);
	const failFast = value["fail-fast"] ?? true;
	if (typeof failFast !== "boolean") fail(`${where}.fail-fast is true or false`);
	const maxParallel = value["max-parallel"] === undefined ? null : value["max-parallel"];
	if (maxParallel !== null && (typeof maxParallel !== "number" || !Number.isInteger(maxParallel) || maxParallel < 1)) fail(`${where}.max-parallel is a whole number from 1`);
	return { combos: value.matrix === undefined ? null : expandMatrix(value.matrix, `${where}.matrix`), failFast: failFast as boolean, maxParallel: maxParallel as number | null };
}

/** The name GitHub gives a combination's job: the job's name, then the combination's values. */
function comboLabel(combo: Record<string, Value>): string {
	const parts = Object.values(combo).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)));
	return parts.join(", ");
}

/** Fills in a job's name or runs-on for one combination (matrix and strategy only). */
function forCombo(text: string, where: string, combo: Record<string, Value> | null, strategy: JobSpec["strategy"]): string {
	try {
		return render(parseTemplate(text), {
			contexts: {
				matrix: combo ?? {},
				strategy: { "fail-fast": strategy.failFast, "max-parallel": strategy.maxParallel ?? strategy.total, "job-index": strategy.index, "job-total": strategy.total },
			},
		});
	} catch (err) {
		if (err instanceof ExpressionError) fail(`${where}: ${err.message}`);
		throw err;
	}
}

function jobs(key: string, value: unknown, defaults: RunDefaults): JobSpec[] {
	const where = `jobs.${key}`;
	if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key)) fail(`${where}: job ids start with a letter or _ and contain only letters, digits, - and _`);
	if (!isRecord(value)) return fail(`${where} is a map with runs-on and steps`);
	if (value.uses !== undefined) fail(`${where}.uses: reusable workflows aren't supported by megit Actions`);
	onlyKeys(value, ["name", "runs-on", "needs", "if", "timeout-minutes", "env", "outputs", "steps", "defaults", "permissions", "strategy"], where);
	permissions(value.permissions, `${where}.permissions`);
	const steps = value.steps;
	if (!Array.isArray(steps) || steps.length === 0) fail(`${where}.steps is a list with at least one step`);
	if ((steps as unknown[]).length > MAX_STEPS) fail(`${where} has more than ${MAX_STEPS} steps`);
	const timeout = value["timeout-minutes"] === undefined ? DEFAULT_TIMEOUT_MINUTES : minutes(value["timeout-minutes"], `${where}.timeout-minutes`);
	const env = envMap(value.env, `${where}.env`, AT.jobEnv);
	const jobDefaults = runDefaults(value.defaults, `${where}.defaults`, defaults);
	const parsed = (steps as unknown[]).map((s, i) => step(s, `${where}.steps[${i}]`, jobDefaults));
	for (const [i, s] of parsed.entries()) {
		if (s.timeoutMinutes !== null && s.timeoutMinutes > timeout) fail(`${where}.steps[${i}].timeout-minutes is longer than the job's ${timeout} minutes`);
	}
	const ids = parsed.map((s) => s.id).filter((id): id is string => id !== null);
	const dup = ids.find((id, i) => ids.indexOf(id) !== i);
	if (dup) fail(`${where}: two steps have the id ${dup}`);
	let outputs: Record<string, string> = {};
	if (value.outputs !== undefined && value.outputs !== null) {
		if (!isRecord(value.outputs)) fail(`${where}.outputs is a map of names to values`);
		outputs = Object.fromEntries(
			Object.entries(value.outputs as Record<string, unknown>).map(([k, v]) => {
				if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) fail(`${where}.outputs: "${k}" isn't a valid output name`);
				const text = scalarText(v, `${where}.outputs.${k}`);
				checkTemplate(text, `${where}.outputs.${k}`, AT.jobOutputs);
				return [k, text];
			}),
		);
	}
	const needsGroups = value.needs === undefined ? [] : [...new Set(strings(value.needs, `${where}.needs`))];
	const ifText = condition(value.if, `${where}.if`, AT.jobIf);
	const strategy = strategyOf(value.strategy, `${where}.strategy`);
	const combos = strategy.combos ?? [null];
	const nameText = typeof value.name === "string" && value.name.trim() ? value.name.trim() : null;
	if (nameText) checkTemplate(nameText, `${where}.name`, AT.jobName);
	const runsOnText = value["runs-on"] ?? "default";
	if (typeof runsOnText === "string") checkTemplate(runsOnText, `${where}.runs-on`, AT.jobName);
	return combos.map((combo, index) => {
		const strat = { failFast: strategy.failFast, maxParallel: strategy.maxParallel, index, total: combos.length };
		const label = combo ? comboLabel(combo) : "";
		// A matrix job's name has its values unless the name already names some of them.
		const name = nameText ? forCombo(nameText, `${where}.name`, combo, strat) : key;
		const shown = combo && !(nameText && /\$\{\{/.test(nameText)) ? `${name} (${label})` : name;
		return {
			key: combo ? `${key}.${index + 1}` : key,
			group: key,
			name: shown,
			runsOn: runnerFor(typeof runsOnText === "string" ? forCombo(runsOnText, `${where}.runs-on`, combo, strat) : runsOnText, `${where}.runs-on`),
			needs: needsGroups,
			needsGroups,
			if: ifText,
			timeoutMinutes: timeout,
			env,
			outputs,
			matrix: combo,
			strategy: strat,
			steps: parsed,
		};
	});
}

/** What a composite action's steps may use: no secrets, and its own inputs. */
const COMPOSITE = ["github", "needs", "strategy", "matrix", "job", "runner", "env", "steps", "inputs"];

/** A composite action's `runs.steps`. */
export function compositeSteps(value: unknown, where: string): StepSpec[] {
	if (!Array.isArray(value) || value.length === 0) return fail(`${where} is a list with at least one step`);
	if (value.length > MAX_STEPS) fail(`${where} has more than ${MAX_STEPS} steps`);
	const steps = value.map((s, i) => step(s, `${where}[${i}]`, {}, COMPOSITE, true));
	for (const [i, s] of steps.entries()) {
		if (s.kind === "checkout") fail(`${where}[${i}]: actions/checkout can't be used inside an action; the job checks the commit out before its steps`);
	}
	return steps;
}

/** How deep a checkout goes for a job: the first checkout step's fetch-depth, or the default. */
export function fetchDepthFor(steps: Pick<StepSpec, "kind" | "fetchDepth">[]): number {
	return steps.find((s) => s.kind === "checkout")?.fetchDepth ?? DEFAULT_FETCH_DEPTH;
}

/** Checks `needs` names jobs and has no loops, then points each job's needs at every key of the jobs it names. */
function linkNeeds(all: JobSpec[]) {
	const keysOf = new Map<string, string[]>();
	for (const j of all) keysOf.set(j.group, [...(keysOf.get(j.group) ?? []), j.key]);
	for (const j of all) for (const n of j.needsGroups) if (!keysOf.has(n)) fail(`jobs.${j.group}.needs names "${n}", which isn't a job in this workflow`);
	const state = new Map<string, "visiting" | "done">();
	const needsOf = new Map(all.map((j) => [j.group, j.needsGroups]));
	const visit = (group: string, path: string[]) => {
		if (state.get(group) === "done") return;
		if (state.get(group) === "visiting") fail(`jobs need each other in a loop: ${[...path, group].join(" → ")}`);
		state.set(group, "visiting");
		for (const n of needsOf.get(group)!) visit(n, [...path, group]);
		state.set(group, "done");
	};
	for (const j of all) visit(j.group, []);
	for (const j of all) j.needs = j.needsGroups.flatMap((g) => keysOf.get(g)!);
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
		const env = envMap(top.env, "env", AT.workflowEnv);
		const defaults = runDefaults(top.defaults, "defaults");
		if (!isRecord(top.jobs) || Object.keys(top.jobs).length === 0) fail("jobs is a map with at least one job");
		if (Object.keys(top.jobs as object).length > MAX_JOBS) fail(`a workflow has at most ${MAX_JOBS} jobs`);
		const all = Object.entries(top.jobs as Record<string, unknown>).flatMap(([key, value]) => jobs(key, value, defaults));
		if (all.length > MAX_EXPANDED_JOBS) fail(`the workflow makes more than ${MAX_EXPANDED_JOBS} jobs once its matrices are expanded`);
		linkNeeds(all);
		const file = path.split("/").pop() ?? path;
		return {
			name: typeof top.name === "string" && top.name.trim() ? top.name.trim() : file.replace(/\.ya?ml$/, ""),
			on,
			env,
			jobs: all,
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

/** Every template in a job (workflow env included), for finding the secrets it uses. */
export function jobTexts(workflow: WorkflowSpec, job: JobSpec): string[] {
	return [
		...Object.values(workflow.env),
		...Object.values(job.env),
		...Object.values(job.outputs),
		...job.steps.flatMap((s) => [s.name, s.if, s.run ?? "", ...Object.values(s.env), ...Object.values(s.with)]),
	];
}
