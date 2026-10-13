// Webhooks for one repository: subscriptions and their deliveries live in the repository's coordinator,
// next to the events they report. Deliveries are queued when an event happens and sent by the
// coordinator's alarm: signed with HMAC-SHA256, retried with backoff, and kept for inspection.
import type { EventType, Webhook, WebhookDelivery, WebhookEvent } from "./api.ts";
import { HttpError } from "./errors.ts";

export const WEBHOOK_EVENTS: WebhookEvent[] = ["push", "task", "merge", "release", "issues"];
const MAX_HOOKS = 20;
/** Delay before each retry; a delivery that fails them all is marked failed. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const TIMEOUT_MS = 10_000;
const KEEP_DELIVERIES = 50;
const BATCH = 20;
/** Deliveries one repository may have waiting; past it new ones are dropped (and counted as failed). */
const MAX_PENDING = 500;

/** Who the payloads say the repository is (owner/name and URLs); internal names stay internal. */
export interface RepositoryRef {
	fullName: string;
	url: string;
	cloneUrl: string;
	defaultBranch: string;
}

type HookRow = { id: string; url: string; secret: string; events: string; active: number; created_at: string };
type DeliveryRow = {
	id: string;
	hook_id: string;
	event: string;
	payload: string;
	status: "pending" | "delivered" | "failed";
	attempts: number;
	response_status: number | null;
	response: string | null;
	duration_ms: number | null;
	created_at: string;
	delivered_at: string | null;
	next_at: number | null;
};

/** Refuses URLs a webhook may not call: anything but https (http only in local development), credentials in the URL, and local or private hosts. */
export function validateHookUrl(raw: string, allowHttp: boolean): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new HttpError(400, "INVALID_URL", "Give a full URL, like https://example.com/hook");
	}
	if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new HttpError(400, "INVALID_URL", "Webhook URLs must use https");
	if (url.username || url.password) throw new HttpError(400, "INVALID_URL", "Put credentials in the secret, not the URL");
	if (!allowHttp && isPrivateHost(url.hostname)) throw new HttpError(400, "INVALID_URL", "Webhooks can't call local or private addresses");
	return url.toString();
}

/**
 * Hosts that name this machine or a private network, by spelling. (Workers' outbound fetches leave
 * Cloudflare for the public internet, so a public name that resolves to a private address reaches
 * nothing private; this catches the obvious cases early with a clear error.)
 */
export function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host) || !host.includes(".") && !host.includes(":")) return true;
	if (host.includes(":")) {
		// IPv6 literal: anything starting "::" (loopback, unspecified, IPv4-mapped and -compatible), plus
		// unique-local (fc00::/7) and link-local (fe80::/10). URL parsing has already normalized it.
		return host.startsWith("::") || /^0+:/.test(host) || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
	}
	// IPv4 rules apply to addresses only (a name like 0.pool.ntp.org is fine); all-digit hosts are IPv4 in disguise.
	if (/^\d+$/.test(host)) return true;
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
	return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
}

export class Webhooks {
	private readonly sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.sql = sql;
		sql.exec(`
			CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS deliveries (
				id TEXT PRIMARY KEY,
				hook_id TEXT NOT NULL,
				event TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				response_status INTEGER,
				response TEXT,
				duration_ms INTEGER,
				created_at TEXT NOT NULL,
				delivered_at TEXT,
				next_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_at);
			CREATE INDEX IF NOT EXISTS deliveries_hook ON deliveries (hook_id, created_at);
		`);
	}

	list(): Webhook[] {
		return this.sql
			.exec<HookRow>("SELECT * FROM hooks ORDER BY created_at")
			.toArray()
			.map((row) => this.toHook(row));
	}

	get(id: string): Webhook {
		return this.toHook(this.row(id));
	}

	create(input: { url: string; secret: string; events: WebhookEvent[] }): Webhook {
		const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hooks").one().n;
		if (count >= MAX_HOOKS) throw new HttpError(403, "QUOTA_EXCEEDED", `A repository can have at most ${MAX_HOOKS} webhooks`);
		const id = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO hooks (id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
			id,
			input.url,
			input.secret,
			JSON.stringify(checkEvents(input.events)),
			new Date().toISOString(),
		);
		return this.get(id);
	}

	update(id: string, patch: { url?: string; secret?: string; events?: WebhookEvent[]; active?: boolean }): Webhook {
		const row = this.row(id);
		// Everything is checked before anything changes.
		const events = patch.events === undefined ? row.events : JSON.stringify(checkEvents(patch.events));
		this.sql.exec(
			"UPDATE hooks SET url = ?, secret = ?, events = ?, active = ? WHERE id = ?",
			patch.url ?? row.url,
			patch.secret ?? row.secret,
			events,
			patch.active === undefined ? row.active : patch.active ? 1 : 0,
			id,
		);
		// A paused hook sends nothing more, including what was already queued.
		if (patch.active === false) {
			this.sql.exec("UPDATE deliveries SET status = 'failed', response = 'Webhook paused', next_at = NULL WHERE hook_id = ? AND status = 'pending'", id);
		}
		return this.get(id);
	}

	/** Pauses every hook (and drops what they had queued); returns how many were active. */
	pauseAll(): number {
		const active = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM hooks WHERE active = 1").one().n;
		this.sql.exec("UPDATE hooks SET active = 0");
		this.sql.exec("UPDATE deliveries SET status = 'failed', response = 'Webhook paused', next_at = NULL WHERE status = 'pending'");
		return active;
	}

	remove(id: string): void {
		this.row(id);
		this.sql.exec("DELETE FROM deliveries WHERE hook_id = ?", id);
		this.sql.exec("DELETE FROM hooks WHERE id = ?", id);
	}

	deliveries(hookId: string, limit = 30): WebhookDelivery[] {
		this.row(hookId);
		return this.sql
			.exec<DeliveryRow>("SELECT * FROM deliveries WHERE hook_id = ? ORDER BY created_at DESC LIMIT ?", hookId, Math.max(1, Math.min(limit, KEEP_DELIVERIES)))
			.toArray()
			.map(toDelivery);
	}

	/** Queues the payloads an event produces for every active hook subscribed to them. Returns how many. */
	enqueue(type: EventType, taskId: string | null, data: Record<string, unknown>, repository: RepositoryRef): number {
		const payloads = payloadsFor(type, taskId, data, repository);
		if (payloads.length === 0) return 0;
		let queued = 0;
		for (const hook of this.sql.exec<HookRow>("SELECT * FROM hooks WHERE active = 1").toArray()) {
			const events = JSON.parse(hook.events) as WebhookEvent[];
			for (const { event, payload } of payloads) {
				if (!events.includes(event)) continue;
				this.queue(hook.id, event, payload);
				queued++;
			}
		}
		return queued;
	}

	ping(hookId: string, repository: RepositoryRef): WebhookDelivery {
		const hook = this.get(hookId);
		const id = this.queue(hookId, "ping", { event: "ping", hook: { id: hook.id, events: hook.events }, repository: publicRepo(repository) });
		return toDelivery(this.sql.exec<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", id).one());
	}

	/** Sends a past delivery's payload again, as a new delivery. */
	redeliver(hookId: string, deliveryId: string): WebhookDelivery {
		const old = this.sql.exec<DeliveryRow>("SELECT * FROM deliveries WHERE id = ? AND hook_id = ?", deliveryId, hookId).toArray()[0];
		if (!old) throw new HttpError(404, "NOT_FOUND", "No such delivery");
		const id = this.queue(hookId, old.event as WebhookEvent | "ping", JSON.parse(old.payload));
		return toDelivery(this.sql.exec<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?", id).one());
	}

	/** When the next delivery is due, or null if none is waiting. */
	nextDue(): number | null {
		return this.sql.exec<{ at: number | null }>("SELECT MIN(next_at) AS at FROM deliveries WHERE status = 'pending'").one().at;
	}

	/**
	 * Sends the deliveries that are due. Returns the hooks whose delivery just failed for good, so the
	 * coordinator can tell the owner.
	 */
	async deliverDue(now = Date.now()): Promise<{ hookId: string; url: string; error: string }[]> {
		const due = this.sql.exec<DeliveryRow>("SELECT * FROM deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?", now, BATCH).toArray();
		const failed: { hookId: string; url: string; error: string }[] = [];
		await Promise.all(
			due.map(async (delivery) => {
				const hook = this.sql.exec<HookRow>("SELECT * FROM hooks WHERE id = ?", delivery.hook_id).toArray()[0];
				if (!hook || !hook.active) {
					this.sql.exec("UPDATE deliveries SET status = 'failed', response = 'Webhook paused or removed', next_at = NULL WHERE id = ?", delivery.id);
					return;
				}
				const result = await send(hook, delivery);
				const attempts = delivery.attempts + 1;
				if (result.ok) {
					this.sql.exec(
						"UPDATE deliveries SET status = 'delivered', attempts = ?, response_status = ?, response = ?, duration_ms = ?, delivered_at = ?, next_at = NULL WHERE id = ?",
						attempts,
						result.status,
						result.body,
						result.ms,
						new Date().toISOString(),
						delivery.id,
					);
					return;
				}
				const retry = delivery.event !== "ping" ? RETRY_DELAYS_MS[attempts - 1] : undefined;
				this.sql.exec(
					"UPDATE deliveries SET status = ?, attempts = ?, response_status = ?, response = ?, duration_ms = ?, next_at = ? WHERE id = ?",
					retry === undefined ? "failed" : "pending",
					attempts,
					result.status,
					result.body,
					result.ms,
					retry === undefined ? null : Date.now() + retry,
					delivery.id,
				);
				// The owner hears once when a hook starts failing, not for every delivery after that.
				if (retry === undefined && delivery.event !== "ping") {
					const before = this.sql
						.exec<{ status: string }>(
							"SELECT status FROM deliveries WHERE hook_id = ? AND id != ? AND status != 'pending' AND event != 'ping' ORDER BY created_at DESC LIMIT 1",
							hook.id,
							delivery.id,
						)
						.toArray()[0];
					if (before?.status !== "failed") failed.push({ hookId: hook.id, url: hook.url, error: result.body ?? `HTTP ${result.status}` });
				}
			}),
		);
		this.prune();
		return failed;
	}

	private queue(hookId: string, event: WebhookEvent | "ping", payload: unknown): string {
		const id = crypto.randomUUID();
		const pending = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'").one().n;
		if (pending >= MAX_PENDING) {
			// The receiver is too far behind; record the drop instead of growing without bound.
			this.sql.exec(
				"INSERT INTO deliveries (id, hook_id, event, payload, status, response, created_at) VALUES (?, ?, ?, ?, 'failed', ?, ?)",
				id,
				hookId,
				event,
				JSON.stringify(payload),
				`Dropped: more than ${MAX_PENDING} deliveries were waiting`,
				new Date().toISOString(),
			);
			return id;
		}
		this.sql.exec(
			"INSERT INTO deliveries (id, hook_id, event, payload, status, created_at, next_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
			id,
			hookId,
			event,
			JSON.stringify(payload),
			new Date().toISOString(),
			Date.now(),
		);
		return id;
	}

	/** Keeps the newest KEEP_DELIVERIES finished deliveries per hook. */
	private prune() {
		for (const { id } of this.sql.exec<{ id: string }>("SELECT id FROM hooks").toArray()) {
			this.sql.exec(
				`DELETE FROM deliveries WHERE hook_id = ? AND status != 'pending' AND id NOT IN
				 (SELECT id FROM deliveries WHERE hook_id = ? ORDER BY created_at DESC LIMIT ?)`,
				id,
				id,
				KEEP_DELIVERIES,
			);
		}
	}

	private row(id: string): HookRow {
		const row = this.sql.exec<HookRow>("SELECT * FROM hooks WHERE id = ?", id).toArray()[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "No such webhook");
		return row;
	}

	private toHook(row: HookRow): Webhook {
		const last = this.sql
			.exec<{ status: Webhook["lastStatus"] }>("SELECT status FROM deliveries WHERE hook_id = ? ORDER BY created_at DESC LIMIT 1", row.id)
			.toArray()[0];
		return { id: row.id, url: row.url, events: JSON.parse(row.events), active: Boolean(row.active), createdAt: row.created_at, lastStatus: last?.status ?? null };
	}
}

function checkEvents(events: WebhookEvent[]): WebhookEvent[] {
	const chosen = [...new Set(events)];
	if (chosen.length === 0 || chosen.some((e) => !WEBHOOK_EVENTS.includes(e))) {
		throw new HttpError(400, "INVALID_INPUT", `Choose events from: ${WEBHOOK_EVENTS.join(", ")}`);
	}
	return chosen;
}

const publicRepo = (r: RepositoryRef) => ({ full_name: r.fullName, html_url: r.url, clone_url: r.cloneUrl, default_branch: r.defaultBranch });

/** The webhook payloads one project event turns into. */
function payloadsFor(type: EventType, taskId: string | null, data: Record<string, unknown>, repository: RepositoryRef): { event: WebhookEvent; payload: unknown }[] {
	const repo = publicRepo(repository);
	if (type === "repo.pushed") {
		const refs = (data.refs as { branch: string; from: string | null; to: string | null }[] | undefined) ?? [];
		return refs.map((r) => ({
			event: "push" as const,
			payload: {
				event: "push",
				ref: `refs/heads/${r.branch}`,
				before: r.from ?? "0".repeat(40),
				after: r.to ?? "0".repeat(40),
				created: r.from === null,
				deleted: r.to === null,
				repository: repo,
			},
		}));
	}
	if (type === "main.advanced") {
		// A merge moves the default branch, so push subscribers hear about it too.
		return [
			{ event: "merge", payload: { event: "merge", task: taskId, ...data, repository: repo } },
			{
				event: "push",
				payload: { event: "push", ref: `refs/heads/${repository.defaultBranch}`, before: data.from, after: data.to, created: false, deleted: false, repository: repo },
			},
		];
	}
	if (type === "tag.created" || type === "tag.deleted") {
		// Like GitHub, a tag appearing or going away is a push to refs/tags/.
		const created = type === "tag.created";
		return [
			{
				event: "push",
				payload: {
					event: "push",
					ref: `refs/tags/${data.tag}`,
					before: created ? (data.from ?? "0".repeat(40)) : data.commit,
					after: created ? data.commit : "0".repeat(40),
					created: created && !data.from,
					deleted: !created,
					repository: repo,
				},
			},
		];
	}
	if (type === "release.published") {
		return [{ event: "release", payload: { event: "release", action: "published", release: data, repository: repo } }];
	}
	if (type.startsWith("issue.")) {
		return [{ event: "issues", payload: { event: "issues", action: type.slice("issue.".length), ...data, repository: repo } }];
	}
	if (type.startsWith("task.")) {
		// Fork repo names and Artifacts remotes are internal; receivers get the task id and what happened.
		const { repo: _repo, remote: _remote, ...rest } = data;
		return [{ event: "task", payload: { event: "task", action: type.slice("task.".length), task: taskId, data: rest, repository: repo } }];
	}
	return [];
}

async function send(hook: HookRow, delivery: DeliveryRow): Promise<{ ok: boolean; status: number | null; body: string | null; ms: number }> {
	const started = Date.now();
	const body = delivery.payload;
	try {
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(hook.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
		const signature = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
		const res = await fetch(hook.url, {
			method: "POST",
			// Redirects aren't followed: a webhook calls exactly the URL its owner gave.
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: {
				"content-type": "application/json",
				"user-agent": "megit-webhooks",
				"x-megit-event": delivery.event,
				"x-megit-delivery": delivery.id,
				"x-megit-signature-256": `sha256=${signature}`,
			},
			body,
		});
		const text = await readStart(res, 1024);
		return { ok: res.status >= 200 && res.status < 300, status: res.status, body: text || null, ms: Date.now() - started };
	} catch (err) {
		return { ok: false, status: null, body: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
	}
}

/** The first `limit` bytes of a response body as text; the rest is never read. */
async function readStart(res: Response, limit: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} catch {
		// A body that breaks off still leaves what arrived.
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		bytes.set(c, at);
		at += c.byteLength;
	}
	return new TextDecoder().decode(bytes.subarray(0, limit));
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
	return {
		id: row.id,
		hookId: row.hook_id,
		event: row.event as WebhookDelivery["event"],
		status: row.status,
		attempts: row.attempts,
		responseStatus: row.response_status,
		response: row.response,
		durationMs: row.duration_ms,
		payload: JSON.parse(row.payload),
		createdAt: row.created_at,
		deliveredAt: row.delivered_at,
		nextAt: row.next_at === null ? null : new Date(row.next_at).toISOString(),
	};
}
