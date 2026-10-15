import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PROBE_LIMIT, probeRemote } from "../src/git/protocol.ts";

const A = "a".repeat(40);
const enc = new TextEncoder();
const pkt = (line: string) => `${(enc.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;
const HEADER = `${pkt("# service=git-upload-pack\n")}0000`;
const realFetch = globalThis.fetch;

/** Serves `chunks` (or an endless generator) as the advertisement, counting bytes pulled and noting cancellation. */
function serve(chunks: Iterable<string | Uint8Array>, contentType = "application/x-git-upload-pack-advertisement") {
	const seen = { bytes: 0, cancelled: false };
	globalThis.fetch = (async () => {
		const it = chunks[Symbol.iterator]();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = it.next();
				if (next.done) return controller.close();
				const bytes = typeof next.value === "string" ? enc.encode(next.value) : next.value;
				seen.bytes += bytes.length;
				controller.enqueue(bytes);
			},
			cancel() {
				seen.cancelled = true;
			},
		}, { highWaterMark: 0 });
		return new Response(body, { headers: { "content-type": contentType } });
	}) as typeof fetch;
	return seen;
}

function* forever(chunk: string) {
	for (;;) yield chunk;
}

function* followedBy(prefix: string[], chunk: string) {
	yield* prefix;
	yield* forever(chunk);
}

describe("probeRemote", () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("reads HEAD's branch from the first ref line, split across chunks", async () => {
		const advert = `${HEADER}${pkt(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/release+2026 agent=x\n`)}${pkt(`${A} refs/heads/release+2026\n`)}0000`;
		const seen = serve(advert.match(/[\s\S]{1,7}/g) ?? []);
		assert.deepEqual(await probeRemote("https://example.com/r"), { head: "release+2026" });
		assert.ok(seen.cancelled);
	});

	it("accepts an advertisement without the service header, and an empty repository", async () => {
		serve([pkt(`${A} HEAD\0symref=HEAD:refs/heads/main\n`)]);
		assert.deepEqual(await probeRemote("https://example.com/r"), { head: "main" });
		serve([`${HEADER}${pkt(`${"0".repeat(40)} capabilities^{}\0agent=x\n`)}0000`]);
		assert.deepEqual(await probeRemote("https://example.com/r"), { head: undefined });
		serve([HEADER, "00", "00"]);
		assert.deepEqual(await probeRemote("https://example.com/r"), { head: undefined });
	});

	it("stops at the limit when a remote sends endless flush packets", async () => {
		const seen = serve(forever("0000".repeat(1024)));
		assert.equal(await probeRemote("https://example.com/r"), null);
		assert.ok(seen.bytes <= PROBE_LIMIT + 4096, `read ${seen.bytes} bytes`);
		assert.ok(seen.cancelled);
	});

	it("stops at the limit when one packet never ends", async () => {
		const seen = serve(followedBy([HEADER, "fff0"], "x".repeat(4096)));
		assert.equal(await probeRemote("https://example.com/r"), null);
		assert.ok(seen.bytes <= PROBE_LIMIT + 8192, `read ${seen.bytes} bytes`);
		assert.ok(seen.cancelled);
	});

	it("cancels without another read when the byte limit is reached exactly", async () => {
		const prefix = `${HEADER}fff0`;
		const seen = serve(followedBy([prefix, "x".repeat(PROBE_LIMIT - enc.encode(prefix).length)], "x"));
		assert.equal(await probeRemote("https://example.com/r"), null);
		assert.equal(seen.bytes, PROBE_LIMIT);
		assert.ok(seen.cancelled);
	});

	it("finds HEAD in a large delivered chunk without buffering its remaining refs", async () => {
		const seen = serve([`${HEADER}${pkt(`${A} HEAD\0symref=HEAD:refs/heads/master\n`)}${"x".repeat(PROBE_LIMIT * 2)}`]);
		assert.deepEqual(await probeRemote("https://example.com/r"), { head: "master" });
		assert.ok(seen.cancelled);
	});

	it("gives up at once on junk", async () => {
		for (const junk of ["<html>not git</html>", `${HEADER}0001`, `${HEADER}0002`, `${HEADER}0003`, `${HEADER}0004`, `${HEADER}ffff`, `${HEADER}0g05`, `${HEADER}0000`, `${HEADER}${pkt("hello\n")}`, "0000", ""]) {
			const seen = serve(followedBy([junk], "0000"));
			assert.equal(await probeRemote("https://example.com/r"), null, JSON.stringify(junk));
			assert.ok(seen.bytes < 4096, `${JSON.stringify(junk)}: read ${seen.bytes} bytes`);
		}
	});

	it("rejects truncated headers and payloads, and a missing service flush", async () => {
		for (const advert of ["", "00", HEADER, `${HEADER}00`, `${HEADER}0010short`, pkt("# service=git-upload-pack\n"), `${pkt("# service=git-upload-pack\n")}${pkt(`${A} HEAD\n`)}`]) {
			serve([advert]);
			assert.equal(await probeRemote("https://example.com/r"), null, JSON.stringify(advert));
		}
	});

	it("needs a git content type", async () => {
		const seen = serve([`${HEADER}${pkt(`${A} HEAD\0symref=HEAD:refs/heads/main\n`)}`], "text/html");
		assert.equal(await probeRemote("https://example.com/r"), null);
		assert.equal(seen.bytes, 0);
		assert.ok(seen.cancelled);
	});
});
