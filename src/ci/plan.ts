/**
 * A job's steps as the runner works through them: a flat list of units. Most steps are one unit, but
 * an action can add a pre unit (before the steps) and a post unit (after them, in reverse order), and
 * a composite action is an `enter` unit, its own steps' units, then an `exit`. Each unit says which of
 * the job's shown steps (`ui`) its log and status belong to: a composite action shows as one step.
 */

import type { StepSpec } from "./workflow.ts";

export interface ActionInput {
	default: string | null;
	required: boolean;
}

/** What an action's action.yml says, as megit runs it. */
export interface ActionMeta {
	name: string;
	/** By name, lower-cased (input names aren't case-sensitive). */
	inputs: Record<string, ActionInput>;
	/** Composite actions: each output's value (with `${{ }}`); JavaScript actions set theirs themselves. */
	outputs: Record<string, string>;
	runs: { using: "node"; main: string; pre: string | null; post: string | null; preIf: string; postIf: string } | { using: "composite"; steps: StepSpec[] };
}

/** An action a step uses, fetched and read. */
export interface ResolvedAction {
	meta: ActionMeta;
	/** Where its files are on the machine. */
	dir: string;
	/** owner/repo (or the repository's own name for ./ actions) and the ref asked for, for GITHUB_ACTION_*. */
	repository: string;
	ref: string;
	/** The archive to download (into `root`, which holds `dir`) during setup; null for actions in the checked-out repository. */
	archive: { owner: string; repo: string; sha: string; root: string } | null;
	/** For composite actions: the actions its own steps use, step by step (null for steps that use none). */
	nested: (ResolvedAction | null)[];
}

interface UnitBase {
	/** Index into the job's shown steps (0 is Set up job). */
	ui: number;
	/** The steps context it belongs to: "" for the job's own steps, else its composite action's. */
	scope: string;
	id: string | null;
	name: string;
	/** The condition as written. */
	if: string;
	env: Record<string, string>;
	with: Record<string, string>;
	continueOnError: boolean;
	timeoutMinutes: number | null;
}

export type Unit = UnitBase &
	(
		| { kind: "run"; run: string; shell: "bash" | "sh"; workingDirectory: string | null }
		| { kind: "checkout" }
		/** Restores a cache (actions/cache and actions/cache/restore). */
		| { kind: "cache-restore" }
		/** Saves a cache: actions/cache/save, or actions/cache's post step (`main` is its restore unit). */
		| { kind: "cache-save"; main: number | null }
		| { kind: "upload-artifact" }
		| { kind: "download-artifact" }
		/** A JavaScript action's pre, main or post script. `main` is the main unit, for pre and post. */
		| { kind: "node"; action: number; phase: "pre" | "main" | "post"; main: number | null }
		/** Starts a composite action: works out its inputs into `inner`'s scope. `end` is its exit unit. */
		| { kind: "enter"; action: number; inner: string; end: number }
		/** Ends a composite action: its outputs become the outputs of the step that used it. */
		| { kind: "exit"; action: number; inner: string; enter: number }
	);

export interface Plan {
	units: Unit[];
	/** The shown steps' names, Set up job and Complete job included. */
	ui: string[];
	/** Every action used, anywhere, by index (Unit.action). */
	actions: ResolvedAction[];
}

/** How deeply composite actions may use composite actions, as on GitHub. */
export const MAX_ACTION_DEPTH = 9;
/** Units a job may have in all, composite actions expanded: enough for any real job, and a bound on its state. */
export const MAX_UNITS = 1000;

export function buildPlan(steps: StepSpec[], resolved: (ResolvedAction | null)[]): Plan {
	const units: Unit[] = [];
	const pre: Unit[] = [];
	const post: Unit[] = [];
	const actions: ResolvedAction[] = [];
	// Shown steps: Set up job, the pre steps, the steps, the post steps, Complete job. Pre and post
	// steps aren't known until the steps are walked, so their ui numbers are fixed up afterwards.
	const mainUi: string[] = [];
	const preUi: string[] = [];
	const postUi: string[] = [];
	const base = (s: StepSpec, ui: number, scope: string): UnitBase => ({
		ui,
		scope,
		id: s.id,
		name: s.name,
		if: s.if,
		env: s.env,
		with: s.with,
		continueOnError: s.continueOnError,
		timeoutMinutes: s.timeoutMinutes,
	});
	let scopes = 0;
	const walk = (list: StepSpec[], actionsOf: (ResolvedAction | null)[], scope: string, uiOf: (i: number) => number, depth: number) => {
		for (const [i, s] of list.entries()) {
			const ui = uiOf(i);
			const b = base(s, ui, scope);
			if (s.kind === "run") units.push({ ...b, kind: "run", run: s.run ?? "", shell: s.shell, workingDirectory: s.workingDirectory });
			else if (s.kind === "checkout") units.push({ ...b, kind: "checkout" });
			else if (s.kind === "cache" || s.kind === "cache-restore") {
				const main = units.length;
				units.push({ ...b, kind: "cache-restore" });
				if (s.kind === "cache") {
					postUi.push(`Post ${s.name}`);
					// As actions/cache does: saved only when the job is succeeding (or save-always says so).
					const always = s.with["save-always"] === "true";
					post.push({ ...b, ui: -postUi.length, id: null, name: `Post ${s.name}`, if: always ? "always()" : "success()", continueOnError: true, timeoutMinutes: null, kind: "cache-save", main });
				}
			} else if (s.kind === "cache-save") units.push({ ...b, kind: "cache-save", main: null });
			else if (s.kind === "upload-artifact") units.push({ ...b, kind: "upload-artifact" });
			else if (s.kind === "download-artifact") units.push({ ...b, kind: "download-artifact" });
			else {
				const action = actionsOf[i];
				if (!action) throw new Error(`step ${s.name}: its action wasn't resolved`);
				const index = actions.push(action) - 1;
				const runs = action.meta.runs;
				if (runs.using === "node") {
					const main = units.length;
					units.push({ ...b, kind: "node", action: index, phase: "main", main: null });
					// Pre steps run only for the job's own steps, as on GitHub.
					if (runs.pre && depth === 0) {
						preUi.push(`Pre ${s.name}`);
						pre.push({ ...b, ui: -1000 - preUi.length, id: null, name: `Pre ${s.name}`, if: runs.preIf, continueOnError: s.continueOnError, kind: "node", action: index, phase: "pre", main });
					}
					if (runs.post) {
						postUi.push(`Post ${s.name}`);
						post.push({ ...b, ui: -postUi.length, id: null, name: `Post ${s.name}`, if: runs.postIf, continueOnError: true, timeoutMinutes: null, kind: "node", action: index, phase: "post", main });
					}
				} else {
					if (units.length > MAX_UNITS) throw new Error(`the job's steps and the actions they use come to more than ${MAX_UNITS} steps`);
					if (depth + 1 > MAX_ACTION_DEPTH) throw new Error(`${s.name}: composite actions nest more than ${MAX_ACTION_DEPTH} deep`);
					const inner = `${++scopes}`;
					const enter = units.length;
					units.push({ ...b, kind: "enter", action: index, inner, end: -1 });
					walk(runs.steps, action.nested, inner, () => ui, depth + 1);
					const end = units.length;
					units.push({ ...b, kind: "exit", action: index, inner, enter });
					(units[enter] as Extract<Unit, { kind: "enter" }>).end = end;
				}
			}
		}
	};
	walk(steps, resolved, "", (i) => i, 0);
	if (units.length + pre.length + post.length > MAX_UNITS) throw new Error(`the job's steps and the actions they use come to more than ${MAX_UNITS} steps`);
	for (const [i, s] of steps.entries()) mainUi[i] = s.name;
	// Number the shown steps: 0 Set up job, then pre, main, post (reversed), Complete job.
	const firstMain = 1 + preUi.length;
	for (const u of units) u.ui += firstMain;
	for (const u of pre) u.ui = 1 + (-u.ui - 1001);
	const reversed = post.reverse();
	const firstPost = firstMain + mainUi.length;
	for (const [i, u] of reversed.entries()) u.ui = firstPost + i;
	const ui = ["Set up job", ...preUi, ...mainUi, ...reversed.map((u) => u.name), "Complete job"];
	// Unit indexes (main, end, enter) refer to positions in `units`; pre units go first, so shift them.
	const shift = pre.length;
	const shifted = (u: Unit): Unit => {
		if (u.kind === "cache-save" && u.main !== null) return { ...u, main: u.main + shift };
		if (u.kind === "node" && u.main !== null) return { ...u, main: u.main + shift };
		if (u.kind === "enter") return { ...u, end: u.end + shift };
		if (u.kind === "exit") return { ...u, enter: u.enter + shift };
		return u;
	};
	return { units: [...pre, ...units, ...reversed].map(shifted), ui, actions };
}
