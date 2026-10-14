/**
 * Actions caches and artifacts: their records in the repository's coordinator, their bytes in R2.
 * Jobs upload in parts (R2 multipart uploads, each part one request through the Worker), so an
 * archive can be far bigger than a request may be; downloads stream straight from R2.
 *
 * Caches are scoped like GitHub's: a job saves to its branch's scope (a pull request's, for pull
 * requests) and restores from its own, then its base branch's, then the default branch's, so a
 * branch never sees another branch's caches and a fork's pull request can't change the base's.
 * Artifacts belong to a run, and are kept for its retention days.
 */

import type { CiArtifact, CiCache } from "../api.ts";
import { HttpError } from "../errors.ts";
import type { JobGrant } from "./token.ts";

export const MAX_CACHE_BYTES = 10 * 1024 ** 3;
/** All of a repository's caches; past this the least recently used go. */
export const REPO_CACHE_BYTES = 10 * 1024 ** 3;
/** A cache nobody has restored in this long is deleted. */
export const CACHE_UNUSED_MS = 7 * 86_400_000;
export const MAX_ARTIFACT_BYTES = 5 * 1024 ** 3;
/** All of a repository's artifacts. */
export const REPO_ARTIFACT_BYTES = 10 * 1024 ** 3;
export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 90;
/** An upload that hasn't finished in this long is given up on. */
const UPLOAD_TTL_MS = 6 * 3600_000;
export const MAX_ARTIFACTS_PER_RUN = 100;

type Kind = "caches" | "artifacts";

type CacheRow = { id: string; key: string; version: string; scope: string; r2key: string; size: number; upload_id: string | null; parts: string; status: "uploading" | "ready"; created_at: number; used_at: number };
type ArtifactRow = { id: string; run: number; job: string; name: string; r2key: string; size: number; upload_id: string | null; parts: string; status: "uploading" | "ready"; created_at: number; expires_at: number };

export class CiStorage {
	private readonly sql: SqlStorage;
	private readonly bucket: R2Bucket | undefined;
	private readonly repoId: () => string;

	constructor(sql: SqlStorage, bucket: R2Bucket | undefined, repoId: () => string) {
		this.sql = sql;
		this.bucket = bucket;
		this.repoId = repoId;
		sql.exec(`
			CREATE TABLE IF NOT EXISTS ci_caches (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				version TEXT NOT NULL,
				scope TEXT NOT NULL,
				r2key TEXT NOT NULL,
				size INTEGER NOT NULL,
				upload_id TEXT,
				parts TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				used_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ci_caches_lookup ON ci_caches (scope, version, key);
			CREATE TABLE IF NOT EXISTS ci_artifacts (
				id TEXT PRIMARY KEY,
				run INTEGER NOT NULL,
				job TEXT NOT NULL,
				name TEXT NOT NULL,
				r2key TEXT NOT NULL,
				size INTEGER NOT NULL,
				upload_id TEXT,
				parts TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS ci_artifacts_run ON ci_artifacts (run, name);
		`);
	}

	private r2(): R2Bucket {
		if (!this.bucket) throw new HttpError(503, "NO_STORAGE", "This server has no R2 bucket for Actions caches and artifacts");
		return this.bucket;
	}

	// ── Caches ───────────────────────────────────────────────────────────────

	/**
	 * The cache a job restores: in each scope it may read, in order, the primary key exactly, then the
	 * newest whose key starts with the primary key, then with each restore key in turn.
	 */
	lookupCache(grant: JobGrant, keys: string[], version: string): { id: string; key: string; size: number } | null {
		const [primary, ...restore] = keys.filter((k) => k.length > 0);
		if (!primary) throw new HttpError(400, "INVALID_INPUT", "A cache key is needed");
		for (const scope of grant.read) {
			const exact = this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE status = 'ready' AND scope = ? AND version = ? AND key = ? ORDER BY created_at DESC LIMIT 1", scope, version, primary).toArray()[0];
			const found =
				exact ??
				[primary, ...restore]
					.map((prefix) => this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE status = 'ready' AND scope = ? AND version = ? AND substr(key, 1, ?) = ? ORDER BY created_at DESC LIMIT 1", scope, version, prefix.length, prefix).toArray()[0])
					.find(Boolean);
			if (found) {
				this.sql.exec("UPDATE ci_caches SET used_at = ? WHERE id = ?", Date.now(), found.id);
				return { id: found.id, key: found.key, size: found.size };
			}
		}
		return null;
	}

	/** Starts saving a cache into the job's scope; null if one with that key is already saved there. */
	async reserveCache(grant: JobGrant, key: string, version: string, size: number): Promise<string | null> {
		if (!key || key.length > 512 || key.includes(",")) throw new HttpError(400, "INVALID_INPUT", "A cache key is 1 to 512 characters, without commas");
		if (!/^[0-9a-f]{64}$/.test(version)) throw new HttpError(400, "INVALID_INPUT", "The cache version is a SHA-256");
		if (!Number.isInteger(size) || size < 1) throw new HttpError(400, "INVALID_INPUT", "size is the archive's size in bytes");
		if (size > MAX_CACHE_BYTES) throw new HttpError(413, "TOO_LARGE", `A cache can be at most ${MAX_CACHE_BYTES / 1024 ** 3} GB`);
		const existing = this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE scope = ? AND version = ? AND key = ?", grant.write, version, key).toArray();
		for (const row of existing) {
			if (row.status === "ready" || Date.now() - row.created_at < UPLOAD_TTL_MS) return null;
			await this.dropCache(row);
		}
		const id = crypto.randomUUID();
		const r2key = `caches/${this.repoId()}/${id}`;
		const upload = await this.r2().createMultipartUpload(r2key);
		const now = Date.now();
		this.sql.exec(
			"INSERT INTO ci_caches (id, key, version, scope, r2key, size, upload_id, status, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)",
			id,
			key,
			version,
			grant.write,
			r2key,
			size,
			upload.uploadId,
			now,
			now,
		);
		return id;
	}

	/** Where a job may read a cache from: one in a scope it may restore from. */
	cacheObject(grant: JobGrant, id: string): string {
		const row = this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE id = ? AND status = 'ready'", id).toArray()[0];
		if (!row || !grant.read.includes(row.scope)) throw new HttpError(404, "NOT_FOUND", "No such cache");
		return row.r2key;
	}

	listCaches(): CiCache[] {
		return this.sql
			.exec<CacheRow>("SELECT * FROM ci_caches WHERE status = 'ready' ORDER BY used_at DESC LIMIT 500")
			.toArray()
			.map((r) => ({ id: r.id, key: r.key, scope: r.scope, size: r.size, createdAt: new Date(r.created_at).toISOString(), usedAt: new Date(r.used_at).toISOString() }));
	}

	async deleteCache(id: string): Promise<void> {
		const row = this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE id = ?", id).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "No such cache");
		await this.dropCache(row);
	}

	private async dropCache(row: CacheRow) {
		await this.abortOrDelete(row);
		this.sql.exec("DELETE FROM ci_caches WHERE id = ?", row.id);
	}

	// ── Artifacts ────────────────────────────────────────────────────────────

	/** Starts uploading an artifact of the job's run. Overwriting replaces one of the same name; otherwise that's a conflict. */
	async reserveArtifact(grant: JobGrant, name: string, size: number, retentionDays: number | null, overwrite: boolean): Promise<string> {
		if (!name || name.length > 256 || /[\\/:*?"<>|\r\n]/.test(name)) throw new HttpError(400, "INVALID_INPUT", 'An artifact name is 1 to 256 characters, without \\ / : * ? " < > |');
		if (!Number.isInteger(size) || size < 1) throw new HttpError(400, "INVALID_INPUT", "size is the archive's size in bytes");
		if (size > MAX_ARTIFACT_BYTES) throw new HttpError(413, "TOO_LARGE", `An artifact can be at most ${MAX_ARTIFACT_BYTES / 1024 ** 3} GB`);
		const days = retentionDays ?? DEFAULT_RETENTION_DAYS;
		if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) throw new HttpError(400, "INVALID_INPUT", `retention-days is from 1 to ${MAX_RETENTION_DAYS}`);
		const same = this.sql.exec<ArtifactRow>("SELECT * FROM ci_artifacts WHERE run = ? AND name = ?", grant.run, name).toArray();
		for (const row of same) {
			if (row.status === "ready" && !overwrite) throw new HttpError(409, "ALREADY_EXISTS", `This run already has an artifact called ${name} (set overwrite: true to replace it)`);
			await this.dropArtifact(row);
		}
		if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ci_artifacts WHERE run = ?", grant.run).one().n >= MAX_ARTIFACTS_PER_RUN) {
			throw new HttpError(409, "TOO_MANY", `A run can have at most ${MAX_ARTIFACTS_PER_RUN} artifacts`);
		}
		const total = this.sql.exec<{ n: number | null }>("SELECT SUM(size) AS n FROM ci_artifacts").one().n ?? 0;
		if (total + size > REPO_ARTIFACT_BYTES) {
			throw new HttpError(413, "QUOTA_EXCEEDED", `The repository's artifacts would take more than ${REPO_ARTIFACT_BYTES / 1024 ** 3} GB; delete some or shorten their retention`);
		}
		const id = crypto.randomUUID();
		const r2key = `artifacts/${this.repoId()}/${grant.run}/${id}`;
		const upload = await this.r2().createMultipartUpload(r2key);
		const now = Date.now();
		this.sql.exec(
			"INSERT INTO ci_artifacts (id, run, job, name, r2key, size, upload_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)",
			id,
			grant.run,
			grant.job,
			name,
			r2key,
			size,
			upload.uploadId,
			now,
			now + days * 86_400_000,
		);
		return id;
	}

	listArtifacts(run: number): CiArtifact[] {
		return this.sql
			.exec<ArtifactRow>("SELECT * FROM ci_artifacts WHERE run = ? AND status = 'ready' AND expires_at > ? ORDER BY name", run, Date.now())
			.toArray()
			.map((r) => ({ id: r.id, name: r.name, size: r.size, createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString() }));
	}

	/** An artifact of `run`, to download: its R2 key and name. */
	artifactObject(run: number, id: string): { key: string; name: string } {
		const row = this.sql.exec<ArtifactRow>("SELECT * FROM ci_artifacts WHERE id = ? AND run = ? AND status = 'ready' AND expires_at > ?", id, run, Date.now()).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "No such artifact (it may have expired)");
		return { key: row.r2key, name: row.name };
	}

	async deleteArtifact(run: number, id: string): Promise<void> {
		const row = this.sql.exec<ArtifactRow>("SELECT * FROM ci_artifacts WHERE id = ? AND run = ?", id, run).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "No such artifact");
		await this.dropArtifact(row);
	}

	private async dropArtifact(row: ArtifactRow) {
		await this.abortOrDelete(row);
		this.sql.exec("DELETE FROM ci_artifacts WHERE id = ?", row.id);
	}

	// ── Uploads ──────────────────────────────────────────────────────────────

	private row(kind: Kind, id: string): CacheRow | ArtifactRow | undefined {
		return kind === "caches" ? this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE id = ?", id).toArray()[0] : this.sql.exec<ArtifactRow>("SELECT * FROM ci_artifacts WHERE id = ?", id).toArray()[0];
	}

	/** An upload the job may add parts to: its own run's artifact, or a cache in its own scope. */
	private uploading(kind: Kind, id: string, grant: JobGrant): CacheRow | ArtifactRow {
		const row = this.row(kind, id);
		const mine = row && (kind === "caches" ? (row as CacheRow).scope === grant.write : (row as ArtifactRow).run === grant.run);
		if (!row || !mine || row.status !== "uploading" || !row.upload_id) throw new HttpError(404, "NOT_FOUND", "No such upload in progress");
		return row;
	}

	/** Where a part goes: the R2 key and multipart upload id. */
	uploadTarget(kind: Kind, id: string, grant: JobGrant): { key: string; uploadId: string } {
		const row = this.uploading(kind, id, grant);
		return { key: row.r2key, uploadId: row.upload_id! };
	}

	recordPart(kind: Kind, id: string, grant: JobGrant, part: R2UploadedPart) {
		const row = this.uploading(kind, id, grant);
		const parts = (JSON.parse(row.parts) as R2UploadedPart[]).filter((p) => p.partNumber !== part.partNumber);
		parts.push(part);
		this.sql.exec(`UPDATE ${kind === "caches" ? "ci_caches" : "ci_artifacts"} SET parts = ? WHERE id = ?`, JSON.stringify(parts), id);
	}

	/** Finishes an upload: the parts become one object, and the cache or artifact can be read. */
	async commit(kind: Kind, id: string, grant: JobGrant): Promise<void> {
		const row = this.uploading(kind, id, grant);
		const parts = (JSON.parse(row.parts) as R2UploadedPart[]).sort((a, b) => a.partNumber - b.partNumber);
		if (parts.length === 0) throw new HttpError(400, "INVALID_INPUT", "Nothing was uploaded");
		const object = await this.r2().resumeMultipartUpload(row.r2key, row.upload_id!).complete(parts);
		const table = kind === "caches" ? "ci_caches" : "ci_artifacts";
		this.sql.exec(`UPDATE ${table} SET status = 'ready', size = ?, upload_id = NULL, parts = '[]' WHERE id = ?`, object.size, id);
		if (kind === "caches") await this.evict();
	}

	private async abortOrDelete(row: CacheRow | ArtifactRow) {
		if (!this.bucket) return;
		try {
			if (row.status === "uploading" && row.upload_id) await this.bucket.resumeMultipartUpload(row.r2key, row.upload_id).abort();
			else await this.bucket.delete(row.r2key);
		} catch (err) {
			console.error("ci: removing a cache or artifact from R2 failed", err);
		}
	}

	/** Keeps the repository's caches under REPO_CACHE_BYTES, dropping the least recently restored. */
	private async evict() {
		let total = this.sql.exec<{ n: number | null }>("SELECT SUM(size) AS n FROM ci_caches").one().n ?? 0;
		while (total > REPO_CACHE_BYTES) {
			const oldest = this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE status = 'ready' ORDER BY used_at LIMIT 1").toArray()[0];
			if (!oldest) break;
			await this.dropCache(oldest);
			total -= oldest.size;
		}
	}

	/** Drops expired artifacts, caches nobody restored for a week, and uploads that never finished. */
	async prune(): Promise<void> {
		const now = Date.now();
		for (const row of this.sql.exec<ArtifactRow>("SELECT * FROM ci_artifacts WHERE expires_at < ? OR (status = 'uploading' AND created_at < ?) LIMIT 100", now, now - UPLOAD_TTL_MS).toArray()) {
			await this.dropArtifact(row);
		}
		for (const row of this.sql.exec<CacheRow>("SELECT * FROM ci_caches WHERE used_at < ? OR (status = 'uploading' AND created_at < ?) LIMIT 100", now - CACHE_UNUSED_MS, now - UPLOAD_TTL_MS).toArray()) {
			await this.dropCache(row);
		}
	}

	/** A run was pruned: its artifacts expire now, and the next prune removes them. */
	expireRun(run: number) {
		this.sql.exec("UPDATE ci_artifacts SET expires_at = 0 WHERE run = ?", run);
	}

	/** Everything, when the repository is deleted. */
	async dropAll(): Promise<void> {
		for (const row of this.sql.exec<CacheRow>("SELECT * FROM ci_caches").toArray()) await this.dropCache(row);
		for (const row of this.sql.exec<ArtifactRow>("SELECT * FROM ci_artifacts").toArray()) await this.dropArtifact(row);
	}
}
