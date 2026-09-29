import { SERVER_CONFIGS } from "../server-configs"
import type { ServerConfig } from "../server-configs"

export const MODES = ["dev", "staging", "prod"] as const
export type Mode = (typeof MODES)[number]

export type ManifestSource = "remote" | "default"

export type ManifestData = {
	base: string
	servers: Record<string, ServerConfig>
}

export type ModeDefinition = {
	label: string
	upstreamUrl: string
	ttlMs: number
}

const DEFAULT_PORT = 5179
const UNREACHABLE_UPSTREAM = `http://127.0.0.1:${DEFAULT_PORT}/__unreachable/mcp-manifests`

function parseTtlOverride(): number | null {
	const raw = process.env.MCP_CONFIG_TTL_MS
	if (raw === undefined) return null
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function ttlFor(defaultTtlMs: number): number {
	return parseTtlOverride() ?? defaultTtlMs
}

function upstreamFor(envName: string, mode: Mode): string {
	return process.env[envName] ?? `${UNREACHABLE_UPSTREAM}/${mode}.json`
}

export const MODE_DEFINITIONS: Record<Mode, ModeDefinition> = {
	dev: {
		label: "开发模式",
		upstreamUrl: upstreamFor("MCP_CONFIG_UPSTREAM_DEV", "dev"),
		ttlMs: ttlFor(10_000)
	},
	staging: {
		label: "预发模式",
		upstreamUrl: upstreamFor("MCP_CONFIG_UPSTREAM_STAGING", "staging"),
		ttlMs: ttlFor(30_000)
	},
	prod: {
		label: "生产模式",
		upstreamUrl: upstreamFor("MCP_CONFIG_UPSTREAM_PROD", "prod"),
		ttlMs: ttlFor(30_000)
	}
}

export const DEFAULT_MANIFEST: ManifestData = {
	base: "/",
	servers: SERVER_CONFIGS
}
