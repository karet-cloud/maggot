import handler from "@tanstack/react-start/server-entry";
import api from "../src/index.ts";

export { ProjectCoordinator, Registry } from "../src/project.ts";

// One Worker serves both: `/api/*` goes to the Hono API, everything else to the TanStack Start UI.
export default {
	fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api" || pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Env>;
