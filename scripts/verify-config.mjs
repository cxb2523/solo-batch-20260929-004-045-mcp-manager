import { spawn, spawnSync } from "node:child_process"
import { createServer as createHttpServer } from "node:http"
import net from "node:net"
import process from "node:process"

const PREFERRED_PORT = 5179
const TTL_MS = "1500"
const DEFAULT_SERVER_COUNT = 22

let failures = 0

function check(name, condition, detail = "") {
	if (condition) {
		console.log(`  \u2713 ${name}`)
	} else {
		failures += 1
		console.error(
			`  \u2717 ${name}${detail === "" ? "" : ` \u2014 ${detail}`}`
		)
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

function mockServers(count, prefix) {
	const servers = {}
	for (let index = 0; index < count; index += 1) {
		servers[`${prefix}-server-${index + 1}`] = {
			icon: `https://example.invalid/${prefix}-${index + 1}.svg`,
			description: `Mock ${prefix} server ${index + 1}`,
			docsUrl: `https://example.invalid/${prefix}/${index + 1}`,
			command: "npx",
			args: ["-y", `@mock/${prefix}-${index + 1}`]
		}
	}
	return servers
}

const STAGING_MANIFEST = {
	base: "/mcp/staging/",
	servers: mockServers(3, "staging")
}
const PROD_MANIFEST = {
	base: "/mcp/prod/",
	servers: mockServers(5, "prod")
}

function startUpstream() {
	return new Promise((resolve) => {
		const server = createHttpServer((request, response) => {
			const delay = request.url === "/prod.json" ? 350 : 120
			const body =
				request.url === "/prod.json"
					? PROD_MANIFEST
					: request.url === "/staging.json"
						? STAGING_MANIFEST
						: null
			setTimeout(() => {
				if (body === null) {
					response.writeHead(404)
					response.end("not found")
					return
				}
				response.writeHead(200, {
					"content-type": "application/json"
				})
				response.end(JSON.stringify(body))
			}, delay)
		})
		server.listen(0, "127.0.0.1", () => {
			resolve({
				server,
				port: server.address().port
			})
		})
	})
}

function isPortFree(port) {
	return new Promise((resolve) => {
		const probe = net
			.createServer()
			.once("error", () => resolve(false))
			.once("listening", () => probe.close(() => resolve(true)))
			.listen(port, "127.0.0.1")
	})
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer()
		probe.once("error", reject)
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address()
			probe.close(() => resolve(port))
		})
	})
}

function killTree(pid) {
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore"
			})
		} else {
			process.kill(pid, "SIGTERM")
		}
	} catch {
		// process may already have exited
	}
}

function startInject(port, upstreamPort) {
	let bunCommand = "bun"
	if (process.platform === "win32") {
		const appData = process.env.APPDATA
		const directBun =
			appData === undefined
				? null
				: `${appData}\\npm\\node_modules\\bun\\bin\\bun.exe`
		if (
			directBun !== null &&
			spawnSync(directBun, ["--version"]).status === 0
		) {
			bunCommand = directBun
		}
	}
	const args = ["run", "src/server/inject.ts"]
	const child = spawn(bunCommand, args, {
		cwd: process.cwd(),
		env: {
			...process.env,
			MCP_CONFIG_PORT: String(port),
			MCP_CONFIG_TTL_MS: TTL_MS,
			MCP_CONFIG_UPSTREAM_STAGING: `http://127.0.0.1:${upstreamPort}/staging.json`,
			MCP_CONFIG_UPSTREAM_PROD: `http://127.0.0.1:${upstreamPort}/prod.json`
		},
		stdio: ["ignore", "pipe", "inherit"]
	})
	child.stdout.on("data", (chunk) =>
		process.stdout.write(`[inject] ${chunk}`)
	)
	return child
}

async function waitForHealth(baseUrl) {
	const deadline = Date.now() + 10000
	let lastError = null
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/health`)
			if (response.ok) return
		} catch (error) {
			lastError = error
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(
		`inject service did not become healthy: ${String(lastError)}`
	)
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function getJson(url) {
	return fetch(url).then((response) => response.json())
}

async function main() {
	const upstream = await startUpstream()
	const port = (await isPortFree(PREFERRED_PORT))
		? PREFERRED_PORT
		: await getFreePort()
	const inject = startInject(port, upstream.port)
	const baseUrl = `http://127.0.0.1:${port}`

	const cleanup = () => {
		killTree(inject.pid)
		upstream.server.close()
	}
	process.on("exit", cleanup)

	try {
		await waitForHealth(baseUrl)
		console.log(`\n[verify] inject service ready at ${baseUrl}`)

		console.log("[verify] A. dev 不可达：连打三次同一模式")
		const devResponses = []
		for (let index = 0; index < 3; index += 1) {
			devResponses.push(await getJson(`${baseUrl}/config/dev`))
		}
		check(
			"三次 dev 请求全部退回默认清单",
			devResponses.every(
				(payload) => payload.source === "default" && payload.fallback
			)
		)
		check(
			"三次 dev 响应负载完全一致",
			devResponses
				.map((payload) => JSON.stringify(payload.servers))
				.every(
					(body) => body === JSON.stringify(devResponses[0].servers)
				)
		)
		let health = await getJson(`${baseUrl}/health`)
		check(
			"三连只触发一次真实解析（resolvedCount === 1）",
			health.resolvedCount === 1,
			`got ${health.resolvedCount}`
		)
		check(
			"三连中发生两次复用（2 次合并或缓存命中）",
			health.cacheHits + health.inFlightShares === 2,
			`hits=${health.cacheHits} shares=${health.inFlightShares}`
		)
		check(
			"回退计数只加了一次（fallbackCount === 1）",
			health.fallbackCount === 1,
			`got ${health.fallbackCount}`
		)

		console.log("[verify] B. staging：三个并发请求只触发一次真实解析")
		const beforeStaging = health
		const stagingResponses = await Promise.all(
			[0, 1, 2].map(() => getJson(`${baseUrl}/config/staging`))
		)
		check(
			"三次 staging 并发请求都拿到远端清单",
			stagingResponses.every(
				(payload) => payload.source === "remote" && !payload.fallback
			)
		)
		check(
			"三次 staging 并发响应完全一致",
			stagingResponses
				.map((payload) => JSON.stringify(payload))
				.every((body) => body === JSON.stringify(stagingResponses[0]))
		)
		check(
			"staging 解析出 3 台服务器且 base 为 /mcp/staging/",
			stagingResponses[0].serverCount === 3 &&
				stagingResponses[0].base === "/mcp/staging/"
		)
		health = await getJson(`${baseUrl}/health`)
		check(
			"staging 并发只新增一次真实解析（delta === 1）",
			health.resolvedCount - beforeStaging.resolvedCount === 1,
			`got ${health.resolvedCount}`
		)
		check(
			"两个并发请求挂同一 Promise（shares delta === 2）",
			health.inFlightShares - beforeStaging.inFlightShares === 2,
			`got ${health.inFlightShares}`
		)
		check(
			"并发 burst 不产生缓存命中（delta === 0）",
			health.cacheHits - beforeStaging.cacheHits === 0,
			`got ${health.cacheHits}`
		)
		check(
			"远端成功不产生回退（fallback delta === 0）",
			health.fallbackCount - beforeStaging.fallbackCount === 0,
			`got ${health.fallbackCount}`
		)

		console.log("[verify] C. staging 再来两次顺序请求：纯缓存命中")
		const beforeC = health
		for (let index = 0; index < 2; index += 1) {
			const payload = await getJson(`${baseUrl}/config/staging`)
			assert(
				payload.source === "remote",
				"staging cache hit should stay remote"
			)
		}
		health = await getJson(`${baseUrl}/health`)
		check(
			"两次顺序请求各命中一次缓存（delta === 2）",
			health.cacheHits - beforeC.cacheHits === 2,
			`got ${health.cacheHits}`
		)
		check(
			"命中缓存不再触发解析（delta === 0）",
			health.resolvedCount - beforeC.resolvedCount === 0,
			`got ${health.resolvedCount}`
		)

		console.log(
			"[verify] D. 切模式 epoch：慢 prod 响应不得覆盖已切回的 staging"
		)
		const prodPromise = getJson(`${baseUrl}/config/prod`)
		await sleep(80)
		const beforeD = health
		const stagingSwitch = await getJson(`${baseUrl}/config/staging`)
		check(
			"切回 staging 拿到缓存命中",
			stagingSwitch.serverCount === 3 &&
				stagingSwitch.base === "/mcp/staging/"
		)
		const prodPayload = await prodPromise
		check(
			"慢 prod 请求自身仍返回远端 5 台",
			prodPayload.source === "remote" &&
				prodPayload.serverCount === 5 &&
				prodPayload.base === "/mcp/prod/"
		)
		health = await getJson(`${baseUrl}/health`)
		check(
			"当前模式仍是 staging（未被慢 prod 覆盖）",
			health.currentMode === "staging",
			`got ${health.currentMode}`
		)
		check(
			"headline 服务器数仍是 3",
			health.serverCount === 3,
			`got ${health.serverCount}`
		)
		check(
			"过期 prod 结果被 epoch 丢弃（staleDropped >= 1）",
			health.staleDropped >= 1,
			`got ${health.staleDropped}`
		)
		check(
			"切回 staging 是缓存命中（hits delta === 1）",
			health.cacheHits - beforeD.cacheHits === 1,
			`hits ${beforeD.cacheHits} -> ${health.cacheHits}`
		)
		check(
			"prod 慢解析真实发生一次（resolved delta === 1）",
			health.resolvedCount - beforeD.resolvedCount === 1,
			`resolved ${beforeD.resolvedCount} -> ${health.resolvedCount}`
		)

		console.log(
			"[verify] E. 再切到 prod：命中缓存，headline 切换，不计解析"
		)
		const beforeE = health
		const prodCached = await getJson(`${baseUrl}/config/prod`)
		check(
			"prod 走缓存返回 5 台",
			prodCached.serverCount === 5 && prodCached.source === "remote"
		)
		health = await getJson(`${baseUrl}/health`)
		check(
			"当前模式为 prod，headline 服务器数 5",
			health.currentMode === "prod" && health.serverCount === 5,
			`mode=${health.currentMode} count=${health.serverCount}`
		)
		check(
			"切回 prod 命中缓存且不再解析（hits +1, resolved +0）",
			health.cacheHits - beforeE.cacheHits === 1 &&
				health.resolvedCount - beforeE.resolvedCount === 0,
			`hits=${health.cacheHits} resolved=${health.resolvedCount}`
		)

		console.log("[verify] F. /status 内嵌状态页包含录屏指标")
		const statusHtml = await fetch(`${baseUrl}/status`).then((response) =>
			response.text()
		)
		check("状态页含当前模式 生产模式", statusHtml.includes("生产模式"))
		check(
			"状态页含 data-testid=current-mode",
			statusHtml.includes('data-testid="current-mode"')
		)
		check(
			`状态页命中计数与 /health 一致（${health.cacheHits}）`,
			statusHtml.includes(`data-testid="cache-hits">${health.cacheHits}<`)
		)
		check(
			`状态页回退计数与 /health 一致（${health.fallbackCount}）`,
			statusHtml.includes(
				`data-testid="fallback-count">${health.fallbackCount}<`
			)
		)
		check(
			"状态页含服务器数 5",
			statusHtml.includes('data-testid="server-count">5<')
		)
		check("状态页含资源基址 /mcp/prod/", statusHtml.includes("/mcp/prod/"))

		console.log("[verify] G. 非法模式 400、未知路径 404")
		const badMode = await fetch(`${baseUrl}/config/bogus`)
		check(
			"未知模式返回 400",
			badMode.status === 400,
			`got ${badMode.status}`
		)
		const notFound = await fetch(`${baseUrl}/nope`)
		check(
			"未知路径返回 404",
			notFound.status === 404,
			`got ${notFound.status}`
		)

		console.log(`[verify] H. TTL ${TTL_MS}ms 过期后重新真实解析`)
		const beforeH = health
		await sleep(1700)
		const devRefreshed = await getJson(`${baseUrl}/config/dev`)
		check(
			"TTL 过期后 dev 仍回退默认清单（22 台）",
			devRefreshed.source === "default" &&
				devRefreshed.serverCount === DEFAULT_SERVER_COUNT
		)
		health = await getJson(`${baseUrl}/health`)
		check(
			"TTL 过期触发一次真实解析（resolved delta === 1）",
			health.resolvedCount - beforeH.resolvedCount === 1,
			`got ${health.resolvedCount}`
		)
		check(
			"真实回退只再加一（fallback delta === 1）",
			health.fallbackCount - beforeH.fallbackCount === 1,
			`got ${health.fallbackCount}`
		)
		check(
			"过期请求本身不是缓存命中（hits delta === 0）",
			health.cacheHits - beforeH.cacheHits === 0,
			`got ${health.cacheHits}`
		)

		const devCachedAgain = await getJson(`${baseUrl}/config/dev`)
		check("再次请求 dev 命中缓存", devCachedAgain.source === "default")
		const beforeLastHit = health
		health = await getJson(`${baseUrl}/health`)
		check(
			"末请求新增一次缓存命中（delta === 1），回退不再增加",
			health.cacheHits - beforeLastHit.cacheHits === 1 &&
				health.fallbackCount - beforeLastHit.fallbackCount === 0,
			`hits=${health.cacheHits} fallbacks=${health.fallbackCount}`
		)
	} finally {
		cleanup()
	}

	if (failures > 0) {
		console.error(`\n[verify] FAILED: ${failures} assertion(s) failed`)
		process.exitCode = 1
	} else {
		console.log("\n[verify] OK: all assertions passed")
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
