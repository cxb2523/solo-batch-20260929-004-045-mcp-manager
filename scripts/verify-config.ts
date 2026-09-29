import { type ChildProcessByStdio, spawn } from "node:child_process"
import { type Server, createServer } from "node:http"
import type { Readable } from "node:stream"

type InjectProcess = ChildProcessByStdio<null, Readable, Readable>
import { pathToFileURL } from "node:url"
import {
	BUILD_INVARIANTS,
	type ResolvedManifest,
	type StatusSnapshot
} from "../src/server/modes.ts"

const PORT = Number.parseInt(process.env.MCP_INJECT_PORT ?? "5179", 10)
const BASE_URL = `http://127.0.0.1:${PORT}`

let failures = 0

const assert = (condition: boolean, message: string): void => {
	if (condition) {
		console.log(`  \u2713 ${message}`)
	} else {
		failures += 1
		console.error(`  \u2717 ${message}`)
	}
}

const fetchJson = async <T>(
	path: string,
	init?: RequestInit,
	timeoutMs = 8000
): Promise<T> => {
	const controller = AbortSignal.timeout(timeoutMs)
	const response = await fetch(`${BASE_URL}${path}`, {
		...init,
		signal: controller
	})
	return (await response.json()) as T
}

const waitForHealth = async (attempts = 50): Promise<void> => {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await fetch(`${BASE_URL}/health`, {
				signal: AbortSignal.timeout(500)
			})
			if (response.ok) return
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}
	throw new Error("inject service did not become healthy")
}

const startSlowUpstream = (): Promise<{ server: Server; url: string }> =>
	new Promise((resolve) => {
		const server = createServer((_req, res) => {
			setTimeout(() => {
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ servers: { "slow-server": {} } }))
			}, 1500)
		})
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				throw new Error("slow upstream failed to bind")
			}
			resolve({
				server,
				url: `http://127.0.0.1:${address.port}/manifest.json`
			})
		})
	})

const deadServer = (): Promise<string> =>
	new Promise((resolve, reject) => {
		const server = createServer()
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				reject(new Error("dead server bind failed"))
				return
			}
			const { port } = address
			server.close(() => {
				resolve(`http://127.0.0.1:${port}/manifest.json`)
			})
		})
	})

const expectBuildInvariants = (manifest: ResolvedManifest): void => {
	assert(
		manifest.build.outDir === BUILD_INVARIANTS.outDir,
		`/${manifest.mode} keeps outDir ${BUILD_INVARIANTS.outDir}`
	)
	assert(
		manifest.build.base === BUILD_INVARIANTS.base,
		`/${manifest.mode} keeps base ${BUILD_INVARIANTS.base}`
	)
	assert(
		JSON.stringify(manifest.build.tsconfigReferences) ===
			JSON.stringify(BUILD_INVARIANTS.tsconfigReferences),
		`/${manifest.mode} keeps the tsconfig reference chain`
	)
	assert(
		manifest.resourceBase === BUILD_INVARIANTS.base,
		`/${manifest.mode} reports resource base ${BUILD_INVARIANTS.base}`
	)
}

const main = async (): Promise<void> => {
	const slowUpstream = await startSlowUpstream()
	const deadUrl = await deadServer()

	const child: InjectProcess = spawn(
		process.execPath,
		["--experimental-strip-types", "src/server/inject.ts"],
		{
			env: {
				...process.env,
				MCP_INJECT_PORT: String(PORT),
				MCP_STAGING_MANIFEST_URL: slowUpstream.url,
				MCP_PROD_MANIFEST_URL: deadUrl
			},
			stdio: ["ignore", "pipe", "pipe"]
		}
	)
	child.stdout.on("data", (chunk) =>
		process.stdout.write(`[inject] ${chunk}`)
	)
	child.stderr.on("data", (chunk) =>
		process.stderr.write(`[inject] ${chunk}`)
	)

	try {
		await waitForHealth()
		console.log("service healthy")

		console.log("epoch guard: slow staging result must not overwrite prod")
		const slowStaging = fetchJson<ResolvedManifest>("/config/staging")
		await new Promise((resolve) => setTimeout(resolve, 250))
		const prodFallback = await fetchJson<ResolvedManifest>("/config/prod")
		assert(
			prodFallback.fallback === true &&
				prodFallback.source === "fallback",
			"unreachable prod fell back to the default list"
		)
		expectBuildInvariants(prodFallback)

		const stagingManifest = await slowStaging
		assert(
			stagingManifest.source === "remote" &&
				stagingManifest.serverCount === 1,
			"slow staging response still resolved from the real upstream"
		)
		expectBuildInvariants(stagingManifest)

		const statusAfterRace =
			await fetchJson<StatusSnapshot>("/status?json=1")
		assert(
			statusAfterRace.currentMode === "prod",
			"current mode is prod after the switch"
		)
		assert(
			statusAfterRace.epoch === 2,
			`epoch bumped to 2 across local->staging->prod (got ${statusAfterRace.epoch})`
		)
		assert(
			statusAfterRace.lastSource === "fallback" &&
				statusAfterRace.lastFallback === true &&
				statusAfterRace.resolvedServerCount ===
					prodFallback.serverCount,
			"stale staging response did not overwrite the newer prod fallback state"
		)
		assert(
			statusAfterRace.fallbackCount === 1,
			`fallbackCount is 1 after a real fallback (got ${statusAfterRace.fallbackCount})`
		)

		console.log("three concurrent hits on the same mode (local)")
		const hitsBefore = (await fetchJson<StatusSnapshot>("/status?json=1"))
			.cacheHits
		const [first, second, third] = await Promise.all([
			fetchJson<ResolvedManifest>("/config/local"),
			fetchJson<ResolvedManifest>("/config/local"),
			fetchJson<ResolvedManifest>("/config/local")
		])
		assert(
			first.source === "inline" &&
				second.source === "inline" &&
				third.source === "inline",
			"all three local requests resolved from the inlined defaults"
		)
		for (const manifest of [first, second, third]) {
			expectBuildInvariants(manifest)
		}
		const statusAfterLocal =
			await fetchJson<StatusSnapshot>("/status?json=1")
		assert(
			statusAfterLocal.cacheHits - hitsBefore === 2,
			`three concurrent same-mode requests produce 2 in-flight cache hits (got ${
				statusAfterLocal.cacheHits - hitsBefore
			})`
		)

		console.log(
			"switching back to prod: every unreached upstream is a real fallback"
		)
		const cachedProd = await fetchJson<ResolvedManifest>("/config/prod")
		assert(
			cachedProd.fallback === true && cachedProd.source === "fallback",
			"prod falls back to the default list again"
		)
		const statusAfter = await fetchJson<StatusSnapshot>("/status?json=1")
		assert(
			statusAfter.fallbackCount === 2,
			`a second real fallback increments the counter (got ${statusAfter.fallbackCount})`
		)

		console.log("retrying prod once more")
		await new Promise((resolve) => setTimeout(resolve, 200))
		const retriedProd = await fetchJson<ResolvedManifest>("/config/prod")
		const finalStatus = await fetchJson<StatusSnapshot>("/status?json=1")
		assert(
			retriedProd.fallback === true,
			"prod falls back again against the still-dead upstream"
		)
		assert(
			finalStatus.fallbackCount === 3,
			`each real fallback increments the counter (got ${finalStatus.fallbackCount}, expected 3)`
		)

		const health = await fetchJson<{
			status: string
			defaultMode: string
			modes: string[]
		}>("/health")
		assert(
			health.status === "ok" &&
				health.defaultMode === "local" &&
				JSON.stringify(health.modes) ===
					JSON.stringify(["local", "staging", "prod"]),
			"/health reports the service and its three modes"
		)

		const statusHtml = await fetch(`${BASE_URL}/status`).then((response) =>
			response.text()
		)
		assert(
			statusHtml.includes("Current Mode") &&
				statusHtml.includes("Fallback Count") &&
				statusHtml.includes("Cache Hits") &&
				statusHtml.includes("Resource Base"),
			"/status embeds the recording-ready status page"
		)

		const unknown = await fetch(`${BASE_URL}/config/nope`)
		assert(unknown.status === 404, "unknown mode returns 404")

		console.log(
			`cacheHits ${finalStatus.cacheHits} (started at ${hitsBefore}), ` +
				`fallbacks ${finalStatus.fallbackCount}, epoch ${finalStatus.epoch}`
		)
	} finally {
		child.kill()
		slowUpstream.server.close()
	}

	if (failures > 0) {
		console.error(`\nverify:config FAILED with ${failures} assertion(s)`)
		process.exit(1)
	}
	console.log("\nverify:config passed")
}

main().catch((error: unknown) => {
	console.error("verify:config crashed:", error)
	process.exit(1)
})
