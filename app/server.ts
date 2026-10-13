import handler from "@tanstack/react-start/server-entry";
import { handleGit, matchGitPath } from "../src/git-http.ts";
import api from "../src/index.ts";
import { handleSsh, SSH_PATH } from "../src/ssh/index.ts";
import { PROXY_SCRIPT, PROXY_SCRIPT_PATH } from "../src/ssh/proxy-script.ts";

export { Limiter } from "../src/policy.ts";
export { ProjectCoordinator, Registry } from "../src/project.ts";
export { CiJob } from "../src/ci/job.ts";

// One Worker serves everything: git smart HTTP at /<owner>/<repo>.git/..., SSH over a WebSocket at
// /_ssh, the Hono API at /api/*, and the TanStack Start UI for the rest.
export default {
	fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api" || pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
		if (pathname === SSH_PATH) return handleSsh(request, env, ctx);
		if (pathname === PROXY_SCRIPT_PATH) return new Response(PROXY_SCRIPT, { headers: { "content-type": "text/javascript;charset=utf-8", "cache-control": "public, max-age=300" } });
		const git = matchGitPath(pathname);
		if (git) return handleGit(request, env, ctx, git);
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Env>;
