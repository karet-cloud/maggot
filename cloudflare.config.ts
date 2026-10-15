import { bindings, defineConfig, defineContainer, exports } from "cf/config";
import * as entrypoint from "./app/server.ts" with { type: "cf-worker" };

// Config is evaluated in Node, but type-checked with the Worker's types (no @types/node).
declare const process: { env: Record<string, string | undefined> };

// `cf dev --mode offline` (used by `npm run dev`) swaps the Artifacts binding for the local stand-in in
// scripts/local-artifacts.ts, so the whole stack runs without a Cloudflare account.
// Actions jobs run in Depot sandboxes (each repository brings its own Depot token). Setting
// MAGGOT_CI_CLOUDFLARE=on at deploy time also attaches a Cloudflare container to each CiJob object (the
// durable-object scheduling policy, so the job picks the image and instance type when it starts it) and
// offers it as a runner. The image is container/ci/Dockerfile when MAGGOT_CI_DOCKERFILE=1 (the deploy then
// needs Docker to build it), otherwise Cloudflare's managed Debian image.
const ciContainer =
	process.env.MAGGOT_CI_CLOUDFLARE === "on"
		? defineContainer({
				name: "maggot-ci",
				schedulingPolicy: "durable-object",
				...(process.env.MAGGOT_CI_DOCKERFILE === "1" ? { images: { ci: { dockerfile: "./container/ci/Dockerfile" } } } : {}),
			})
		: undefined;

export default defineConfig(({ mode }) => {
	const offline = mode === "offline";
	return {
		// This account owns karet.cloud and the production Worker resources.
		accountId: "38a254c9234a2bf01164bc3ee9157f85",
		...(ciContainer ? { containers: [ciContainer] } : {}),
		worker: {
			name: "maggot",
			...(offline ? {} : { domains: ["maggot.karet.cloud"] }),
			compatibilityDate: "2026-10-07",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			observability: { enabled: true },
			// Run near D1 (ENAM) and the coordinators rather than near each visitor: a page render makes a
			// dozen sequential queries, so one long hop for the finished page beats a long hop per query.
			...(offline ? {} : { placement: { mode: "smart" as const } }),
			exports: {
				ProjectCoordinator: exports.durableObject({ storage: "sqlite" }),
				Registry: exports.durableObject({ storage: "sqlite" }),
				Limiter: exports.durableObject({ storage: "sqlite" }),
				// One per Actions job: drives the job's sandbox and reports to its repository's coordinator.
				CiJob: ciContainer ? exports.durableObject({ storage: "sqlite", container: ciContainer }) : exports.durableObject({ storage: "sqlite" }),
			},
			env: {
				PROJECT: bindings.durableObject({ worker: "maggot", exportName: "ProjectCoordinator" }),
				REGISTRY: bindings.durableObject({ worker: "maggot", exportName: "Registry" }),
				// Rate-limit counters, one instance per IP address, user or account.
				LIMITER: bindings.durableObject({ worker: "maggot", exportName: "Limiter" }),
				// "on" when CiJob has a Cloudflare container attached (see MAGGOT_CI_CLOUDFLARE above).
				MAGGOT_CI_CLOUDFLARE: bindings.text(ciContainer ? "on" : "off"),
				// Overrides for the rate limits and quotas in src/policy.ts, as JSON.
				MAGGOT_POLICY: bindings.text(process.env.MAGGOT_POLICY ?? ""),
				// Users, sessions, repository records and access tokens.
				DB: bindings.d1({ name: "maggot" }),
				// Actions caches, artifacts, and the copies of third-party actions jobs download.
				CI_BUCKET: bindings.r2({ name: "maggot-ci" }),
				...(offline
					? {
							LOCAL_ARTIFACTS_URL: bindings.text(process.env.LOCAL_ARTIFACTS_URL ?? "http://127.0.0.1:8789"),
							MAGGOT_API_KEY: bindings.text("dev"),
						}
					: {
							ARTIFACTS: bindings.artifacts({ namespace: "maggot" }),
							MAGGOT_API_KEY: bindings.secret(),
							// Turnstile on sign-up and the waitlist (src/turnstile.ts): the widget's site key at deploy
							// time, and its secret key as a secret. Without the site key the check is off.
							...(process.env.MAGGOT_TURNSTILE_SITE_KEY
								? { TURNSTILE_SITE_KEY: bindings.text(process.env.MAGGOT_TURNSTILE_SITE_KEY), TURNSTILE_SECRET_KEY: bindings.secret() }
								: {}),
							// Password reset emails, once a domain is set up for Cloudflare Email Sending. Set
							// MAGGOT_EMAIL_FROM (for example noreply@maggot.dev) at deploy time to turn them on.
							...(process.env.MAGGOT_EMAIL_FROM
								? { EMAIL: bindings.sendEmail({ allowedSenderAddresses: [process.env.MAGGOT_EMAIL_FROM] }), EMAIL_FROM: bindings.text(process.env.MAGGOT_EMAIL_FROM) }
								: {}),
						}),
			},
		},
	};
});
