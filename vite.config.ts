import { dirname } from "node:path"
import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const __dirname = dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
	// Runtime modes (dev/staging/prod) are served by src/server/inject.ts only.
	// The Vite build intentionally stays mode-agnostic: a fixed base and outDir
	// plus content-hashed asset names keep dist reproducible across modes.
	base: "/",
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src")
		}
	},
	build: {
		outDir: "dist",
		assetsDir: "assets",
		emptyOutDir: true
	}
})
