// Webhooks for one repository: subscriptions and their deliveries live in the repository's coordinator,
// next to the events they report. Deliveries are queued when an event happens and sent by the
// coordinator's alarm: signed with HMAC-SHA256, retried with backoff, and kept for inspection.
import type { EventType, Webhook, WebhookDelivery, WebhookEvent } from "./api.ts";
import { HttpError } from "./errors.ts";

export const WEBHOOK_EVENTS: WebhookEvent[] = ["push", "task", "merge"];
const MAX_HOOKS = 20;
/** Delay before each retry; a delivery that fails them all is marked failed. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
const TIMEOUT_MS = 10_000;
const KEEP_DELIVERIES = 50;
const BATCH = 20;

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
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const local =
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
		host === "::1" ||
		host.startsWith("fc") ||
		host.startsWith("fd") ||
		host.startsWith("fe80");
	if (local && !allowHttp) throw new HttpError(400, "INVALID_URL", "Webhooks can't call local or private addresses");
	return url.toString();
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
		this.row(id);
		if (patch.url !== undefined) this.sql.exec("UPDATE hooks SET url = ? WHERE id = ?", patch.url, id);
		if (patch.secret !== undefined) this.sql.exec("UPDATE hooks SET secret = ? WHERE id = ?", patch.secret, id);
		if (patch.events !== undefined) this.sql.exec("UPDATE hooks SET events = ? WHERE id = ?", JSON.stringify(checkEvents(patch.events)), id);
		if (patch.active !== undefined) this.sql.exec("UPDATE hooks SET active = ? WHERE id = ?", patch.active ? 1 : 0, id);
		return this.get(id);
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
				if (!hook) return;
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
				if (retry === undefined && delivery.event !== "ping") failed.push({ hookId: hook.id, url: hook.url, error: result.body ?? `HTTP ${result.status}` });
			}),
		);
		this.prune();
		return failed;
	}

	private queue(hookId: string, event: WebhookEvent | "ping", payload: unknown): string {
		const id = crypto.randomUUID();
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
	if (type === "main.advanced") return [{ event: "merge", payload: { event: "merge", task: taskId, ...data, repository: repo } }];
	if (type.startsWith("task.")) return [{ event: "task", payload: { event: "task", action: type.slice("task.".length), task: taskId, data, repository: repo } }];
	return [];
}

async function send(hook: HookRow, delivery: DeliveryRow): Promise<{ ok: boolean; status: number | null; body: string | null; ms: number }> {
	const started = Date.now();
	const body = delivery.payload;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(hook.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
	const signature = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
	try {
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
