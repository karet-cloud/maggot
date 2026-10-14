import handler from "@tanstack/react-start/server-entry";
import { handleGit, matchGitPath } from "../src/git-http.ts";
import api from "../src/index.ts";
import { handleSsh, SSH_PATH } from "../src/ssh/index.ts";
import { PROXY_SCRIPT, PROXY_SCRIPT_PATH } from "../src/ssh/proxy-script.ts";
import type { SsrContext } from "./lib/ssr.server.ts";

export { Limiter } from "../src/policy.ts";
export { ProjectCoordinator, Registry } from "../src/project.ts";
export { CiJob } from "../src/ci/job.ts";

/** How long a page render waits for its data before sending what it has and streaming the rest. */
const SSR_WAIT_MS = 1500;

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
		return renderPage(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

/** Server-renders a page, its data fetched from the API in-process as the visitor (app/lib/ssr.server.ts). */
async function renderPage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const ssr: SsrContext = { request, api: (req: Request) => api.fetch(req, env, ctx), deadline: Date.now() + SSR_WAIT_MS };
	const res = await handler.fetch(request, { context: { ssr } });
	// Pages carry the visitor's own data (who's signed in, private repositories): never cache them in shared caches.
	if (!res.headers.get("content-type")?.startsWith("text/html")) return res;
	const page = new Response(res.body, res);
	page.headers.set("cache-control", "private, no-store");
	page.headers.append("vary", "cookie");
	return page;
}
