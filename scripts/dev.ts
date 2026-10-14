#!/usr/bin/env node
// Fully local stack: local Artifacts (git + control API) and the maggot Worker + UI under `vite dev --mode offline`.
// (`cf dev` hands TanStack Start projects to `vite dev` and rejects `--mode`, so Vite is run directly.)
// Ports are random unless MAGGOT_PORT / LOCAL_ARTIFACTS_PORT are set. HOST=0.0.0.0 to expose on a LAN/tailnet.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { simulateFromEnv, startLocalArtifacts } from "./local-artifacts.ts";

function freePort(host: string): Promise<number> {
	return new Promise((ok, err) => {
		const srv = createServer().once("error", err);
		srv.listen(0, host, () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => ok(port));
		});
	});
}

const host = process.env.HOST ?? "127.0.0.1";
/** Hostname agents use to reach the git server; defaults to the bind host (or localhost for 0.0.0.0). */
const publicHost = process.env.PUBLIC_HOST ?? (host === "0.0.0.0" ? "127.0.0.1" : host);
const artifactsPort = Number(process.env.LOCAL_ARTIFACTS_PORT) || (await freePort(host));
const workerPort = Number(process.env.MAGGOT_PORT) || (await freePort(host));

const artifacts = await startLocalArtifacts({
	root: process.env.LOCAL_ARTIFACTS_ROOT ?? ".maggot-local/artifacts",
	port: artifactsPort,
	host,
	publicUrl: `http://${publicHost}:${artifactsPort}`,
	quiet: !process.env.VERBOSE,
	simulate: simulateFromEnv(),
});
console.log(`local artifacts  ${artifacts.url}`);

const worker = spawn("npx", ["vite", "dev", "--mode", "offline"], {
	stdio: "inherit",
	env: {
		...process.env,
		// Read by cloudflare.config.ts (offline mode) and vite.config.ts.
		LOCAL_ARTIFACTS_URL: `http://127.0.0.1:${artifactsPort}`,
		MAGGOT_PORT: String(workerPort),
		HOST: host,
	},
});
console.log(`maggot api        http://${publicHost}:${workerPort}  (API key: dev)`);
console.log(`  export MAGGOT_URL=http://${publicHost}:${workerPort}`);

const stop = () => {
	worker.kill("SIGINT");
	void artifacts.close().then(() => process.exit(0));
};
process.on("SIGINT", stop).on("SIGTERM", stop);
worker.on("exit", (code) => void artifacts.close().then(() => process.exit(code ?? 0)));
