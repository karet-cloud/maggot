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

function onAuth(token: string) {
	return () => ({ username: "x", password: token.split("?expires=")[0] });
}

/**
 * A bare, in-memory clone of a project's default branch. The coordinator keeps one alive
 * between merges, so each merge only fetches new objects instead of recloning.
 */
export class Workspace {
	private readonly fs = new MemoryFS();
	private readonly cache = {};
	private initialized = false;
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
		if (!this.initialized) {
			await git.init({ fs: this.fs, dir: DIR, defaultBranch: this.branch });
			this.initialized = true;
		}
		const fetched = await this.fetchRemote("base", remote, this.branch);
		if (!fetched) throw new Error(`Base branch ${this.branch} does not exist`);
		await git.writeRef({ ...this.base, ref: `refs/heads/${this.branch}`, value: fetched, force: true });
		return fetched;
	}

	/** Fetches a task fork's branch. Returns its head oid. */
	async fetchTask(remote: RemoteAccess, branch: string): Promise<string> {
		const fetched = await this.fetchRemote("task", remote, branch);
		if (!fetched) throw new Error(`Task branch ${branch} does not exist`);
		return fetched;
	}

	private async fetchRemote(name: string, remote: RemoteAccess, ref: string): Promise<string | null> {
		// Named remotes need a fetch refspec in config; `force` re-points "task" at each new fork.
		await git.addRemote({ ...this.base, remote: name, url: remote.url, force: true });
		const fetched = await git.fetch({
			...this.base,
			http: this.http,
			remote: name,
			ref,
			singleBranch: true,
			tags: false,
			onAuth: onAuth(remote.token),
		});
		return fetched.fetchHead ?? null;
	}

	/** Merges `theirs` into the local default branch without touching the remote. */
	/**
	 * `method`: "merge" (the default) fast-forwards when it can, as the merge queue does; "merge-commit"
	 * always records a merge commit, as pull requests do; "squash" makes one ordinary commit on the
	 * branch with everything `theirs` changed.
	 */
	async merge(theirs: string, message: string, author: Identity, method: "merge" | "merge-commit" | "squash" = "merge"): Promise<MergeOutcome> {
		const ours = await git.resolveRef({ ...this.base, ref: this.branch });
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
				const { commit } = await git.readCommit({ ...this.base, oid: result.oid });
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
