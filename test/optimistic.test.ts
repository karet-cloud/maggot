import assert from "node:assert/strict";
import { test } from "node:test";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { optimisticMutation, optimisticPending, patch } from "../app/lib/optimistic-cache.ts";

const LABELS = ["labels"];

/** A query client whose refetches fail (offline, a 5xx), with labels a, b on screen. */
function setup() {
	let fetches = 0;
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				queryFn: async () => {
					fetches++;
					throw new Error("offline");
				},
			},
		},
	});
	queryClient.setQueryData(LABELS, ["a", "b"]);
	// Watched, as on a page, so invalidating it refetches.
	new QueryObserver(queryClient, { queryKey: LABELS, staleTime: Infinity }).subscribe(() => {});
	return { queryClient, fetches: () => fetches };
}

/** A pending request the test settles by hand. */
function deferred() {
	let resolve!: () => void, reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

/** Starts an optimistic "add label" call whose request is `request`. */
function add(queryClient: QueryClient, label: string, request: Promise<void>, errors: string[]) {
	const observer = new MutationObserver(
		queryClient,
		optimisticMutation<string, void>(queryClient, {
			mutationFn: () => request,
			apply: (l) => [patch<string[]>(LABELS, (old) => [...old, l])],
			onError: (error) => errors.push(error.message),
		}),
	);
	return observer.mutate(label).catch(() => undefined);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const labels = (queryClient: QueryClient) => queryClient.getQueryData<string[]>(LABELS);

test("a single failure restores its snapshot as soon as it settles", async () => {
	const { queryClient } = setup();
	const errors: string[] = [];
	const req = deferred();
	const done = add(queryClient, "c", req.promise, errors);
	await tick();
	assert.deepEqual(labels(queryClient), ["a", "b", "c"]);
	assert.ok(optimisticPending(queryClient));
	req.reject(new Error("nope"));
	await done;
	assert.deepEqual(labels(queryClient), ["a", "b"]);
	assert.deepEqual(errors, ["nope"]);
	assert.equal(optimisticPending(queryClient), false);
});

test("two overlapping failures both revert though the refetch fails", async () => {
	const { queryClient, fetches } = setup();
	const errors: string[] = [];
	const one = deferred();
	const two = deferred();
	const first = add(queryClient, "c", one.promise, errors);
	const second = add(queryClient, "d", two.promise, errors);
	await tick();
	assert.deepEqual(labels(queryClient), ["a", "b", "c", "d"]);
	one.reject(new Error("first"));
	await first;
	// The second edit is still pending, so it stays shown.
	assert.deepEqual(labels(queryClient), ["a", "b", "c", "d"]);
	two.reject(new Error("second"));
	await second;
	await tick();
	assert.deepEqual(labels(queryClient), ["a", "b"]);
	assert.deepEqual(errors, ["first", "second"]);
	assert.ok(fetches() > 0, "the touched query still refetches");
	assert.equal(optimisticPending(queryClient), false);
});

test("success then failure keeps only the success", async () => {
	const { queryClient } = setup();
	const errors: string[] = [];
	const one = deferred();
	const two = deferred();
	const first = add(queryClient, "c", one.promise, errors);
	const second = add(queryClient, "d", two.promise, errors);
	await tick();
	one.resolve();
	await first;
	two.reject(new Error("second"));
	await second;
	await tick();
	assert.deepEqual(labels(queryClient), ["a", "b", "c"]);
	assert.deepEqual(errors, ["second"]);
});

test("failure then success keeps only the success", async () => {
	const { queryClient } = setup();
	const errors: string[] = [];
	const one = deferred();
	const two = deferred();
	const first = add(queryClient, "c", one.promise, errors);
	const second = add(queryClient, "d", two.promise, errors);
	await tick();
	one.reject(new Error("first"));
	await first;
	two.resolve();
	await second;
	await tick();
	assert.deepEqual(labels(queryClient), ["a", "b", "d"]);
	assert.deepEqual(errors, ["first"]);
});

test("requests go out one at a time, in call order", async () => {
	const { queryClient } = setup();
	const started: string[] = [];
	const one = deferred();
	const run = (label: string, request: Promise<void>) =>
		new MutationObserver(
			queryClient,
			optimisticMutation<string, void>(queryClient, {
				mutationFn: (l) => (started.push(l), request),
				apply: (l) => [patch<string[]>(LABELS, (old) => [...old, l])],
			}),
		).mutate(label);
	const first = run("c", one.promise);
	const second = run("d", Promise.resolve());
	await tick();
	assert.deepEqual(started, ["c"]);
	one.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(started, ["c", "d"]);
	assert.deepEqual(labels(queryClient), ["a", "b", "c", "d"]);
});

test("a query the server rewrote during the burst is left to the refetch", async () => {
	const { queryClient } = setup();
	const errors: string[] = [];
	const one = deferred();
	const two = deferred();
	const first = add(queryClient, "c", one.promise, errors);
	const second = add(queryClient, "d", two.promise, errors);
	await tick();
	one.reject(new Error("first"));
	await first;
	queryClient.setQueryData(LABELS, ["server"]);
	two.reject(new Error("second"));
	await second;
	await tick();
	assert.deepEqual(labels(queryClient), ["server"]);
});
