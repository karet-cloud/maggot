import { HttpError } from "./errors.ts";

/** The subset of a repo capability megit uses. Satisfied by the real `ArtifactsRepo`. */
export interface RepoHandle extends Disposable {
	info(): Promise<ArtifactsRepoInfo>;
	createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsCreateTokenResult>;
	fork(name: string, opts?: { description?: string; defaultBranchOnly?: boolean }): Promise<ArtifactsCreateRepoResult>;
	log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]>;
	readFile(args: { ref: string; path: string }): Promise<Blob | null>;
}

/** The subset of the `Artifacts` namespace binding megit uses. */
export interface RepoStore {
	create(name: string, opts?: { description?: string; setDefaultBranch?: string }): Promise<ArtifactsCreateRepoResult>;
	import(params: {
		source: { url: string; branch?: string; depth?: number };
		target: { name: string; opts?: { description?: string } };
	}): Promise<ArtifactsCreateRepoResult>;
	get(name: string): Promise<RepoHandle>;
	delete(name: string): Promise<boolean>;
}

export interface StoreEnv {
	ARTIFACTS?: Artifacts;
	LOCAL_ARTIFACTS_URL?: string;
}

export function repoStore(env: StoreEnv): RepoStore {
	if (env.LOCAL_ARTIFACTS_URL) return new LocalArtifacts(env.LOCAL_ARTIFACTS_URL);
	if (env.ARTIFACTS) return env.ARTIFACTS;
	throw new HttpError(500, "MISCONFIGURED", "No ARTIFACTS binding or LOCAL_ARTIFACTS_URL configured");
}

/** Client for scripts/local-artifacts.ts. */
class LocalArtifacts implements RepoStore {
	private readonly base: string;
	constructor(base: string) {
		this.base = base;
	}

	async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(`${this.base}/api${path}`, {
			method,
			headers: body ? { "content-type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const json = (await res.json()) as { result?: T; error?: { code: string; message: string } };
		if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code });
		return json.result as T;
	}

	create(name: string, opts: { description?: string; setDefaultBranch?: string } = {}) {
		return this.call<ArtifactsCreateRepoResult>("POST", "/repos", {
			name,
			description: opts.description,
			defaultBranch: opts.setDefaultBranch,
		});
	}

	import(params: Parameters<RepoStore["import"]>[0]) {
		return this.call<ArtifactsCreateRepoResult>("POST", "/import", {
			...params.source,
			name: params.target.name,
			description: params.target.opts?.description,
		});
	}

	async get(name: string): Promise<RepoHandle> {
		await this.call("GET", `/repos/${encodeURIComponent(name)}`);
		const path = `/repos/${encodeURIComponent(name)}`;
		return {
			info: () => this.call<ArtifactsRepoInfo>("GET", path),
			createToken: (scope = "write", ttl) => this.call<ArtifactsCreateTokenResult>("POST", `${path}/tokens`, { scope, ttl }),
			fork: (target, opts) => this.call<ArtifactsCreateRepoResult>("POST", `${path}/fork`, { name: target, ...opts }),
			log: (opts = {}) => {
				const q = new URLSearchParams(Object.entries(opts).map(([k, v]) => [k, String(v)]));
				return this.call<ArtifactsCommitMetadata[]>("GET", `${path}/log?${q}`);
			},
			readFile: async ({ ref, path: file }) => {
				const result = await this.call<{ content: string } | null>(
					"GET",
					`${path}/file?${new URLSearchParams({ ref, path: file })}`,
				);
				return result ? new Blob([result.content], { type: "text/plain;charset=utf-8" }) : null;
			},
			[Symbol.dispose]() {},
		};
	}

	delete(name: string) {
		return this.call<boolean>("DELETE", `/repos/${encodeURIComponent(name)}`);
	}
}
