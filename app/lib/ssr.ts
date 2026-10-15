// The API transport, isomorphic: same-origin fetches in the browser, in-process calls while rendering on
// the server (./ssr.server.ts, which the compiler drops from the browser bundle along with these .server branches).
import { createIsomorphicFn } from "@tanstack/react-start";
import { serverFetch, ssrWaitMs } from "./ssr.server.ts";

export const isServer = typeof window === "undefined";

/** `fetch("/api" + path)`, authenticated by the session cookie. */
export const apiFetch = createIsomorphicFn()
	.server((path: string, init?: RequestInit) => serverFetch(path, init))
	.client((path: string, init?: RequestInit) => fetch(`/api${path}`, { credentials: "same-origin", ...init }));

/** How much longer a server render may wait for data; 0 in the browser. */
export const serverWaitMs = createIsomorphicFn()
	.server(() => ssrWaitMs())
	.client(() => 0);
