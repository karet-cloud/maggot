import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLsRefs, pointHeadV0, pointHeadV2 } from "../src/git/head.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const enc = new TextEncoder();
const dec = new TextDecoder();
const pkt = (line: string) => `${(enc.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;
const bytes = (...parts: string[]) => enc.encode(parts.join(""));

describe("pointHeadV0", () => {
	it("moves HEAD and its symref to the branch", () => {
		const advert = bytes(
			pkt("# service=git-upload-pack\n"),
			"0000",
			pkt(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=x\n`),
			pkt(`${A} refs/heads/main\n`),
			pkt(`${B} refs/heads/master\n`),
			"0000",
		);
		assert.equal(dec.decode(pointHeadV0(advert, "master")), 
			[pkt("# service=git-upload-pack\n"), "0000", pkt(`${B} HEAD\0multi_ack agent=x symref=HEAD:refs/heads/master\n`), pkt(`${A} refs/heads/main\n`), pkt(`${B} refs/heads/master\n`), "0000"].join(""),
		);
	});

	it("adds HEAD when storage left it out, and moves the capabilities onto it", () => {
		const advert = bytes(pkt(`${B} refs/heads/master\0multi_ack\n`), pkt(`${A} refs/tags/v1\n`), "0000");
		assert.equal(dec.decode(pointHeadV0(advert, "master")), 
			[pkt(`${B} HEAD\0multi_ack symref=HEAD:refs/heads/master\n`), pkt(`${B} refs/heads/master\n`), pkt(`${A} refs/tags/v1\n`), "0000"].join(""),
		);
	});

	it("copies other refs byte for byte, even when they aren't UTF-8", () => {
		const odd = new Uint8Array([...enc.encode("0039"), ...enc.encode(`${A} refs/tags/`), 0xff, 0x0a]);
		const advert = new Uint8Array([...bytes(pkt(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`), pkt(`${B} refs/heads/master\n`)), ...odd, ...enc.encode("0000")]);
		const out = pointHeadV0(advert, "master");
		assert.match(dec.decode(out), /symref=HEAD:refs\/heads\/master/);
		assert.deepEqual(out.subarray(out.length - odd.length - 4, out.length - 4), odd);
	});

	it("leaves the advertisement alone when the branch isn't there", () => {
		const advert = bytes(pkt(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`), pkt(`${A} refs/heads/main\n`), "0000");
		assert.equal(pointHeadV0(advert, "gone"), advert);
	});
});

describe("pointHeadV2", () => {
	const request = (...args: string[]) => bytes(pkt("command=ls-refs\n"), pkt("agent=git/2\n"), "0001", ...args.map((a) => pkt(`${a}\n`)), "0000");

	it("recognizes ls-refs", () => {
		assert.equal(isLsRefs(request("symrefs")), true);
		assert.equal(isLsRefs(bytes(pkt("command=fetch\n"), "0000")), false);
	});

	it("moves HEAD to the branch", () => {
		const answer = bytes(pkt(`${A} HEAD symref-target:refs/heads/main\n`), pkt(`${A} refs/heads/main\n`), pkt(`${B} refs/heads/master\n`), "0000");
		assert.equal(dec.decode(pointHeadV2(answer, "master", request("symrefs", "ref-prefix HEAD", "ref-prefix refs/heads/"))), 
			[pkt(`${B} HEAD symref-target:refs/heads/master\n`), pkt(`${A} refs/heads/main\n`), pkt(`${B} refs/heads/master\n`), "0000"].join(""),
		);
	});

	it("adds HEAD only when it was asked for", () => {
		const answer = bytes(pkt(`${B} refs/heads/master\n`), "0000");
		assert.equal(dec.decode(pointHeadV2(answer, "master", request("symrefs", "ref-prefix HEAD", "ref-prefix refs/heads/"))), 
			[pkt(`${B} HEAD symref-target:refs/heads/master\n`), pkt(`${B} refs/heads/master\n`), "0000"].join(""),
		);
		assert.deepEqual(pointHeadV2(answer, "master", request("ref-prefix refs/heads/")), answer);
	});

	it("takes the branch's head from the caller when the answer doesn't list it (ls-remote HEAD)", () => {
		const answer = bytes(pkt(`${A} HEAD symref-target:refs/heads/main\n`), "0000");
		assert.equal(dec.decode(pointHeadV2(answer, "master", request("symrefs", "ref-prefix HEAD"), B)), [pkt(`${B} HEAD symref-target:refs/heads/master\n`), "0000"].join(""));
		assert.deepEqual(pointHeadV2(answer, "master", request("symrefs", "ref-prefix HEAD")), answer);
	});
});
