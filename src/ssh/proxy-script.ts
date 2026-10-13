// The ProxyCommand people run so ssh can reach megit: it carries the SSH connection over a WebSocket.
// Served at /ssh-proxy.mjs. Plain JavaScript with no dependencies, for Node.js 22 or newer.
export const PROXY_SCRIPT_PATH = "/ssh-proxy.mjs";

export const PROXY_SCRIPT = `#!/usr/bin/env node
// megit SSH proxy: carries an SSH connection over a WebSocket, for ssh's ProxyCommand. In ~/.ssh/config:
//
//   Host <megit host>
//     User git
//     ProxyCommand node ~/.ssh/megit-proxy.mjs %h
//
// Give a ws:// or wss:// URL instead of the host name to reach a server on another port or path.
const target = process.argv[2];
if (!target) {
	console.error("usage: megit-proxy.mjs <host or wss:// URL>");
	process.exit(2);
}
if (typeof WebSocket !== "function") {
	console.error("megit-proxy needs Node.js 22 or newer");
	process.exit(2);
}
const url = /^wss?:\\/\\//.test(target) ? target : \`wss://\${target}/_ssh\`;
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
const pending = [];
let open = false;
let done = false;
let waiting = false;

// ssh went away first: nothing left to say.
process.stdout.on("error", () => process.exit(0));

ws.addEventListener("open", () => {
	open = true;
	for (const chunk of pending) ws.send(chunk);
	pending.length = 0;
});
ws.addEventListener("message", (event) => {
	process.stdout.write(typeof event.data === "string" ? Buffer.from(event.data) : Buffer.from(event.data));
});
ws.addEventListener("close", (event) => {
	if (done) return;
	done = true;
	if (!open) console.error(\`megit-proxy: couldn't connect to \${url}\${event.reason ? \`: \${event.reason}\` : ""}\`);
	process.stdout.end(() => process.exit(open ? 0 : 1));
});

process.stdin.on("data", (chunk) => {
	if (!open) {
		pending.push(chunk);
		return;
	}
	ws.send(chunk);
	// The WebSocket has no backpressure of its own; stop reading while a lot is waiting to go out.
	if (ws.bufferedAmount > 4 * 1024 * 1024 && !waiting) {
		waiting = true;
		process.stdin.pause();
		const wait = setInterval(() => {
			if (ws.bufferedAmount < 1024 * 1024 || ws.readyState !== WebSocket.OPEN) {
				clearInterval(wait);
				waiting = false;
				process.stdin.resume();
			}
		}, 10);
	}
});
// ssh closes our input when it's finished with the connection.
process.stdin.on("end", () => ws.close());
`;
