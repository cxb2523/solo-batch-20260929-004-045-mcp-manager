import { SERVER_CONFIGS } from "../server-configs.ts"

/**
 * Build invariants that MUST stay identical across every runtime mode.
 * Vite consumes the same constants, so mode switches can never move
 * outDir/base or the tsconfig reference chain - artifact hashes remain
 * reproducible.
 */
export const BUILD_INVARIANTS = {
	outDir: "dist",
	base: "/",
	tsconfigReferences: ["./tsconfig.app.json", "./tsconfig.node.json"]
} as const

export type ConfigSource = "inline" | "remote" | "fallback"

export type ResolvedManifest = {
	mode: string
	servers: Record<string, unknown>
	serverCount: number
	resourceBase: string
	manifestUrl: string | null
	source: ConfigSource
	fallback: boolean
	resolvedAt: number
	ttlMs: number
	build: typeof BUILD_INVARIANTS
}

export type ModeDefinition = {
	name: string
	label: string
	resourceBase: string
	manifestUrl: string | null
	ttlMs: number
}

export const DEFAULT_MODE = "local"

/**
 * Three runtime modes. `local` resolves synchronously from the compile-time
 * inlined default list; `staging`/`prod` fetch at runtime and own their TTL
 * plus failure fallback to the same default list.
 */
export const MODES: Record<string, ModeDefinition> = {
	local: {
		name: "local",
		label: "Local (compile-time inlined defaults)",
		resourceBase: BUILD_INVARIANTS.base,
		manifestUrl: null,
		ttlMs: Number.POSITIVE_INFINITY
	},
	staging: {
		name: "staging",
		label: "Staging (runtime pull)",
		resourceBase: BUILD_INVARIANTS.base,
		manifestUrl:
			process.env.MCP_STAGING_MANIFEST_URL ??
			"https://manifest.staging.mcp-manager.invalid/manifest.json",
		ttlMs: 10_000
	},
	prod: {
		name: "prod",
		label: "Production (runtime pull)",
		resourceBase: BUILD_INVARIANTS.base,
		manifestUrl:
			process.env.MCP_PROD_MANIFEST_URL ??
			"https://manifest.mcp-manager.invalid/manifest.json",
		ttlMs: 10_000
	}
}

type CacheEntry = {
	manifest: ResolvedManifest
	expiresAt: number
}

export type StatusSnapshot = {
	currentMode: string
	epoch: number
	resolvedServerCount: number
	resourceBase: string
	cacheHits: number
	fallbackCount: number
	lastSource: ConfigSource | null
	lastFallback: boolean
	lastResolvedAt: number | null
	switchedAt: number | null
	ttlMs: number
	build: typeof BUILD_INVARIANTS
}

const isManifestShape = (value: unknown): value is { servers: unknown } =>
	typeof value === "object" &&
	value !== null &&
	"servers" in value &&
	typeof (value as { servers: unknown }).servers === "object" &&
	(value as { servers: unknown }).servers !== null

/**
 * Stateful resolver. The guarantees implemented here are load-bearing:
 *
 *  1. Single-flight: concurrent requests for one mode share the same
 *     in-flight Promise (only the first triggers a real resolution).
 *  2. Epoch guard: switching modes bumps a monotonic epoch; each request
 *     captures it and a stale response whose epoch no longer matches is
 *     dropped, so an old slow response can never overwrite new state.
 *  3. Real fallback only: fallbackCount increments exactly once per genuine
 *     upstream failure, never for cached fallback reuse or cache hits.
 */
export class ConfigResolver {
	private readonly cache = new Map<string, CacheEntry>()
	private readonly inflight = new Map<string, Promise<ResolvedManifest>>()
	private currentMode = DEFAULT_MODE
	private epoch = 0
	private cacheHits = 0
	private fallbackCount = 0
	private resolvedServerCount = Object.keys(SERVER_CONFIGS).length
	private resourceBase = MODES[DEFAULT_MODE].resourceBase
	private lastSource: ConfigSource | null = null
	private lastFallback = false
	private lastResolvedAt: number | null = null
	private switchedAt: number | null = null

	resolveMode(mode: string): Promise<ResolvedManifest> {
		const definition = MODES[mode]
		if (!definition) {
			return Promise.reject(new Error(`unknown mode: ${mode}`))
		}

		const requestEpoch = this.beginModeSwitch(mode)

		const cached = this.cache.get(mode)
		if (cached && cached.expiresAt > Date.now()) {
			this.cacheHits += 1
			this.publishIfCurrent(requestEpoch, mode, cached.manifest)
			return Promise.resolve(cached.manifest)
		}

		const existing = this.inflight.get(mode)
		if (existing) {
			this.cacheHits += 1
			this.attachPublication(existing, requestEpoch, mode)
			return existing
		}

		const promise =
			definition.manifestUrl === null
				? this.runInline(definition)
				: this.resolveRemote(definition)

		// Register the in-flight Promise synchronously before any await
		// boundary, so concurrent callers deterministically share it.
		this.inflight.set(mode, promise)
		this.attachPublication(promise, requestEpoch, mode)

		promise
			.catch(() => undefined)
			.finally(() => {
				if (this.inflight.get(mode) === promise) {
					this.inflight.delete(mode)
				}
			})

		return promise
	}

	private beginModeSwitch(mode: string): number {
		if (mode !== this.currentMode) {
			this.currentMode = mode
			this.epoch += 1
			this.switchedAt = Date.now()
		}
		return this.epoch
	}

	private attachPublication(
		promise: Promise<ResolvedManifest>,
		requestEpoch: number,
		mode: string
	): void {
		promise.then(
			(manifest) => {
				this.publishIfCurrent(requestEpoch, mode, manifest)
			},
			() => undefined
		)
	}

	private publishIfCurrent(
		requestEpoch: number,
		mode: string,
		manifest: ResolvedManifest
	): void {
		if (requestEpoch !== this.epoch || mode !== this.currentMode) {
			return
		}
		this.resolvedServerCount = manifest.serverCount
		this.resourceBase = manifest.resourceBase
		this.lastSource = manifest.source
		this.lastFallback = manifest.fallback
		this.lastResolvedAt = manifest.resolvedAt
	}

	private runInline(definition: ModeDefinition): Promise<ResolvedManifest> {
		const manifest = this.buildInline(definition)
		this.store(definition, manifest)
		return Promise.resolve(manifest)
	}

	private buildInline(definition: ModeDefinition): ResolvedManifest {
		return {
			mode: definition.name,
			servers: SERVER_CONFIGS,
			serverCount: Object.keys(SERVER_CONFIGS).length,
			resourceBase: definition.resourceBase,
			manifestUrl: null,
			source: "inline",
			fallback: false,
			resolvedAt: Date.now(),
			ttlMs: definition.ttlMs,
			build: BUILD_INVARIANTS
		}
	}

	private async resolveRemote(
		definition: ModeDefinition
	): Promise<ResolvedManifest> {
		try {
			const response = await fetch(definition.manifestUrl ?? "", {
				signal: AbortSignal.timeout(4000)
			})
			if (!response.ok) {
				throw new Error(`upstream responded ${response.status}`)
			}
			const payload: unknown = await response.json()
			if (!isManifestShape(payload)) {
				throw new Error("upstream manifest has invalid shape")
			}

			const servers = payload.servers as Record<string, unknown>
			const manifest: ResolvedManifest = {
				mode: definition.name,
				servers,
				serverCount: Object.keys(servers).length,
				resourceBase: definition.resourceBase,
				manifestUrl: definition.manifestUrl,
				source: "remote",
				fallback: false,
				resolvedAt: Date.now(),
				ttlMs: definition.ttlMs,
				build: BUILD_INVARIANTS
			}
			this.store(definition, manifest)
			return manifest
		} catch {
			// A genuine upstream failure: fall back to the inlined default
			// list and count exactly this occurrence once. Fallback results
			// are intentionally NOT cached, so the next request retries the
			// upstream and any still-real failure is counted again.
			const fallback = this.resolveFallback(definition)
			this.fallbackCount += 1
			return fallback
		}
	}

	private resolveFallback(definition: ModeDefinition): ResolvedManifest {
		return {
			...this.buildInline(definition),
			manifestUrl: definition.manifestUrl,
			source: "fallback",
			fallback: true,
			resolvedAt: Date.now()
		}
	}

	private store(
		definition: ModeDefinition,
		manifest: ResolvedManifest,
		ttlMs: number = definition.ttlMs
	): void {
		this.cache.set(definition.name, {
			manifest,
			expiresAt: Date.now() + ttlMs
		})
	}

	getStatus(): StatusSnapshot {
		return {
			currentMode: this.currentMode,
			epoch: this.epoch,
			resolvedServerCount: this.resolvedServerCount,
			resourceBase: this.resourceBase,
			cacheHits: this.cacheHits,
			fallbackCount: this.fallbackCount,
			lastSource: this.lastSource,
			lastFallback: this.lastFallback,
			lastResolvedAt: this.lastResolvedAt,
			switchedAt: this.switchedAt,
			ttlMs: MODES[this.currentMode].ttlMs,
			build: BUILD_INVARIANTS
		}
	}
}
