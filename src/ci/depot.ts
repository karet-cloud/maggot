/**
 * Depot sandboxes, spoken to over the Connect protocol with plain fetch so it runs in a Worker (Depot's
 * own SDK, @depot/sandbox, needs Node's HTTP/2 client). Unary calls are Connect JSON; RunCommand is a
 * server stream of enveloped JSON messages. Messages follow `depot.sandbox.v1` as published in
 * @depot/sandbox 0.1.0-beta.4: https://depot.dev/docs/api/sandbox-sdk-reference (the API is in beta).
 */

import { ExecTimeoutError, EXEC_TIMEOUT_MS, type ExecOptions, type ExecResult, type Sandbox } from "./sandbox.ts";

export const DEPOT_API = "https://api.depot.dev";
const SERVICE = "depot.sandbox.v1.SandboxService";
/** Depot's documented range; a job's workflow asks for one of these. */
export const DEPOT_VCPUS = [2, 4, 8, 16, 32, 64];
/** Sandboxes live at most a day. */
export const DEPOT_MAX_MINUTES = 24 * 60;
const UNARY_TIMEOUT_MS = 30_000;

export interface DepotCredentials {
	token: string;
	/** Needed for app and service tokens, and user tokens in more than one organization (`x-depot-org`). */
	orgId?: string | null;
}

export class DepotError extends Error {
	/** A Connect error code (`not_found`, `failed_precondition`, …) or `http_<status>`. */
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}

	/** Worth trying again: the network, Depot itself, or a sandbox still starting. */
	get transient(): boolean {
		return ["unavailable", "deadline_exceeded", "internal", "unknown", "resource_exhausted", "aborted", "data_loss"].includes(this.code) || /^http_5\d\d$/.test(this.code) || this.code === "http_429";
	}
}

export type DepotStatus = "created" | "assigned" | "starting" | "running" | "finished" | "cancelled" | "failed" | "unspecified";

export interface DepotSandboxInfo {
	id: string;
	name: string | null;
	status: DepotStatus;
	errorMessage: string | null;
}

const STATUSES: DepotStatus[] = ["unspecified", "created", "assigned", "starting", "running", "finished", "cancelled", "failed"];

/** Proto3 JSON writes enums by name (`SANDBOX_STATUS_RUNNING`), though numbers are allowed too. */
function status(value: unknown): DepotStatus {
	if (typeof value === "number") return STATUSES[value] ?? "unspecified";
	if (typeof value === "string") {
		const name = value.replace(/^SANDBOX_STATUS_/, "").toLowerCase();
		if ((STATUSES as string[]).includes(name)) return name as DepotStatus;
	}
	return "unspecified";
}

export const isTerminal = (s: DepotStatus) => s === "finished" || s === "cancelled" || s === "failed";

interface SandboxMessage {
	sandboxId?: string;
	name?: string;
	status?: unknown;
	errorMessage?: string;
}

function info(sandbox: SandboxMessage | undefined, what: string): DepotSandboxInfo {
	if (!sandbox?.sandboxId) throw new DepotError("internal", `Depot's ${what} answer had no sandbox`);
	return { id: sandbox.sandboxId, name: sandbox.name ?? null, status: status(sandbox.status), errorMessage: sandbox.errorMessage || null };
}

/** A Connect error body, `{code, message}`, as a DepotError. */
function connectError(status: number, body: unknown): DepotError {
	const b = (body ?? {}) as { code?: string; message?: string };
	return new DepotError(b.code ?? `http_${status}`, b.message ?? `Depot answered ${status}`);
}

function envelope(message: unknown): Uint8Array<ArrayBuffer> {
	return envelopes([message]);
}

/** A Connect request stream: each message enveloped, one after another. The body's end ends the stream. */
function envelopes(messages: unknown[]): Uint8Array<ArrayBuffer> {
	const parts = messages.map((m) => new TextEncoder().encode(JSON.stringify(m)));
	const out = new Uint8Array(parts.reduce((n, p) => n + 5 + p.length, 0));
	let at = 0;
	for (const json of parts) {
		new DataView(out.buffer).setUint32(at + 1, json.length);
		out.set(json, at + 5);
		at += 5 + json.length;
	}
	return out;
}

/** Reads a Connect server stream: data messages, then an end-of-stream message (flag 0x02). */
export async function* connectStream(body: ReadableStream<Uint8Array> | null): AsyncGenerator<unknown> {
	if (!body) throw new DepotError("internal", "Depot answered without a body");
	const reader = body.getReader();
	let buffer = new Uint8Array(0);
	const decoder = new TextDecoder();
	try {
		while (true) {
			while (buffer.length >= 5) {
				const flags = buffer[0];
				const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(1);
				if (buffer.length < 5 + length) break;
				if (flags & 0x01) throw new DepotError("internal", "Depot sent a compressed message, which wasn't asked for");
				const message = JSON.parse(decoder.decode(buffer.subarray(5, 5 + length)));
				buffer = buffer.slice(5 + length);
				if (flags & 0x02) {
					const end = message as { error?: { code?: string; message?: string } };
					if (end.error) throw connectError(200, end.error);
					return;
				}
				yield message;
			}
			const { value, done } = await reader.read();
			if (done) throw new DepotError("unavailable", "Depot's stream ended before it finished");
			const next = new Uint8Array(buffer.length + value.length);
			next.set(buffer);
			next.set(value, buffer.length);
			buffer = next;
		}
	} finally {
		reader.releaseLock();
		body.cancel().catch(() => {});
	}
}

function base64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

/** Protobuf `bytes` in JSON: base64, standard or URL-safe. */
function base64Bytes(value: string | undefined): Uint8Array {
	if (!value) return new Uint8Array(0);
	const bin = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Bytes per WriteFile data message. */
const WRITE_CHUNK = 256 * 1024;

/** Output kept per command; control commands print far less (log slices are a fraction of this). */
const MAX_OUTPUT = 4 * 1024 * 1024;

export class DepotApi {
	private readonly creds: DepotCredentials;
	private readonly fetch: typeof fetch;
	private readonly endpoint: string;

	constructor(creds: DepotCredentials, opts: { fetch?: typeof fetch; endpoint?: string } = {}) {
		this.creds = creds;
		this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
		this.endpoint = opts.endpoint ?? DEPOT_API;
	}

	private headers(contentType: string): Headers {
		const h = new Headers({ authorization: `Bearer ${this.creds.token}`, "connect-protocol-version": "1", "content-type": contentType });
		if (this.creds.orgId) h.set("x-depot-org", this.creds.orgId);
		return h;
	}

	private async post(method: string, contentType: string, body: BodyInit, timeoutMs: number): Promise<Response> {
		try {
			return await this.fetch(`${this.endpoint}/${SERVICE}/${method}`, { method: "POST", headers: this.headers(contentType), body, signal: AbortSignal.timeout(timeoutMs) });
		} catch (err) {
			if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new DepotError("deadline_exceeded", `Depot didn't answer ${method} within ${Math.round(timeoutMs / 1000)}s`);
			throw new DepotError("unavailable", `Couldn't reach Depot: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async unary<T>(method: string, request: unknown, timeoutMs = UNARY_TIMEOUT_MS): Promise<T> {
		const res = await this.post(method, "application/json", JSON.stringify(request), timeoutMs);
		const text = await res.text();
		let body: unknown = null;
		try {
			body = text ? JSON.parse(text) : {};
		} catch {
			throw new DepotError(`http_${res.status}`, `Depot answered ${res.status}: ${text.slice(0, 200)}`);
		}
		if (!res.ok) throw connectError(res.status, body);
		return body as T;
	}

	/** Creates a sandbox. Its lifetime counts from now, provisioning included. */
	async create(opts: { name: string; vcpus: number; timeoutMinutes: number; env?: Record<string, string> }): Promise<DepotSandboxInfo> {
		if (!DEPOT_VCPUS.includes(opts.vcpus)) throw new DepotError("invalid_argument", `Depot sandboxes come with ${DEPOT_VCPUS.join(", ")} vCPUs`);
		const { sandbox } = await this.unary<{ sandbox?: SandboxMessage }>("CreateSandbox", {
			name: opts.name,
			// Depot's defaults are 2 vCPUs with 4 GB; memory scales with the vCPUs asked for.
			resources: { vcpus: opts.vcpus, memoryMb: opts.vcpus * 2048, diskGb: 100 },
			env: opts.env ?? {},
			timeoutMinutes: Math.min(DEPOT_MAX_MINUTES, Math.max(1, Math.ceil(opts.timeoutMinutes))),
			disableTailnet: true,
		});
		return info(sandbox, "CreateSandbox");
	}

	async get(id: string): Promise<DepotSandboxInfo> {
		const { sandbox } = await this.unary<{ sandbox?: SandboxMessage }>("GetSandbox", { id });
		return info(sandbox, "GetSandbox");
	}

	/**
	 * The live sandbox with this name, if any. Names are unique in an organization, so this finds the
	 * sandbox a create made before the job lost track of its answer (a restart part-way through).
	 */
	async findByName(name: string, pages = 5): Promise<DepotSandboxInfo | null> {
		let pageToken: string | undefined;
		for (let i = 0; i < pages; i++) {
			const res = await this.unary<{ sandboxes?: SandboxMessage[]; nextPageToken?: string }>("ListSandboxes", { pageSize: 100, pageToken });
			for (const s of res.sandboxes ?? []) {
				const found = info(s, "ListSandboxes");
				if (found.name === name && !isTerminal(found.status)) return found;
			}
			pageToken = res.nextPageToken || undefined;
			if (!pageToken) break;
		}
		return null;
	}

	/** Stops a sandbox at once. One that has already stopped is fine: that's what was wanted. */
	async kill(id: string): Promise<void> {
		await this.unary("KillSandbox", { sandbox: { id } }).catch((err) => {
			if (!(err instanceof DepotError && (err.code === "failed_precondition" || err.code === "not_found"))) throw err;
		});
	}

	/** Checks a token without creating anything: lists one sandbox. */
	async check(): Promise<void> {
		await this.unary("ListSandboxes", { pageSize: 1 });
	}

	/** Sends a streaming request (Connect's enveloped JSON), checking the answer's HTTP status. */
	private async streaming(method: string, body: Uint8Array<ArrayBuffer>, timeoutMs: number): Promise<Response> {
		const res = await this.post(method, "application/connect+json", body, timeoutMs);
		if (!res.ok) {
			const text = await res.text();
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(text);
			} catch {}
			throw connectError(res.status, parsed ?? { message: text.slice(0, 200) });
		}
		return res;
	}

	/**
	 * Writes a file in the sandbox (as its user) with the WriteFile client stream: an Init message
	 * naming the file, then its bytes. Connect runs client streams over HTTP/1.1 as one request body.
	 * The content goes to the sandbox's disk only; unlike a command's env, Depot keeps no record of it.
	 */
	async writeFile(id: string, path: string, content: string, mode = 0o600): Promise<void> {
		const bytes = new TextEncoder().encode(content);
		const messages: unknown[] = [{ init: { sandbox: { id }, path, mode, createDirectories: true } }];
		for (let i = 0; i < bytes.length; i += WRITE_CHUNK) messages.push({ data: base64(bytes.subarray(i, i + WRITE_CHUNK)) });
		const res = await this.streaming("WriteFile", envelopes(messages), UNARY_TIMEOUT_MS);
		let written: number | null = null;
		for await (const raw of connectStream(res.body)) written = Number((raw as { bytesWritten?: string | number }).bytesWritten ?? 0);
		if (written !== bytes.length) throw new DepotError("data_loss", `Depot wrote ${written ?? "no"} of ${bytes.length} bytes to ${path}`);
	}

	/**
	 * Reads a file from the sandbox with the ReadFile server stream (FileChunk messages), so its content
	 * never becomes a command's output, which Depot keeps. Refuses files over `maxBytes`.
	 */
	async readFile(id: string, path: string, maxBytes = 1024 * 1024): Promise<Uint8Array> {
		const res = await this.streaming("ReadFile", envelope({ sandbox: { id }, path }), UNARY_TIMEOUT_MS);
		const parts: Uint8Array[] = [];
		let size = 0;
		for await (const raw of connectStream(res.body)) {
			const bytes = base64Bytes((raw as { data?: string }).data);
			size += bytes.length;
			if (size > maxBytes) throw new DepotError("resource_exhausted", `${path} is larger than ${maxBytes} bytes`);
			parts.push(bytes);
		}
		const all = new Uint8Array(size);
		let at = 0;
		for (const p of parts) {
			all.set(p, at);
			at += p.length;
		}
		return all;
	}

	/**
	 * Runs a command to completion. Depot runs it without a shell, as the sandbox's user unless
	 * `root` (then through `sudo -E`). A `detached` command is only started: Depot answers once it's
	 * running, keeps none of its output, and lets it (and what it starts) run on.
	 */
	async run(id: string, argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
		const [cmd, ...args] = argv;
		const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
		const request = { sandbox: { id }, cmd, args, cwd: opts.cwd, env: opts.env ?? {}, ...(opts.root ? { sudo: true } : {}), ...(opts.detached ? { detached: true } : {}) };
		const res = await this.streaming("RunCommand", envelope(request), timeoutMs);
		let started = false;
		const out: Uint8Array[] = [];
		const err: Uint8Array[] = [];
		let size = 0;
		let dropped = 0;
		let exitCode: number | null = null;
		try {
			for await (const raw of connectStream(res.body)) {
				const event = raw as {
					started?: unknown;
					stdout?: { data?: string };
					stderr?: { data?: string };
					finished?: { exitCode?: number };
					error?: { reason?: string };
					evicted?: { droppedBytesStdout?: string | number; droppedBytesStderr?: string | number };
				};
				if (event.started) started = true;
				else if (event.stdout || event.stderr) {
					const bytes = base64Bytes((event.stdout ?? event.stderr)?.data);
					if (size + bytes.length <= MAX_OUTPUT) {
						(event.stdout ? out : err).push(bytes);
						size += bytes.length;
					} else dropped += bytes.length;
				} else if (event.evicted) dropped += Number(event.evicted.droppedBytesStdout ?? 0) + Number(event.evicted.droppedBytesStderr ?? 0);
				// proto3 JSON leaves out zero values, so a clean exit can arrive as `finished: {}`.
				else if (event.finished) exitCode = event.finished.exitCode ?? 0;
				else if (event.error) throw new DepotError("command_failed", event.error.reason ?? "The command couldn't run");
			}
		} catch (e) {
			if (e instanceof DepotError && e.code === "deadline_exceeded") throw new ExecTimeoutError(`A command in the Depot sandbox took longer than ${Math.round(timeoutMs / 1000)}s`);
			if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ExecTimeoutError(`A command in the Depot sandbox took longer than ${Math.round(timeoutMs / 1000)}s`);
			throw e;
		}
		if (opts.detached && exitCode === null) {
			if (!started) throw new DepotError("internal", "Depot ended a detached command without starting it");
			return { exitCode: 0, stdout: "", stderr: "" };
		}
		if (exitCode === null) throw new DepotError("internal", "Depot ended the command without an exit code");
		// Control commands print little; losing output here would corrupt a log slice, so it's an error.
		if (dropped) throw new DepotError("resource_exhausted", `Depot dropped ${dropped} bytes of a command's output`);
		return { exitCode, stdout: join(out), stderr: join(err) };
	}
}

export async function checkDepotCredentials(creds: DepotCredentials): Promise<void> {
	await new DepotApi(creds).check();
}

export class DepotSandbox implements Sandbox {
	private readonly api: DepotApi;
	readonly id: string;

	constructor(api: DepotApi, id: string) {
		this.api = api;
		this.id = id;
	}

	exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
		return this.api.run(this.id, argv, opts);
	}

	writeFile(path: string, content: string): Promise<void> {
		return this.api.writeFile(this.id, path, content);
	}

	async readFile(path: string): Promise<string> {
		return new TextDecoder().decode(await this.api.readFile(this.id, path));
	}
}

function join(parts: Uint8Array[]): string {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const all = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		all.set(p, at);
		at += p.length;
	}
	return new TextDecoder().decode(all);
}
