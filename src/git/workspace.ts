import git, { TREE, type HttpClient } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs.ts";

export interface RemoteAccess {
	url: string;
	/** Full Artifacts token (`art_v1_<secret>?expires=<unix>`); only the secret is sent. */
	token: string;
}

export interface Identity {
	name: string;
	email: string;
}

export type MergeOutcome =
	| { kind: "merged"; oid: string; fastForward: boolean; changedFiles: string[] }
	| { kind: "up-to-date"; oid: string }
	| { kind: "conflict"; files: string[]; changedFiles: string[] };

const DIR = "/repo";

/**
 * How many commits of a branch a new workspace fetches, and how far `merge` deepens the fetch when the
 * merge base isn't within that (then the whole history). A merge only needs history back to the merge
 * base, and a full clone of a long-lived repository in memory takes seconds of CPU.
 */
const FETCH_DEPTH = 50;
const DEEPER = [1000];
/** git's "unshallow": deeper than any history. */
const FULL_DEPTH = 2147483647;

function onAuth(token: string) {
	return () => ({ username: "x", password: token.split("?expires=")[0] });
}

/**
 * A bare, in-memory clone of a project's default branch. The coordinator keeps one alive
 * between merges, so each merge only fetches new objects instead of recloning. It starts shallow
 * (the last FETCH_DEPTH commits) and is deepened only as far as a merge needs.
 */
export class Workspace {
	private readonly fs = new MemoryFS();
	private readonly cache = {};
	private initialized = false;
	/** What each remote was last fetched for, so `merge` can deepen them. */
	private readonly fetched = new Map<string, { remote: RemoteAccess; ref: string }>();
	/** The server doesn't do shallow fetches; everything is fetched in full. */
	private fullOnly = false;
	readonly branch: string;
	private readonly committer: Identity;
	private readonly http: HttpClient;

	constructor(branch: string, committer: Identity, http: HttpClient = webHttp) {
		this.branch = branch;
		this.committer = committer;
		this.http = http;
	}

	private get base() {
		return { fs: this.fs, dir: DIR, cache: this.cache };
	}

	/** Fetches the latest default branch and points the local branch at it. Returns its oid. */
	async syncBase(remote: RemoteAccess): Promise<string> {
		const fresh = !this.initialized;
		if (fresh) {
			await git.init({ fs: this.fs, dir: DIR, defaultBranch: this.branch });
			this.initialized = true;
		}
		// Later syncs fetch only what's new since the last one.
		const fetched = await this.fetchRemote("base", remote, this.branch, fresh ? FETCH_DEPTH : undefined);
		if (!fetched) throw new Error(`Base branch ${this.branch} does not exist`);
		await git.writeRef({ ...this.base, ref: `refs/heads/${this.branch}`, value: fetched, force: true });
		return fetched;
	}

	/** Fetches a task fork's branch. Returns its head oid. */
	async fetchTask(remote: RemoteAccess, branch: string): Promise<string> {
		// In a shallow workspace, a fetch without a depth could bring in the branch's whole history.
		const shallow = (await this.shallowCommits()).size > 0;
		const fetched = await this.fetchRemote("task", remote, branch, shallow ? FETCH_DEPTH : undefined);
		if (!fetched) throw new Error(`Task branch ${branch} does not exist`);
		return fetched;
	}

	private async fetchRemote(name: string, remote: RemoteAccess, ref: string, depth?: number): Promise<string | null> {
		this.fetched.set(name, { remote, ref });
		// Named remotes need a fetch refspec in config; `force` re-points "task" at each new fork.
		await git.addRemote({ ...this.base, remote: name, url: remote.url, force: true });
		// A fetch tells the server which commits we have by the local branch named like `ref`. For a
		// branch named differently from the base there is none, and the server would send the branch's
		// whole history; a local branch of that name at the base's head, for the fetch only, avoids that.
		const hint = ref === this.branch ? null : `refs/heads/${ref}`;
		if (hint) {
			const head = await git.resolveRef({ ...this.base, ref: this.branch }).catch(() => null);
			if (head) await git.writeRef({ ...this.base, ref: hint, value: head, force: true }).catch(() => {});
		}
		const fetch = (depth: number | undefined) =>
			git.fetch({
				...this.base,
				http: this.http,
				remote: name,
				ref,
				singleBranch: true,
				tags: false,
				...(depth === undefined ? {} : { depth }),
				onAuth: onAuth(remote.token),
			});
		try {
			let fetched: Awaited<ReturnType<typeof git.fetch>>;
			try {
				fetched = await fetch(this.fullOnly ? undefined : depth);
			} catch (err) {
				// A server without shallow fetches gets full ones, as before.
				if (depth === undefined || this.fullOnly || (err as { code?: string }).code !== "RemoteCapabilityError") throw err;
				this.fullOnly = true;
				fetched = await fetch(undefined);
			}
			return fetched.fetchHead ?? null;
		} finally {
			if (hint) await git.deleteRef({ ...this.base, ref: hint }).catch(() => {});
		}
	}

	/** Commits whose parents weren't fetched. */
	private async shallowCommits(): Promise<Set<string>> {
		const text = await this.fs.promises.readFile(`${DIR}/.git/shallow`, "utf8").catch(() => "");
		return new Set(String(text).split("\n").filter(Boolean));
	}

	/**
	 * Fetches more history until everything between the two commits and their merge bases is here, so
	 * the merge (and the push after it) sees the same merge bases a full clone would. Each step fetches
	 * deeper; the last fetches everything.
	 */
	private async deepenFor(ours: string, theirs: string): Promise<void> {
		for (const depth of [...DEEPER, FULL_DEPTH]) {
			if (await this.historyComplete(ours, theirs)) return;
			for (const [name, { remote, ref }] of this.fetched) await this.fetchRemote(name, remote, ref, depth);
		}
	}

	/**
	 * Whether the merge bases found in what's here are the real ones. They are when nothing either
	 * side reaches, short of the history the merge bases share, stops at a shallow commit: any better
	 * merge base, and any commit the push has to send, lies in that part of the graph.
	 */
	private async historyComplete(ours: string, theirs: string): Promise<boolean> {
		const shallow = await this.shallowCommits();
		if (shallow.size === 0) return true;
		const bases = await git.findMergeBase({ ...this.base, oids: [ours, theirs] });
		if (bases.length === 0) return false;
		const shared = await this.reachable(bases, shallow, new Set());
		const above = await this.reachable([ours, theirs], shallow, shared);
		return ![...above].some((oid) => shallow.has(oid));
	}

	/** Commits reachable from `starts` without passing `stop`, as far as the fetched history goes. */
	private async reachable(starts: string[], shallow: Set<string>, stop: Set<string>): Promise<Set<string>> {
		const seen = new Set<string>();
		const queue = starts.filter((oid) => !stop.has(oid));
		while (queue.length > 0) {
			const oid = queue.pop() as string;
			if (seen.has(oid)) continue;
			seen.add(oid);
			if (shallow.has(oid)) continue;
			const { commit } = await git.readCommit({ ...this.base, oid });
			for (const parent of commit.parent) if (!seen.has(parent) && !stop.has(parent)) queue.push(parent);
		}
		return seen;
	}

	/** Merges `theirs` into the local default branch without touching the remote. */
	/**
	 * `method`: "merge" (the default) fast-forwards when it can, as the merge queue does; "merge-commit"
	 * always records a merge commit, as pull requests do; "squash" makes one ordinary commit on the
	 * branch with everything `theirs` changed.
	 */
	async merge(theirs: string, message: string, author: Identity, method: "merge" | "merge-commit" | "squash" = "merge"): Promise<MergeOutcome> {
		const ours = await git.resolveRef({ ...this.base, ref: this.branch });
		await this.deepenFor(ours, theirs);
		const changedFiles = await this.changedFiles(ours, theirs);
		try {
			const result = await git.merge({
				...this.base,
				ours: this.branch,
				theirs,
				fastForward: method !== "merge-commit",
				abortOnConflict: true,
				message,
				author: { ...author, timestamp: now() },
				committer: { ...this.committer, timestamp: now() },
			});
			if (result.alreadyMerged || !result.oid || result.oid === ours) return { kind: "up-to-date", oid: ours };
			if (method === "squash") {
				// The merged tree, as one commit on top of ours.
				const [{ commit }, { commit: base }] = await Promise.all([git.readCommit({ ...this.base, oid: result.oid }), git.readCommit({ ...this.base, oid: ours })]);
				// Nothing new (say, the same pull request squashed twice): put the branch back and say so.
				if (commit.tree === base.tree) {
					await git.writeRef({ ...this.base, ref: `refs/heads/${this.branch}`, value: ours, force: true });
					return { kind: "up-to-date", oid: ours };
				}
				const squashed = await git.writeCommit({
					...this.base,
					commit: {
						tree: commit.tree,
						parent: [ours],
						author: { ...author, timestamp: now(), timezoneOffset: 0 },
						committer: { ...this.committer, timestamp: now(), timezoneOffset: 0 },
						message: message.endsWith("\n") ? message : `${message}\n`,
					},
				});
				await git.writeRef({ ...this.base, ref: `refs/heads/${this.branch}`, value: squashed, force: true });
				return { kind: "merged", oid: squashed, fastForward: false, changedFiles };
			}
			return { kind: "merged", oid: result.oid, fastForward: Boolean(result.fastForward), changedFiles };
		} catch (err) {
			if ((err as { code?: string }).code === "MergeConflictError") {
				const data = (err as { data?: { filepaths?: string[] } }).data;
				return { kind: "conflict", files: data?.filepaths ?? [], changedFiles };
			}
			throw err;
		}
	}

	/** Pushes the local default branch. Returns false when the remote moved underneath us. */
	async push(remote: RemoteAccess): Promise<boolean> {
		try {
			const result = await git.push({
				...this.base,
				http: this.http,
				url: remote.url,
				ref: this.branch,
				remoteRef: this.branch,
				onAuth: onAuth(remote.token),
			});
			return result.ok;
		} catch (err) {
			if ((err as { code?: string }).code === "PushRejectedError") return false;
			throw err;
		}
	}

	/** Files that differ between the merge base of (ours, theirs) and theirs, i.e. what the task changed. */
	async changedFiles(ours: string, theirs: string): Promise<string[]> {
		const [mergeBase] = await git.findMergeBase({ ...this.base, oids: [ours, theirs] });
		if (!mergeBase || mergeBase === theirs) return [];
		const changed: string[] = [];
		await git.walk({
			...this.base,
			trees: [TREE({ ref: mergeBase }), TREE({ ref: theirs })],
			map: async (filepath, [before, after]) => {
				if (filepath === ".") return true;
				const [beforeOid, afterOid] = await Promise.all([before?.oid(), after?.oid()]);
				if (beforeOid === afterOid) return null; // identical subtree or file: skip it entirely
				const type = (await after?.type()) ?? (await before?.type());
				if (type === "blob") changed.push(filepath);
				return true;
			},
		});
		return changed.sort();
	}

	/** Creates the initial commit of an empty repo and pushes it. Used when a project is created. */
	async seed(remote: RemoteAccess, files: Record<string, string>, message: string): Promise<string> {
		await git.init({ fs: this.fs, dir: DIR, defaultBranch: this.branch });
		this.initialized = true;
		for (const [path, content] of Object.entries(files)) {
			await this.fs.promises.writeFile(`${DIR}/${path}`, content);
			await git.add({ ...this.base, filepath: path });
		}
		const oid = await git.commit({
			...this.base,
			message,
			author: { ...this.committer, timestamp: now() },
		});
		if (!(await this.push(remote))) throw new Error("Seed push was rejected");
		return oid;
	}
}

function now() {
	return Math.floor(Date.now() / 1000);
}
