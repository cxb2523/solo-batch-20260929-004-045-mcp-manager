import { dirname } from "node:path"
import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Keep these identical for every runtime mode (local/staging/prod). The
// runtime injector in src/server/modes.ts exports the same values, so a
// mode switch never moves outDir/base - artifact hashes stay reproducible.
const OUT_DIR = "dist"
const RESOURCE_BASE = "/"

// https://vite.dev/config/
export default defineConfig({
	base: RESOURCE_BASE,
	build: {
		outDir: OUT_DIR,
		emptyOutDir: true
	},
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src")
		}
	}
})
