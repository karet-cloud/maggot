/**
 * The actions steps `use` beyond megit's own: JavaScript and composite actions, from GitHub
 * (`owner/repo[/path]@ref`) or from the repository itself (`./path`). Before a job starts, each is
 * pinned to a commit and its action.yml read, so the job runs exactly what was resolved; the files
 * themselves are downloaded onto the machine during setup, from megit, which keeps a copy of each
 * action commit in R2 (see archiveFor).
 */

import { parse } from "yaml";
import { listRefs } from "../git/protocol.ts";
import { parseCondition } from "./expr.ts";
import { MAX_ACTION_DEPTH, type ActionInput, type ActionMeta, type ResolvedAction } from "./plan.ts";
import { ACTIONS_DIR, WORKSPACE } from "./script.ts";
import { compositeSteps, WorkflowError, type ActionRef, type StepSpec } from "./workflow.ts";

/** Where actions come from: GitHub for owner/repo actions, the run's own commit for ./ ones. */
export interface ActionSource {
	/** The commit `ref` (a tag, branch or full commit hash) names in owner/repo on GitHub. */
	resolve(owner: string, repo: string, ref: string): Promise<string>;
	/** A file at a commit of owner/repo on GitHub, or null if it isn't there. */
	readGitHub(owner: string, repo: string, sha: string, path: string): Promise<string | null>;
	/** A file in the repository being built, at the run's commit, or null. */
	readLocal(path: string): Promise<string | null>;
}

const MAX_ACTION_YML = 256 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function relativeFile(value: unknown, where: string): string {
	if (typeof value !== "string" || !value.trim()) throw new WorkflowError(`${where} names the script to run`);
	const file = value.trim().replace(/^\.\//, "");
	if (file.startsWith("/") || file.split("/").includes("..")) throw new WorkflowError(`${where} is a file inside the action`);
	return file;
}

/** Reads an action.yml, as megit runs actions: JavaScript (any node version runs on Node.js 20+) or composite. */
export function parseActionMeta(source: string, where: string): ActionMeta {
	let doc: unknown;
	try {
		doc = parse(source, { version: "1.2", maxAliasCount: 50 });
	} catch (err) {
		throw new WorkflowError(`${where}: ${(err as Error).message.split("\n")[0]}`);
	}
	if (!isRecord(doc)) throw new WorkflowError(`${where} isn't an action's metadata`);
	const inputs: Record<string, ActionInput> = {};
	if (isRecord(doc.inputs)) {
		for (const [name, spec] of Object.entries(doc.inputs)) {
			const s = isRecord(spec) ? spec : {};
			const def = s.default;
			inputs[name.toLowerCase()] = {
				default: def === undefined || def === null ? null : String(def),
				required: s.required === true || s.required === "true",
			};
		}
	}
	const outputs: Record<string, string> = {};
	if (isRecord(doc.outputs)) {
		for (const [name, spec] of Object.entries(doc.outputs)) if (isRecord(spec) && spec.value !== undefined) outputs[name] = String(spec.value);
	}
	if (!isRecord(doc.runs)) throw new WorkflowError(`${where}: runs is missing`);
	const runs = doc.runs;
	const using = String(runs.using ?? "").toLowerCase();
	const name = typeof doc.name === "string" ? doc.name : where;
	if (/^node\d+$/.test(using)) {
		const cond = (v: unknown, key: string) => {
			if (v === undefined || v === null) return "always()";
			const text = String(v);
			try {
				parseCondition(text);
			} catch (err) {
				throw new WorkflowError(`${where}: runs.${key}: ${(err as Error).message}`);
			}
			return text;
		};
		return {
			name,
			inputs,
			outputs: {},
			runs: {
				using: "node",
				main: relativeFile(runs.main, `${where}: runs.main`),
				pre: runs.pre === undefined ? null : relativeFile(runs.pre, `${where}: runs.pre`),
				post: runs.post === undefined ? null : relativeFile(runs.post, `${where}: runs.post`),
				preIf: cond(runs["pre-if"], "pre-if"),
				postIf: cond(runs["post-if"], "post-if"),
			},
		};
	}
	if (using === "composite") return { name, inputs, outputs, runs: { using: "composite", steps: compositeSteps(runs.steps, `${where}: runs.steps`) } };
	if (using === "docker") throw new WorkflowError(`${where} is a Docker container action, which megit Actions can't run (JavaScript and composite actions work)`);
	throw new WorkflowError(`${where}: runs.using "${runs.using}" isn't something megit Actions can run`);
}

async function readMeta(read: (path: string) => Promise<string | null>, dir: string, where: string): Promise<ActionMeta> {
	for (const file of ["action.yml", "action.yaml"]) {
		const path = dir ? `${dir}/${file}` : file;
		const text = await read(path);
		if (text === null) continue;
		if (text.length > MAX_ACTION_YML) throw new WorkflowError(`${where}: ${path} is bigger than ${MAX_ACTION_YML / 1024} KB`);
		return parseActionMeta(text, `${where} (${path})`);
	}
	throw new WorkflowError(`${where}: there's no action.yml${dir ? ` in ${dir}` : ""}`);
}

/**
 * Resolves the actions a job's steps use (and, for composite actions, the actions their steps use),
 * step by step: null for steps that use none. `repository` names this repository, for ./ actions.
 */
export async function resolveActions(steps: StepSpec[], source: ActionSource, repository: string, depth = 0, seen = new Map<string, Promise<ResolvedAction>>()): Promise<(ResolvedAction | null)[]> {
	const out: (ResolvedAction | null)[] = [];
	for (const s of steps) {
		if (s.kind !== "action" || !s.uses) {
			out.push(null);
			continue;
		}
		if (depth >= MAX_ACTION_DEPTH) throw new WorkflowError(`${s.name}: actions use actions more than ${MAX_ACTION_DEPTH} deep`);
		out.push(await resolveOne(s.uses, s.name, source, repository, depth, seen));
	}
	return out;
}

async function resolveOne(ref: ActionRef, stepName: string, source: ActionSource, repository: string, depth: number, seen: Map<string, Promise<ResolvedAction>>): Promise<ResolvedAction> {
	const key = ref.kind === "local" ? `./${ref.path}` : `${ref.owner}/${ref.repo}/${ref.path}@${ref.ref}`;
	// The same action used twice (or by several composite actions) is resolved once and shared.
	let pending = seen.get(key);
	if (!pending) {
		pending = (async (): Promise<ResolvedAction> => {
			if (ref.kind === "local") {
				const meta = await readMeta((p) => source.readLocal(p), ref.path, `./${ref.path}`);
				const action: ResolvedAction = { meta, dir: `${WORKSPACE}/${ref.path}`, repository, ref: "", archive: null, nested: [] };
				if (meta.runs.using === "composite") action.nested = await resolveActions(meta.runs.steps, source, repository, depth + 1, seen);
				return action;
			}
			const label = `${ref.owner}/${ref.repo}${ref.path ? `/${ref.path}` : ""}@${ref.ref}`;
			let sha: string;
			try {
				sha = await source.resolve(ref.owner, ref.repo, ref.ref);
			} catch (err) {
				throw new WorkflowError(`${stepName}: ${label}: ${(err as Error).message}`);
			}
			const meta = await readMeta((p) => source.readGitHub(ref.owner, ref.repo, sha, p), ref.path, label);
			const root = `${ACTIONS_DIR}/${ref.owner}/${ref.repo}/${sha}`;
			const action: ResolvedAction = {
				meta,
				dir: ref.path ? `${root}/${ref.path}` : root,
				repository: `${ref.owner}/${ref.repo}`,
				ref: ref.ref,
				archive: { owner: ref.owner, repo: ref.repo, sha, root },
				nested: [],
			};
			if (meta.runs.using === "composite") action.nested = await resolveActions(meta.runs.steps, source, repository, depth + 1, seen);
			return action;
		})();
		seen.set(key, pending);
	}
	return pending;
}

const GITHUB = "https://github.com";

/**
 * GitHub, read the ways that need no token and aren't rate-limited like its REST API: refs over git's
 * smart HTTP, files from raw.githubusercontent.com, archives from codeload. Immutable answers (a
 * commit's files) are kept in R2, so each action commit is fetched from GitHub once.
 */
export class GitHubActions {
	private readonly bucket: R2Bucket | undefined;
	private readonly fetcher: typeof fetch;

	constructor(bucket: R2Bucket | undefined, fetcher: typeof fetch = fetch) {
		this.bucket = bucket;
		this.fetcher = fetcher;
	}

	async resolve(owner: string, repo: string, ref: string): Promise<string> {
		if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
		const { branches, tags } = await listRefs({ url: `${GITHUB}/${owner}/${repo}.git`, token: "" }).catch((err: Error) => {
			throw new Error(`couldn't read it from GitHub (${err.message}); is it a public repository?`);
		});
		// A tag first, as GitHub does when a name is both.
		const sha = tags.get(ref)?.commit ?? branches.get(ref);
		if (!sha) throw new Error(`${ref} isn't a tag or branch there (use a full commit hash for a commit)`);
		return sha;
	}

	async readFile(owner: string, repo: string, sha: string, path: string): Promise<string | null> {
		const key = `actions/${owner}/${repo}/${sha}/files/${path}`;
		const kept = await this.bucket?.get(key);
		if (kept) {
			const text = await kept.text();
			return kept.customMetadata?.missing === "1" ? null : text;
		}
		const res = await this.fetcher(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`);
		if (res.status === 404) {
			await this.bucket?.put(key, "", { customMetadata: { missing: "1" } });
			return null;
		}
		if (!res.ok) throw new Error(`reading ${path} from GitHub failed (HTTP ${res.status})`);
		const text = await res.text();
		await this.bucket?.put(key, text);
		return text;
	}

	/** The action commit's files as a .tar.gz (one top folder, as GitHub's archives have), from R2 or else GitHub. */
	async archive(owner: string, repo: string, sha: string): Promise<ReadableStream | null> {
		if (!this.bucket) throw new Error("This server has no R2 bucket for Actions (CI_BUCKET)");
		const key = archiveKey(owner, repo, sha);
		const kept = await this.bucket.get(key);
		if (kept) return kept.body;
		const res = await this.fetcher(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`);
		if (res.status === 404) return null;
		if (!res.ok || !res.body) throw new Error(`downloading ${owner}/${repo}@${sha.slice(0, 7)} from GitHub failed (HTTP ${res.status})`);
		// Kept whole in R2 first (an action is small), then served from there.
		const bytes = new Uint8Array(await res.arrayBuffer());
		await this.bucket.put(key, bytes, { httpMetadata: { contentType: "application/gzip" } });
		return new Response(bytes).body;
	}
}

export const archiveKey = (owner: string, repo: string, sha: string) => `actions/${owner}/${repo}/${sha}.tar.gz`;
