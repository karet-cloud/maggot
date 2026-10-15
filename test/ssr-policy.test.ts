import assert from "node:assert/strict";
import { test } from "node:test";
import { dehydrate, experimental_streamedQuery as streamedQuery, hydrate, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ApiError } from "../app/lib/api-error.ts";
import { browserOnly, preloadQueries } from "../app/lib/preload.ts";
import { keepSendable, sendable } from "../app/lib/ssr-policy.ts";

const DIFF = ["diff"];
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** A stream that sends its header, then nothing more until `end` is called. */
function stalledStream() {
	let end = () => {};
	const ended = new Promise<void>((ok) => (end = ok));
	async function* chunks() {
		yield "header";
		await ended;
		yield "body";
	}
	return { chunks, end };
}

/** What a page shows for the diff: its chunks, or the fallback while it loads. */
function Page() {
	const diff = useQuery({ queryKey: DIFF, queryFn: () => [] as string[], staleTime: Infinity });
	return createElement("p", null, diff.data ? diff.data.join("+") : "loading");
}

const render = (client: QueryClient) => renderToString(createElement(QueryClientProvider, { client }, createElement(Page)));

/** Like the router, sweep the entire cache immediately before dehydration and rendering. */
function serverRender(server: QueryClient) {
	keepSendable(server);
	const state = dehydrate(server, { shouldDehydrateQuery: sendable });
	return { html: render(server), state };
}

test("success while still fetching at the preload deadline is neither dehydrated nor kept", async (t) => {
	const server = client();
	const browser = client();
	const stream = stalledStream();
	t.after(() => { stream.end(); server.clear(); browser.clear(); });
	const firstChunk = new Promise<void>((ok) => {
		const unsubscribe = server.getQueryCache().subscribe(({ query }) => {
			if (query.state.status === "success") { unsubscribe(); ok(); }
		});
	});
	const loading = preloadQueries(server, [{ queryKey: DIFF, queryFn: streamedQuery({ streamFn: ({ signal }) => {
		// Stream transports consume the signal so TanStack can stop appending after cancellation.
		void signal;
		return stream.chunks();
	} }), staleTime: Infinity }], true, 50);
	await firstChunk;
	const query = server.getQueryCache().find({ queryKey: DIFF })!;
	assert.equal(query.state.status, "success");
	assert.equal(query.state.fetchStatus, "fetching");
	assert.equal(sendable(query), false);
	assert.equal(dehydrate(server, { shouldDehydrateQuery: sendable }).queries.length, 0);

	await loading;
	// Check preload itself removed the partial data, before the router's final sweep.
	assert.equal(server.getQueryState(DIFF), undefined);
	const { html, state } = serverRender(server);
	assert.equal(state.queries.length, 0);
	assert.match(html, /loading/);
	hydrate(browser, state);
	assert.equal(render(browser), html);
	// A cancelled stream must not repopulate the cache when its next chunk arrives.
	stream.end();
	await new Promise((ok) => setImmediate(ok));
	assert.equal(server.getQueryData(DIFF), undefined);
});

test("a settled stream is kept and the browser renders the same complete data", async (t) => {
	const server = client();
	const browser = client();
	t.after(() => { server.clear(); browser.clear(); });
	const stream = stalledStream();
	stream.end();
	await preloadQueries(server, [{ queryKey: DIFF, queryFn: streamedQuery({ streamFn: stream.chunks }), staleTime: Infinity }], true, 100);
	const { html, state } = serverRender(server);
	assert.equal(state.queries.length, 1);
	assert.match(html, /header\+body/);
	hydrate(browser, state);
	assert.equal(render(browser), html);
});

test("browser-only queries are never fetched by server preload, including helper and default metadata", async (t) => {
	const server = client();
	t.after(() => server.clear());
	let calls = 0;
	const options = { queryKey: ["direct"], queryFn: () => ++calls, meta: { browserOnly: true } };
	const helper = browserOnly(false, { queryKey: ["helper"], queryFn: () => ++calls, meta: { label: "preserved" } });
	assert.notEqual(helper, false);
	if (!helper) return;
	assert.deepEqual(helper.meta, { label: "preserved", browserOnly: true });
	assert.equal(browserOnly(true, options), false);
	server.setQueryDefaults(["default"], { meta: { browserOnly: true } });
	await preloadQueries(server, [options, helper, { queryKey: ["default"], queryFn: () => ++calls }], true, 100);
	assert.equal(calls, 0);
	assert.equal(server.getQueryCache().getAll().length, 0);

	// The same options still fetch normally in the browser.
	await preloadQueries(server, [options, helper], false, 100);
	assert.equal(calls, 2);
});

test("browser-only data already cached or started is removed even when preload has nothing to wait for", async (t) => {
	const server = client();
	t.after(() => server.clear());
	server.setQueryData(["cached"], "must not render");
	let calls = 0;
	await preloadQueries(server, [{ queryKey: ["cached"], queryFn: () => ++calls, meta: { browserOnly: true } }], true, 100);
	assert.equal(server.getQueryState(["cached"]), undefined);
	assert.equal(calls, 0);

	let signal: AbortSignal | undefined;
	const fetching = server.prefetchQuery({ queryKey: ["started"], meta: { browserOnly: true }, queryFn: (ctx) => {
		signal = ctx.signal;
		return new Promise(() => {});
	} });
	// The existing query's metadata is honored even if this caller doesn't repeat it.
	await preloadQueries(server, [{ queryKey: ["started"], queryFn: () => ++calls }], true, 100);
	await fetching;
	assert.equal(signal?.aborted, true);
	assert.equal(server.getQueryState(["started"]), undefined);
	assert.equal(calls, 0);
});

test("terminal errors are kept and dehydrated; transient errors are dropped by preload", async (t) => {
	const server = client();
	t.after(() => server.clear());
	const terminal = [400, 401, 403, 404, 422, 499];
	const transient = [408, 429, 500, 503];
	const options = [...terminal, ...transient].map((status) => ({ queryKey: [status], queryFn: () => Promise.reject(new ApiError(status, "X", "x")) }));
	await preloadQueries(server, [...options, { queryKey: ["network"], queryFn: () => Promise.reject(new Error("network")) }], true, 100);
	assert.deepEqual(server.getQueryCache().getAll().map((q) => q.queryKey[0]), terminal);
	assert.deepEqual(dehydrate(server, { shouldDehydrateQuery: sendable }).queries.map((q) => q.queryKey[0]), terminal);
	for (const status of terminal) assert.equal(server.getQueryState([status])?.status, "error");
});

test("exhausted deadlines still clean cached transient and fetching queries without touching other loaders", async (t) => {
	const server = client();
	t.after(() => server.clear());
	await server.prefetchQuery({ queryKey: ["transient"], queryFn: () => Promise.reject(new ApiError(503, "X", "x")) });
	server.setQueryData(["fetching"], "partial");
	server.getQueryCache().find({ queryKey: ["fetching"] })!.setState({ fetchStatus: "fetching" });
	const other = server.prefetchQuery({ queryKey: ["other-loader"], queryFn: () => new Promise(() => {}) });
	let calls = 0;
	await preloadQueries(server, ["transient", "fetching", "new"].map((key) => ({ queryKey: [key], queryFn: () => ++calls })), true, 0);
	assert.equal(calls, 0);
	assert.deepEqual(server.getQueryCache().getAll().map((q) => q.queryKey[0]), ["other-loader"]);
	keepSendable(server);
	await other;
	assert.equal(server.getQueryCache().getAll().length, 0);
});

test("the final sweep removes browser-only, pending and paused queries started outside loaders", async (t) => {
	const server = client();
	t.after(() => server.clear());
	await server.prefetchQuery({ queryKey: ["browser-only"], queryFn: () => "big", meta: { browserOnly: true } });
	const pending = server.prefetchQuery({ queryKey: ["pending"], queryFn: () => new Promise(() => {}) });
	server.setQueryData(["paused"], "old data");
	server.getQueryCache().find({ queryKey: ["paused"] })!.setState({ fetchStatus: "paused" });
	await server.prefetchQuery({ queryKey: ["ok"], queryFn: () => "fine" });
	assert.deepEqual(dehydrate(server, { shouldDehydrateQuery: sendable }).queries.map((q) => q.queryKey[0]), ["ok"]);
	keepSendable(server);
	await pending;
	assert.deepEqual(server.getQueryCache().getAll().map((q) => q.queryKey[0]), ["ok"]);
});
