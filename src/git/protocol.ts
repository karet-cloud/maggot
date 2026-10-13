// The two smart-HTTP exchanges the Artifacts binding has no method for: listing refs and deleting one.
import type { RemoteAccess } from "./workspace.ts";

const ZERO = "0".repeat(40);

function headers(remote: RemoteAccess, extra: Record<string, string> = {}) {
	const secret = remote.token.split("?expires=")[0];
	return { authorization: `Basic ${btoa(`x:${secret}`)}`, "user-agent": "git/megit", ...extra };
}

/** Branch name to head oid, as `git ls-remote --heads` reports them. */
export async function listBranches(remote: RemoteAccess): Promise<Map<string, string>> {
	const res = await fetch(`${remote.url}/info/refs?service=git-upload-pack`, { headers: headers(remote) });
	if (!res.ok) throw new Error(`Listing refs failed: HTTP ${res.status}`);
	const branches = new Map<string, string>();
	for (const line of pktLines(new Uint8Array(await res.arrayBuffer()))) {
		const [oid, ref] = line.split("\0")[0].trimEnd().split(" ");
		if (ref?.startsWith("refs/heads/")) branches.set(ref.slice("refs/heads/".length), oid);
	}
	return branches;
}

/** Deletes `refs/heads/<branch>` if it still points at `oid`. */
export async function deleteBranch(remote: RemoteAccess, branch: string, oid: string): Promise<void> {
	const command = `${oid} ${ZERO} refs/heads/${branch}\0report-status delete-refs agent=megit\n`;
	const res = await fetch(`${remote.url}/git-receive-pack`, {
		method: "POST",
		headers: headers(remote, {
			"content-type": "application/x-git-receive-pack-request",
			accept: "application/x-git-receive-pack-result",
		}),
		body: `${pkt(command)}0000`,
	});
	if (!res.ok) throw new Error(`Deleting ${branch} failed: HTTP ${res.status}`);
	// report-status must say the (empty) pack unpacked and this exact ref updated; anything else is a failure.
	const report = pktLines(new Uint8Array(await res.arrayBuffer())).map((l) => l.trimEnd());
	if (report[0] !== "unpack ok" || !report.includes(`ok refs/heads/${branch}`)) {
		const reason =
			report.find((l) => l.startsWith("ng ")) ?? report.find((l) => l.startsWith("unpack ") && l !== "unpack ok") ?? "no report-status in the response";
		throw new Error(`Deleting ${branch} failed: ${reason}`);
	}
}

function pkt(line: string): string {
	return (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line;
}

/** Data lines of a pkt-line stream, skipping flush packets and the `# service=` banner. */
function pktLines(bytes: Uint8Array): string[] {
	const decoder = new TextDecoder();
	const lines: string[] = [];
	for (let i = 0; i + 4 <= bytes.length; ) {
		const header = decoder.decode(bytes.subarray(i, i + 4));
		if (!/^[0-9a-f]{4}$/.test(header)) throw new Error("Malformed pkt-line response");
		const size = Number.parseInt(header, 16);
		if (size >= 4 && i + size > bytes.length) throw new Error("Truncated pkt-line response");
		if (size < 4) {
			i += 4;
			continue;
		}
		const line = decoder.decode(bytes.subarray(i + 4, i + size));
		if (!line.startsWith("# service=")) lines.push(line);
		i += size;
	}
	return lines;
}
