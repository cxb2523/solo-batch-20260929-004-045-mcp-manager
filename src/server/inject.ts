import {
	type IncomingMessage,
	type ServerResponse,
	createServer
} from "node:http"
import { ManifestResolver } from "./manifest-resolver"
import { MODES, type ManifestSource, type Mode } from "./mode-config"
import { renderStatusPage } from "./status-page"

const PORT = Number.parseInt(process.env.MCP_CONFIG_PORT ?? "5179", 10)
const HOST = "127.0.0.1"

const resolver = new ManifestResolver()

function isMode(value: string | undefined): value is Mode {
	return value !== undefined && (MODES as readonly string[]).includes(value)
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	payload: unknown
): void {
	const body = JSON.stringify(payload)
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	})
	response.end(body)
}

function sendHtml(response: ServerResponse, body: string): void {
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store"
	})
	response.end(body)
}

async function handleConfig(
	mode: Mode,
	response: ServerResponse
): Promise<void> {
	const result = await resolver.resolve(mode)
	const source: ManifestSource = result.source
	sendJson(response, 200, {
		mode,
		epoch: result.epoch,
		source,
		fallback: source === "default",
		base: result.manifest.base,
		serverCount: Object.keys(result.manifest.servers).length,
		servers: result.manifest.servers
	})
}

async function handle(
	request: IncomingMessage,
	response: ServerResponse
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://localhost")
	const pathname = url.pathname

	if (request.method !== "GET") {
		sendJson(response, 405, { error: "method not allowed" })
		return
	}

	if (pathname === "/health") {
		sendJson(response, 200, { ok: true, ...resolver.snapshot() })
		return
	}

	if (pathname === "/status") {
		sendHtml(response, renderStatusPage(resolver.snapshot()))
		return
	}

	const configMatch = /^\/config\/([^/]+)$/.exec(pathname)
	if (configMatch !== null) {
		const mode = decodeURIComponent(configMatch[1])
		if (!isMode(mode)) {
			sendJson(response, 400, {
				error: `unknown mode, expected one of: ${MODES.join(", ")}`
			})
			return
		}
		await handleConfig(mode, response)
		return
	}

	sendJson(response, 404, { error: "not found" })
}

const server = createServer((request, response) => {
	handle(request, response).catch((error: unknown) => {
		console.error("[inject] request failed:", error)
		if (!response.headersSent) {
			sendJson(response, 500, { error: "internal server error" })
		} else {
			response.end()
		}
	})
})

server.listen(PORT, HOST, () => {
	console.log(
		`[inject] runtime config service listening on http://${HOST}:${PORT}`
	)
	console.log("[inject] endpoints: /config/:mode, /health, /status")
})

function shutdown(): void {
	server.close(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
