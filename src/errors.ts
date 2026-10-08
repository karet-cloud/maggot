// Durable Object RPC preserves an error's message but not custom properties, so status and code
// travel inside the message as a "[status:CODE] " prefix and are parsed back out by toHttpError.
const PREFIX = /^\[(\d{3}):([A-Z_]+)\] /;

export class HttpError extends Error {
	readonly status: number;
	readonly code: string;
	readonly detail: string;

	constructor(status: number, code: string, detail: string) {
		super(`[${status}:${code}] ${detail}`);
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}

const ARTIFACTS_STATUS: Record<string, number> = {
	NOT_FOUND: 404,
	ALREADY_EXISTS: 409,
	CREATE_IN_PROGRESS: 409,
	IMPORT_IN_PROGRESS: 409,
	FORK_IN_PROGRESS: 409,
	INVALID_INPUT: 400,
	INVALID_REPO_NAME: 400,
	INVALID_TTL: 400,
	INVALID_URL: 400,
	REMOTE_AUTH_REQUIRED: 400,
};

export function toHttpError(err: unknown): HttpError {
	if (err instanceof HttpError) return err;
	const message = err instanceof Error ? err.message : String(err);
	const prefixed = PREFIX.exec(message);
	if (prefixed) return new HttpError(Number(prefixed[1]), prefixed[2], message.slice(prefixed[0].length));
	const code = errorCode(err) ?? "INTERNAL_ERROR";
	return new HttpError(ARTIFACTS_STATUS[code] ?? 500, code, message);
}

export function errorCode(err: unknown): string | undefined {
	const code = (err as { code?: unknown })?.code;
	return typeof code === "string" ? code : undefined;
}
