import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		// MAGGOT_STATE_DIR keeps a server's local D1 and Durable Object state apart from other servers in the
		// same checkout (the end-to-end tests use a fresh one), so two of them never contend for one SQLite file.
		cloudflare({ viteEnvironment: { name: "ssr" }, ...(process.env.MAGGOT_STATE_DIR ? { persistState: { path: process.env.MAGGOT_STATE_DIR } } : {}) }),
		tanstackStart({ srcDirectory: "app" }),
		react(),
		tailwindcss(),
	],
	// Likewise Vite's dependency cache, which a second dev server would otherwise re-optimize under the first.
	...(process.env.MAGGOT_STATE_DIR ? { cacheDir: `${process.env.MAGGOT_STATE_DIR}/vite` } : {}),
	// scripts/dev.ts picks a free port and bind host; standalone `cf dev` uses Vite's defaults.
	server: {
		host: process.env.HOST ?? "127.0.0.1",
		port: process.env.MAGGOT_PORT ? Number(process.env.MAGGOT_PORT) : undefined,
		strictPort: Boolean(process.env.MAGGOT_PORT),
		allowedHosts: true,
	},
});
