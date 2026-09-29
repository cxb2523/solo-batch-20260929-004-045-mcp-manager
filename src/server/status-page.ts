import type { ResolverSnapshot } from "./manifest-resolver"
import { MODES } from "./mode-config"
import type { ManifestSource, Mode } from "./mode-config"

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
}

function formatTime(timestamp: number | null): string {
	if (timestamp === null) return "—"
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false })
}

function sourceLabel(source: ManifestSource | null): string {
	if (source === "remote") return "远端清单"
	if (source === "default") return "默认清单（已回退）"
	return "尚未解析"
}

function sourceClass(source: ManifestSource | null): string {
	if (source === "remote") return "src src-remote"
	if (source === "default") return "src src-default"
	return "src src-idle"
}

function renderModeRows(snapshot: ResolverSnapshot): string {
	return MODES.map((mode: Mode) => {
		const row = snapshot.modeRows[mode]
		const active = snapshot.currentMode === mode
		const remaining =
			row.cachedUntil === null
				? "—"
				: Math.max(0, Math.round((row.cachedUntil - Date.now()) / 1000))
		return `
        <tr class="${active ? "active" : ""}">
          <td><span class="dot ${active ? "dot-active" : ""}"></span>${escapeHtml(row.label)} <code>${mode}</code></td>
          <td><span class="${sourceClass(row.lastSource)}">${sourceLabel(row.lastSource)}</span></td>
          <td class="num">${row.serverCount === null ? "—" : row.serverCount}</td>
          <td><code>${escapeHtml(row.base ?? "—")}</code></td>
          <td class="num">${remaining === "—" ? "—" : `${remaining}s`}</td>
          <td>${formatTime(row.lastResolvedAt)}</td>
          <td class="url"><code>${escapeHtml(row.upstreamUrl)}</code></td>
        </tr>`
	}).join("")
}

export function renderStatusPage(snapshot: ResolverSnapshot): string {
	const currentMode =
		snapshot.currentMode === null
			? "尚未请求"
			: `${snapshot.modeRows[snapshot.currentMode].label}（${snapshot.currentMode}）`
	const serverCount =
		snapshot.serverCount === null ? "—" : snapshot.serverCount
	const base = snapshot.base === null ? "—" : snapshot.base
	return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="2" />
    <title>MCP 配置注入服务 · 状态</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        padding: 32px;
      }
      h1 { font-size: 22px; margin: 0 0 4px; }
      .sub { color: #94a3b8; font-size: 13px; margin-bottom: 24px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 28px; }
      .card {
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 12px;
        padding: 16px;
      }
      .card .k { color: #94a3b8; font-size: 12px; margin-bottom: 8px; }
      .card .v { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .card .v small { font-size: 13px; font-weight: 400; color: #94a3b8; }
      .v.warn { color: #fbbf24; }
      .v.ok { color: #34d399; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; }
      th { color: #94a3b8; font-weight: 500; font-size: 12px; }
      tr.active { background: rgba(56, 189, 248, 0.08); }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      td.url { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #cbd5e1; }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #475569; margin-right: 8px; }
      .dot-active { background: #38bdf8; box-shadow: 0 0 8px #38bdf8; }
      .src { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
      .src-remote { background: rgba(52, 211, 153, 0.15); color: #6ee7b7; }
      .src-default { background: rgba(251, 191, 36, 0.15); color: #fcd34d; }
      .src-idle { color: #94a3b8; }
      .foot { margin-top: 20px; color: #64748b; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>MCP 三态运行时配置注入服务</h1>
    <div class="sub">端口 5179 · 每 2 秒自动刷新 · 录屏用状态页 · epoch <strong data-testid="epoch">${snapshot.epoch}</strong>${snapshot.pending ? " · 解析中…" : ""}${snapshot.staleDropped > 0 ? ` · 已丢弃过期结果 ${snapshot.staleDropped} 次` : ""}</div>

    <section class="cards">
      <div class="card"><div class="k">当前模式</div><div class="v" data-testid="current-mode" style="font-size:18px">${escapeHtml(currentMode)}</div></div>
      <div class="card"><div class="k">已解析服务器数</div><div class="v" data-testid="server-count">${serverCount}</div></div>
      <div class="card"><div class="k">资源基址 base</div><div class="v" style="font-size:18px"><code data-testid="base">${escapeHtml(base)}</code></div></div>
      <div class="card"><div class="k">缓存命中</div><div class="v ok" data-testid="cache-hits">${snapshot.cacheHits}</div></div>
      <div class="card"><div class="k">真实回退次数</div><div class="v ${snapshot.fallbackCount > 0 ? "warn" : ""}" data-testid="fallback-count">${snapshot.fallbackCount}</div></div>
      <div class="card"><div class="k">并发合并 / 真实解析</div><div class="v"><small data-testid="inflight">${snapshot.inFlightShares} 次合并</small> / <small data-testid="resolved">${snapshot.resolvedCount} 次</small></div></div>
    </section>

    <table data-testid="mode-table">
      <thead>
        <tr>
          <th>模式</th>
          <th>清单来源</th>
          <th style="text-align:right">服务器数</th>
          <th>base</th>
          <th style="text-align:right">缓存剩余</th>
          <th>上次解析</th>
          <th>上游地址</th>
        </tr>
      </thead>
      <tbody>${renderModeRows(snapshot)}
      </tbody>
    </table>

    <div class="foot">
      接口：<code>GET /config/:mode</code>（mode ∈ dev | staging | prod）、<code>GET /health</code>。
      上游不可达时自动退回 <code>src/server-configs.ts</code> 默认清单。
    </div>
  </body>
</html>`
}
