import {
	type IncomingMessage,
	type ServerResponse,
	createServer
} from "node:http"
import { pathToFileURL } from "node:url"
import {
	BUILD_INVARIANTS,
	ConfigResolver,
	DEFAULT_MODE,
	MODES
} from "./modes.ts"

export const INJECT_PORT = Number.parseInt(
	process.env.MCP_INJECT_PORT ?? "5179",
	10
)
export const INJECT_HOST = "127.0.0.1"

const resolver = new ConfigResolver()

const sendJson = (
	res: ServerResponse,
	statusCode: number,
	payload: unknown
): void => {
	const body = JSON.stringify(payload)
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-store"
	})
	res.end(body)
}

const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")

const renderStatusPage = (): string => {
	const status = resolver.getStatus()
	const modeLabel = MODES[status.currentMode]?.label ?? status.currentMode
	const ttlLabel = Number.isFinite(status.ttlMs)
		? `${status.ttlMs} ms`
		: "infinite (inlined)"
	const resolvedAt = status.lastResolvedAt
		? new Date(status.lastResolvedAt).toISOString()
		: "—"

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MCP Config Injector — Status</title>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1f2430; }
  main { max-width: 760px; margin: 48px auto; padding: 0 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  p.sub { margin: 0 0 28px; color: #6b7280; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; padding: 18px 20px; }
  .card .k { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; }
  .card .v { font-size: 22px; font-weight: 600; margin-top: 6px; word-break: break-all; }
  .wide { grid-column: 1 / -1; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 3px 10px; margin-left: 8px; vertical-align: middle; }
  .badge.inline { background: #e0f2fe; color: #075985; }
  .badge.remote { background: #dcfce7; color: #166534; }
  .badge.fallback { background: #fee2e2; color: #991b1b; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; font-size: 13px; }
  .hint { font-size: 13px; color: #6b7280; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <h1>MCP Config Injector
    <span class="badge ${escapeHtml(status.lastSource ?? "inline")}">${escapeHtml(
		status.lastSource ?? "pending"
	)}${status.lastFallback ? " · default list" : ""}</span>
  </h1>
  <p class="sub">Persistent local runtime config service · <code>127.0.0.1:${INJECT_PORT}</code> · refreshes every 2s</p>
  <section class="grid">
    <div class="card"><div class="k">Current Mode</div><div class="v">${escapeHtml(
		status.currentMode
	)}</div><div class="hint" style="margin:6px 0 0">${escapeHtml(modeLabel)}</div></div>
    <div class="card"><div class="k">Resolved Servers</div><div class="v" id="serverCount">${
		status.resolvedServerCount
	}</div></div>
    <div class="card"><div class="k">Resource Base</div><div class="v"><code>${escapeHtml(
		status.resourceBase
	)}</code></div></div>
    <div class="card"><div class="k">TTL</div><div class="v">${escapeHtml(
		ttlLabel
	)}</div></div>
    <div class="card"><div class="k">Cache Hits</div><div class="v" id="cacheHits">${
		status.cacheHits
	}</div></div>
    <div class="card"><div class="k">Fallback Count</div><div class="v" id="fallbackCount">${
		status.fallbackCount
	}</div></div>
    <div class="card"><div class="k">Epoch (mode switches)</div><div class="v">${
		status.epoch
	}</div></div>
    <div class="card"><div class="k">Last Resolved</div><div class="v" style="font-size:15px">${escapeHtml(
		resolvedAt
	)}</div></div>
    <div class="card wide"><div class="k">Build Invariants (identical across modes)</div>
      <div class="v" style="font-size:14px;font-weight:400;margin-top:10px">
        outDir <code>${escapeHtml(BUILD_INVARIANTS.outDir)}</code> ·
        base <code>${escapeHtml(BUILD_INVARIANTS.base)}</code> ·
        tsconfig refs <code>${BUILD_INVARIANTS.tsconfigReferences
			.map((ref) => escapeHtml(ref))
			.join("</code> <code>")}</code>
      </div>
    </div>
  </section>
  <p class="hint">Endpoints: <code>/config/:mode</code> for <code>${Object.keys(
		MODES
  ).join(" | ")}</code>, <code>/health</code>, <code>/status?json=1</code></p>
</main>
<script>
  async function refresh() {
    try {
      const s = await fetch('/status?json=1', { cache: 'no-store' }).then(function (r) { return r.json() });
      document.getElementById('serverCount').textContent = s.resolvedServerCount;
      document.getElementById('cacheHits').textContent = s.cacheHits;
      document.getElementById('fallbackCount').textContent = s.fallbackCount;
    } catch (error) { /* keep last rendered values */ }
  }
  setInterval(refresh, 2000);
</script>
</body>
</html>`
}

const handleConfig = async (
	mode: string,
	res: ServerResponse
): Promise<void> => {
	if (!(mode in MODES)) {
		sendJson(res, 404, {
			error: `unknown mode: ${mode}`,
			availableModes: Object.keys(MODES)
		})
		return
	}
	try {
		const manifest = await resolver.resolveMode(mode)
		sendJson(res, 200, manifest)
	} catch (error) {
		sendJson(res, 500, {
			error: error instanceof Error ? error.message : "resolution failed"
		})
	}
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url ?? "/", `http://${INJECT_HOST}`)
	const pathname = url.pathname

	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET,OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type"
		})
		res.end()
		return
	}

	if (req.method !== "GET") {
		sendJson(res, 405, { error: "method not allowed" })
		return
	}

	if (pathname === "/health") {
		sendJson(res, 200, {
			status: "ok",
			port: INJECT_PORT,
			defaultMode: DEFAULT_MODE,
			modes: Object.keys(MODES)
		})
		return
	}

	if (pathname === "/status") {
		if (url.searchParams.get("json") !== null) {
			sendJson(res, 200, resolver.getStatus())
			return
		}
		const html = renderStatusPage()
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Length": Buffer.byteLength(html),
			"Cache-Control": "no-store"
		})
		res.end(html)
		return
	}

	const configMatch = /^\/config\/([^/]+)$/.exec(pathname)
	if (configMatch) {
		void handleConfig(decodeURIComponent(configMatch[1]), res)
		return
	}

	sendJson(res, 404, {
		error: "not found",
		endpoints: ["/health", "/status", "/config/:mode"]
	})
})

server.on("error", (error) => {
	console.error("[inject] server error:", error)
	process.exitCode = 1
})

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
	server.listen(INJECT_PORT, INJECT_HOST, () => {
		console.log(
			`[inject] runtime config service listening on http://${INJECT_HOST}:${INJECT_PORT} ` +
				`(modes: ${Object.keys(MODES).join(", ")})`
		)
	})
}

export { resolver }
