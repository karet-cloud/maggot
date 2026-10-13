import handler from "@tanstack/react-start/server-entry";
import { handleGit, matchGitPath } from "../src/git-http.ts";
import api from "../src/index.ts";

export { Limiter } from "../src/policy.ts";
export { ProjectCoordinator, Registry } from "../src/project.ts";

// One Worker serves everything: git smart HTTP at /<owner>/<repo>.git/..., the Hono API at /api/*, and
// the TanStack Start UI for the rest.
export default {
	fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api" || pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
		const git = matchGitPath(pathname);
		if (git) return handleGit(request, env, ctx, git);
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Env>;
