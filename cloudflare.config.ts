import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Config is evaluated in Node, but type-checked with the Worker's types (no @types/node).
declare const process: { env: Record<string, string | undefined> };

// `cf dev --mode offline` (used by `npm run dev`) swaps the Artifacts binding for the local stand-in in
// scripts/local-artifacts.ts, so the whole stack runs without a Cloudflare account.
export default defineConfig(({ mode }) => {
	const offline = mode === "offline";
	return {
		worker: {
			name: "megit",
			compatibilityDate: "2026-10-07",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			observability: { enabled: true },
			exports: {
				ProjectCoordinator: exports.durableObject({ storage: "sqlite" }),
				Registry: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				PROJECT: bindings.durableObject({ worker: "megit", exportName: "ProjectCoordinator" }),
				REGISTRY: bindings.durableObject({ worker: "megit", exportName: "Registry" }),
				...(offline
					? {
							LOCAL_ARTIFACTS_URL: bindings.text(process.env.LOCAL_ARTIFACTS_URL ?? "http://127.0.0.1:8789"),
							MEGIT_API_KEY: bindings.text("dev"),
						}
					: {
							ARTIFACTS: bindings.artifacts({ namespace: "megit" }),
							MEGIT_API_KEY: bindings.secret(),
						}),
			},
		},
	};
});
