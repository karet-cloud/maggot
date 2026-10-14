// SSH over WebSocket. Workers can't listen on port 22, so SSH clients reach maggot through a
// ProxyCommand that carries the SSH byte stream over a WebSocket to this endpoint (see the SSH keys
// page). Everything after that is ordinary SSH, encrypted end to end between git's ssh and the Worker.
import { db, ensureSchema, touchSshKey, userForSshKey } from "../db.ts";
import { clientIp, limit, policy, RateLimited, rules } from "../policy.ts";
import { runGitCommand, type GitUser } from "./git.ts";
import { fingerprint, hostKey } from "./keys.ts";
import { SshServer } from "./server.ts";
import { base64 } from "./wire.ts";

export { SSH_PATH } from "./keys.ts";

export async function handleSsh(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return new Response("This is maggot's SSH endpoint. Connect with ssh through the ProxyCommand on the SSH keys page.\n", {
			status: 426,
			headers: { "content-type": "text/plain" },
		});
	}
	// Connections are limited like git requests over HTTP, per address until signed in, then per user.
	try {
		await limit(env, `ip:${clientIp(request)}`, rules.git(policy(env)), "Too many SSH connections");
	} catch (err) {
		if (err instanceof RateLimited) return new Response(`${err.detail}\n`, { status: 429, headers: { "retry-after": String(err.retryAfter) } });
		throw err;
	}
	const key = await hostKey(env);
	const origin = new URL(request.url).origin;
	const [client, socket] = Object.values(new WebSocketPair());
	socket.accept();
	const server = new SshServer<GitUser>({
		hostKey: key,
		send: (bytes) => {
			try {
				socket.send(bytes);
			} catch {
				// Closed; the close handler tidies up.
			}
		},
		close: (reason) => {
			try {
				socket.close(1000, reason.slice(0, 120));
			} catch {
				// Already closed.
			}
		},
		lookupKey: async (blob) => {
			await ensureSchema(db(env));
			const found = await userForSshKey(db(env), await fingerprint(blob));
			// The fingerprint found it; the stored key must also be this exact key.
			if (!found || found.publicKey !== base64(blob)) return null;
			ctx.waitUntil(touchSshKey(db(env), found.keyId, found.lastUsedAt).catch(() => {}));
			return { username: found.username, principal: { kind: "user", id: found.id, username: found.username, via: "ssh", verified: found.verified } };
		},
		exec: (session, command) => runGitCommand(env, ctx, origin, session, command),
	});
	// Messages are usually ArrayBuffers, but can arrive as Blobs (local development), which take a read;
	// either way they're handed over in the order they came.
	let order = Promise.resolve();
	socket.addEventListener("message", (event) => {
		const data = event.data as string | ArrayBuffer | Blob;
		order = order
			.then(async () => {
				const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
				server.receive(bytes);
			})
			.catch(() => server.closedByPeer());
	});
	socket.addEventListener("close", () => server.closedByPeer());
	socket.addEventListener("error", () => server.closedByPeer());
	return new Response(null, { status: 101, webSocket: client });
}
