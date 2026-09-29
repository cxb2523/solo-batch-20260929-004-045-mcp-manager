import { SERVER_CONFIGS, type ServerConfig } from "./server-configs"

export type RuntimeConfigSource = "inline" | "remote" | "fallback"

export type RuntimeConfigResponse = {
	mode: string
	servers: Record<string, ServerConfig>
	serverCount: number
	resourceBase: string
	source: RuntimeConfigSource
	fallback: boolean
}

const INJECT_PORT = 5179
const INJECT_ORIGIN = `http://127.0.0.1:${INJECT_PORT}`

export type RuntimeConfigResult = {
	mode: string
	configs: Record<string, ServerConfig>
	source: RuntimeConfigSource
	fallback: boolean
}

const inlineResult = (mode: string): RuntimeConfigResult => ({
	mode,
	configs: SERVER_CONFIGS,
	source: "inline",
	fallback: false
})

/**
 * Browser counterpart of the persistent local injector. When the service is
 * unreachable (or answers badly) we transparently fall back to the same
 * compile-time inlined default list the UI always started from.
 */
export const fetchRuntimeConfig = async (
	mode: string
): Promise<RuntimeConfigResult> => {
	try {
		const response = await fetch(`${INJECT_ORIGIN}/config/${mode}`, {
			signal: AbortSignal.timeout(2500),
			cache: "no-store"
		})
		if (!response.ok) {
			throw new Error(`injector responded ${response.status}`)
		}
		const payload = (await response.json()) as RuntimeConfigResponse
		if (typeof payload.servers !== "object" || payload.servers === null) {
			throw new Error("injector payload missing servers")
		}
		return {
			mode: payload.mode,
			configs: payload.servers,
			source: payload.fallback ? "fallback" : payload.source,
			fallback: payload.fallback
		}
	} catch {
		return inlineResult(mode)
	}
}

export const resolveInitialMode = (): string => {
	const requested = new URLSearchParams(window.location.search).get("mode")
	return requested === "staging" || requested === "prod" ? requested : "local"
}
