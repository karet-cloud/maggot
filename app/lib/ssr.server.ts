// Server only (TanStack Start keeps *.server.* files out of the browser bundle). While a page renders on
// the server, its API calls run against the Hono API in-process, as the visitor, with no network hop.
import { getGlobalStartContext } from "@tanstack/react-start";

/** What app/server.ts hands each page render. */
export interface SsrContext {
	/** The visitor's request for the page. */
	request: Request;
	/** The API's fetch, bound to this request's env and execution context. */
	api: (request: Request) => Response | Promise<Response>;
	/** When the render stops waiting for data (epoch ms); what's still loading streams in after. */
	deadline: number;
}

declare module "@tanstack/react-start" {
	interface Register {
		server: { requestContext: { ssr: SsrContext } };
	}
}

export function ssrContext(): SsrContext {
	const ssr = (getGlobalStartContext() as { ssr?: SsrContext } | undefined)?.ssr;
	if (!ssr) throw new Error("Not rendering a page");
	return ssr;
}

/** The visitor's headers the API looks at: who they are (session cookie, token) and where they're from (rate limits). */
const FORWARD = ["cookie", "authorization", "user-agent", "accept-language", "cf-connecting-ip"];

/** `fetch("/api" + path)` as the visitor, answered by the API in this Worker. */
export function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const { request, api } = ssrContext();
	const headers = new Headers(init.headers);
	for (const name of FORWARD) {
		const value = request.headers.get(name);
		if (value !== null && !headers.has(name)) headers.set(name, value);
	}
	return Promise.resolve(api(new Request(new URL(`/api${path}`, request.url), { ...init, headers })));
}

/** How much longer the render may wait for data. */
export const ssrWaitMs = () => Math.max(0, ssrContext().deadline - Date.now());
