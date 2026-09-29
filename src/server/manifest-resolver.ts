import type { ServerConfig } from "../server-configs"
import {
	DEFAULT_MANIFEST,
	MODES,
	MODE_DEFINITIONS,
	type ManifestData,
	type ManifestSource,
	type Mode
} from "./mode-config"

const FETCH_TIMEOUT_MS = 2000

type ResolveResult = {
	manifest: ManifestData
	source: ManifestSource
	epoch: number
}

type CacheEntry = {
	manifest: ManifestData
	source: ManifestSource
	fetchedAt: number
}

type InFlight = {
	promise: Promise<ResolveResult>
	sharers: number
}

type ModeStatus = {
	pending: boolean
	lastSource: ManifestSource | null
	lastResolvedAt: number | null
	cachedUntil: number | null
	serverCount: number | null
	base: string | null
}

export type ResolverSnapshot = {
	epoch: number
	currentMode: Mode | null
	pending: boolean
	serverCount: number | null
	base: string | null
	cacheHits: number
	fallbackCount: number
	inFlightShares: number
	staleDropped: number
	resolvedCount: number
	modeRows: Record<
		Mode,
		{
			label: string
			upstreamUrl: string
			ttlMs: number
			pending: boolean
			lastSource: ManifestSource | null
			lastResolvedAt: number | null
			cachedUntil: number | null
			serverCount: number | null
			base: string | null
		}
	>
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	)
}

function parseServerConfig(value: unknown): ServerConfig | null {
	if (!isObjectRecord(value)) return null
	if (typeof value.icon !== "string") return null
	if (typeof value.description !== "string") return null
	if (typeof value.docsUrl !== "string") return null
	if (value.command !== undefined && typeof value.command !== "string") {
		return null
	}
	if (value.args !== undefined && !isStringArray(value.args)) return null
	if (
		value.env !== undefined &&
		(!isObjectRecord(value.env) ||
			Object.values(value.env).some((entry) => typeof entry !== "string"))
	) {
		return null
	}
	if (value.setupCommands !== undefined) {
		const setupCommands = value.setupCommands
		if (
			!isObjectRecord(setupCommands) ||
			typeof setupCommands.installPath !== "string" ||
			typeof setupCommands.command !== "string"
		) {
			return null
		}
	}
	return value as ServerConfig
}

function parseRemoteManifest(value: unknown): ManifestData {
	if (!isObjectRecord(value)) throw new Error("invalid manifest payload")
	if (typeof value.base !== "string" || !value.base.startsWith("/")) {
		throw new Error("invalid manifest: base must be an absolute path")
	}
	if (!isObjectRecord(value.servers)) {
		throw new Error("invalid manifest: servers must be an object")
	}
	const servers: Record<string, ServerConfig> = {}
	for (const [key, entry] of Object.entries(value.servers)) {
		const parsed = parseServerConfig(entry)
		if (parsed === null) throw new Error(`invalid server config: ${key}`)
		servers[key] = parsed
	}
	return { base: value.base, servers }
}

async function fetchRemoteManifest(upstreamUrl: string): Promise<ManifestData> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		const response = await fetch(upstreamUrl, {
			signal: controller.signal
		})
		if (!response.ok) {
			throw new Error(`upstream responded ${response.status}`)
		}
		const payload: unknown = await response.json()
		return parseRemoteManifest(payload)
	} finally {
		clearTimeout(timer)
	}
}

function createIdleModeStatuses(): Record<Mode, ModeStatus> {
	const rows = {} as Record<Mode, ModeStatus>
	for (const mode of MODES) {
		rows[mode] = {
			pending: false,
			lastSource: null,
			lastResolvedAt: null,
			cachedUntil: null,
			serverCount: null,
			base: null
		}
	}
	return rows
}

export class ManifestResolver {
	#cache = new Map<Mode, CacheEntry>()
	#inFlight = new Map<Mode, InFlight>()
	#modeStatuses = createIdleModeStatuses()
	#epoch = 0
	#currentMode: Mode | null = null
	#serverCount: number | null = null
	#base: string | null = null
	#pending = false
	#cacheHits = 0
	#fallbackCount = 0
	#inFlightShares = 0
	#staleDropped = 0
	#resolvedCount = 0

	resolve(mode: Mode): Promise<ResolveResult> {
		const requestEpoch = this.#enterMode(mode)

		const cached = this.#cache.get(mode)
		if (
			cached !== undefined &&
			cached.fetchedAt >= Date.now() - MODE_DEFINITIONS[mode].ttlMs
		) {
			this.#cacheHits += 1
			this.#applyHeadline(
				mode,
				requestEpoch,
				/* pending */ false,
				cached.manifest.servers,
				cached.manifest.base
			)
			return Promise.resolve({
				manifest: cached.manifest,
				source: cached.source,
				epoch: requestEpoch
			})
		}

		const existing = this.#inFlight.get(mode)
		if (existing !== undefined) {
			existing.sharers += 1
			this.#inFlightShares += 1
			this.#modeStatuses[mode].pending = true
			this.#pending = true
			return existing.promise
		}

		const promise = this.#resolveFresh(mode, requestEpoch)
		this.#inFlight.set(mode, { promise, sharers: 0 })
		this.#modeStatuses[mode].pending = true
		this.#pending = true
		return promise
	}

	#enterMode(mode: Mode): number {
		if (this.#currentMode !== mode) {
			this.#currentMode = mode
			this.#epoch += 1
		}
		return this.#epoch
	}

	async #resolveFresh(
		mode: Mode,
		requestEpoch: number
	): Promise<ResolveResult> {
		try {
			const manifest = await fetchRemoteManifest(
				MODE_DEFINITIONS[mode].upstreamUrl
			)
			const result: ResolveResult = {
				manifest,
				source: "remote",
				epoch: requestEpoch
			}
			this.#storeResolution(mode, result)
			return result
		} catch {
			const result: ResolveResult = {
				manifest: DEFAULT_MANIFEST,
				source: "default",
				epoch: requestEpoch
			}
			this.#fallbackCount += 1
			this.#storeResolution(mode, result)
			return result
		} finally {
			this.#inFlight.delete(mode)
		}
	}

	#storeResolution(mode: Mode, result: ResolveResult): void {
		const now = Date.now()
		this.#cache.set(mode, {
			manifest: result.manifest,
			source: result.source,
			fetchedAt: now
		})
		this.#resolvedCount += 1

		const status = this.#modeStatuses[mode]
		status.pending = false
		status.lastSource = result.source
		status.lastResolvedAt = now
		status.cachedUntil = now + MODE_DEFINITIONS[mode].ttlMs
		status.serverCount = Object.keys(result.manifest.servers).length
		status.base = result.manifest.base

		const accepted = result.epoch === this.#epoch
		if (!accepted) {
			this.#staleDropped += 1
			return
		}
		this.#applyHeadline(
			mode,
			result.epoch,
			/* pending */ false,
			result.manifest.servers,
			result.manifest.base
		)
	}

	#applyHeadline(
		mode: Mode,
		epoch: number,
		pending: boolean,
		servers: Record<string, ServerConfig>,
		base: string
	): void {
		if (epoch !== this.#epoch || this.#currentMode !== mode) {
			return
		}
		this.#pending = pending
		this.#serverCount = Object.keys(servers).length
		this.#base = base
	}

	snapshot(): ResolverSnapshot {
		const rows = {} as ResolverSnapshot["modeRows"]
		for (const mode of MODES) {
			const status = this.#modeStatuses[mode]
			const definition = MODE_DEFINITIONS[mode]
			rows[mode] = {
				label: definition.label,
				upstreamUrl: definition.upstreamUrl,
				ttlMs: definition.ttlMs,
				pending: status.pending,
				lastSource: status.lastSource,
				lastResolvedAt: status.lastResolvedAt,
				cachedUntil: status.cachedUntil,
				serverCount: status.serverCount,
				base: status.base
			}
		}
		return {
			epoch: this.#epoch,
			currentMode: this.#currentMode,
			pending: this.#pending,
			serverCount: this.#serverCount,
			base: this.#base,
			cacheHits: this.#cacheHits,
			fallbackCount: this.#fallbackCount,
			inFlightShares: this.#inFlightShares,
			staleDropped: this.#staleDropped,
			resolvedCount: this.#resolvedCount,
			modeRows: rows
		}
	}
}
