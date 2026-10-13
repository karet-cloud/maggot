import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./app/server.ts" with { type: "cf-worker" };

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
				Limiter: exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				PROJECT: bindings.durableObject({ worker: "megit", exportName: "ProjectCoordinator" }),
				REGISTRY: bindings.durableObject({ worker: "megit", exportName: "Registry" }),
				// Rate-limit counters, one instance per IP address, user or account.
				LIMITER: bindings.durableObject({ worker: "megit", exportName: "Limiter" }),
				// Overrides for the rate limits and quotas in src/policy.ts, as JSON.
				MEGIT_POLICY: bindings.text(process.env.MEGIT_POLICY ?? ""),
				// Users, sessions, repository records and access tokens.
				DB: bindings.d1({ name: "megit" }),
				...(offline
					? {
							LOCAL_ARTIFACTS_URL: bindings.text(process.env.LOCAL_ARTIFACTS_URL ?? "http://127.0.0.1:8789"),
							MEGIT_API_KEY: bindings.text("dev"),
						}
					: {
							ARTIFACTS: bindings.artifacts({ namespace: "megit" }),
							MEGIT_API_KEY: bindings.secret(),
							// Password reset emails, once a domain is set up for Cloudflare Email Sending. Set
							// MEGIT_EMAIL_FROM (for example noreply@megit.dev) at deploy time to turn them on.
							...(process.env.MEGIT_EMAIL_FROM
								? { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [process.env.MEGIT_EMAIL_FROM] }), EMAIL_FROM: bindings.text(process.env.MEGIT_EMAIL_FROM) }
								: {}),
						}),
			},
		},
	};
});
