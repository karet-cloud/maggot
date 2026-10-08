import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	// scripts/dev.ts picks a free port and bind host; standalone `cf dev` uses Vite's defaults.
	server: {
		host: process.env.HOST ?? "127.0.0.1",
		port: process.env.MEGIT_PORT ? Number(process.env.MEGIT_PORT) : undefined,
		strictPort: Boolean(process.env.MEGIT_PORT),
	},
});
