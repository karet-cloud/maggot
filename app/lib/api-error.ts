// The API client's errors, apart from the client so the SSR policy (and its tests) can use them alone.

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** Whether asking again gets the same answer: a 4xx other than a timeout or a rate limit. */
export const isTerminal = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

/** Content a server render leaves to the browser (too big to send with the page); transient, so it's never kept. */
export const tooBigToRender = () => new ApiError(503, "TOO_BIG_TO_RENDER", "Loaded in the browser");
