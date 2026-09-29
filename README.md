<h1 align="center">MCP Manager for Claude Desktop</h1>

<p align="center">A simple web GUI to manage Model Context Protocol (MCP) servers for the Claude Desktop app on MacOS easily. Just follow the instructions and paste a few commands to give your Claude app instant superpowers. </p>

![MCP Manager for Claude Desktop](https://assets.zue.ai/mcp-manager-hero.png)

## What is MCP?

The Model Context Protocol (MCP) enables Claude to access private data, APIs, and other services to answer questions and perform actions on your behalf. Learn more about MCP at:

- [modelcontextprotocol.io](https://modelcontextprotocol.io)
- [Anthropic's MCP Announcement](https://www.anthropic.com/news/model-context-protocol)

## Features

- 🚀 Easy-to-use interface for managing MCP servers
- 🔒 Runs entirely client-side - your data never leaves your computer
- ⚡️ Quick setup for popular MCP servers:
  - Apple Notes - Access and search your Apple Notes
  - AWS Knowledge Base - Access and query AWS Knowledge Base for information retrieval
  - Brave Search - Search the web with Brave Search API
  - Browserbase - Let Claude explore the web with Browserbase
  - Cloudflare - Manage your Cloudflare workers and account resources
  - Everart - Interface with Everart API for digital art and design tools
  - Exa - Search the web with Exa
  - Filesystem - Access and manage local filesystem
  - GitHub - Access your GitHub repositories
  - GitLab - Manage GitLab repositories and resources
  - Google Drive - Access and search files in your Google Drive
  - Google Maps - Access Google Maps API for location services
  - Memory - Give Claude memory of previous conversations
  - Obsidian - Read and search files in your Obsidian vault
  - Perplexity - Search the web with Perplexity API
  - PostgreSQL - Connect and interact with PostgreSQL databases
  - Puppeteer - Automate browser interactions
  - Sequential Thinking - Enable step-by-step reasoning
  - Slack - Access your Slack workspace
  - SQLite - Manage SQLite databases
  - Todoist - Access and search your Todoist tasks
  - YouTube Transcript - Access and search YouTube transcripts
- 🛠 Simple configuration of environment variables and server settings
- 📋 One-click copying of terminal commands for installation

## Tech Stack

- **Frontend Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**:
  - TailwindCSS for utility-first CSS
  - DaisyUI for component styling
  - Tiempos Font to match the Anthropic Design Language
- **Package Manager**: Bun
- **Deployment**: Cloudflare Pages for <60s build times

## Project Structure

```plaintext
src/
├── components/ # React components
│ ├── server-configs/ # Server-specific configuration components
│ └── ...
├── assets/ # Static assets and fonts
├── server/ # Local runtime config injection service (Node/Bun)
├── App.tsx # Main application component
├── server-configs.ts # MCP server configurations
└── utils.ts # Utility functions
```

## Runtime Config Injection (Three Modes)

The three-mode configuration (`dev` / `staging` / `prod`) is no longer inlined
as a build-time constant. A long-running local service resolves manifests at
runtime:

```bash
bun run serve:config
# -> http://127.0.0.1:5179
```

- `GET /config/:mode` — resolved manifest for `dev`, `staging` or `prod`
  (`{ mode, epoch, source, fallback, base, serverCount, servers }`)
- `GET /health` — JSON snapshot used for health checks and verification
- `GET /status` — embedded, self-refreshing status page (for screen
  recordings) showing the current mode, resolved server count, resource base,
  cache hits, fallback count, in-flight merges and dropped stale results

Upstream URLs and TTLs per mode live in `src/server/mode-config.ts`; the
fallback manifest is the default `SERVER_CONFIGS` from
`src/server-configs.ts`. Overrides:

- `MCP_CONFIG_UPSTREAM_DEV` / `MCP_CONFIG_UPSTREAM_STAGING` /
  `MCP_CONFIG_UPSTREAM_PROD`
- `MCP_CONFIG_TTL_MS` (single override applied to every mode, default
  10s for `dev` and 30s for `staging`/`prod`)
- `MCP_CONFIG_PORT` (defaults to `5179`)

### Decision: runtime fetch with self-managed TTL and failure fallback

We chose **runtime fetch with self-managed TTL + failure fallback**, not
compile-time inlining. A local service fetches each mode's manifest on demand,
caches it per mode for its TTL, and when the upstream is unreachable, times
out, returns non-2xx or sends an invalid payload it falls back to the default
manifest compiled from `src/server-configs.ts`. This keeps the build
mode-agnostic while still guaranteeing an answer when the network is down.
Compile-time inlining was rejected because it would require a rebuild per
environment and could not recover from an unavailable manifest source without
shipping a second artifact.

The three interlocking concurrency rules are:

- Concurrent requests for the same mode share one in-flight promise; only the
  first triggers a real resolution, the rest await the same promise.
- Switching modes bumps a monotonically increasing `epoch`; a result resolved
  under an older epoch is still cached per mode but can never overwrite the
  headline state of the current mode.
- Fallback to the default manifest increments `fallbackCount` only when a
  real resolution actually fails — cache hits and in-flight shares never
  increment it.

### Decision: layered, serial lint pipeline

Biome and ESLint are run as a **layered serial pipeline**, not merged into one
chain. Biome owns formatting and its recommended cross-language rules
(`bun check` runs `tsc --noEmit` then `biome check --write .`); ESLint is a
separate layer (`bun run lint`) for the framework-specific React
`react-hooks` / `react-refresh` rules that Biome does not cover. Merging them
into a single driver would either duplicate overlapping rules or force one
tool to suppress the other; serial layers keep responsibilities clear and let
each tool exit on its own diagnostics.

### Reproducible builds across modes

Modes never change Vite inputs: `vite.config.ts` pins `base: "/"`,
`build.outDir: "dist"` and `build.assetsDir: "assets"`, while the
`tsconfig.json` reference chain (`tsconfig.app.json` for the browser app,
excluding `src/server`; `tsconfig.node.json` for `vite.config.ts` and
`src/server`) is identical in every mode. Asset names are content hashes of
identical inputs, so repeated builds emit identical hashes regardless of which
mode the config service last served.

### Verification

```bash
bun run verify:config
```

Spins up a mock upstream plus the inject service, fires three requests at the
same mode (asserting one real resolution with the rest coalesced or cached),
switches modes to assert epoch-guarded stale-result dropping, and asserts the
cache-hit and real-fallback counters on `/health` and `/status`. It also
checks TTL expiry, invalid-mode `400` and unknown-route `404`.

## Development

1. Install dependencies:

   ```bash
   bun install
   ```

2. Start the dev server:

   ```bash
   bun dev
   ```

3. Build for production:

   ```bash
   bun run build
   ```

## Contributing

Contributions are extremely welcome! Please open a PR with new MCP servers or any other improvements to the codebase.
PS. I wasnt able to get fetch, time, and sentry working, if you can help me out, that would be great!

## Disclaimer

This project is not affiliated with Anthropic. All logos are trademarks of their respective owners.

## License

Apache 2.0

---
<br/>
<br/>
<p align="center">
<a href="https://zue.ai#gh-light-mode-only">
  <img src="https://assets.zue.ai/logo_zue_purple.svg" alt="zue logo" width="200" height="auto" style="display: block; margin: 0 auto;" />
</a>
<a href="https://zue.ai#gh-dark-mode-only">
  <img src="https://assets.zue.ai/logo_zue_yellow.svg" alt="zue logo" width="200" height="auto" style="display: block; margin: 0 auto;" />
</a>
</p>

<p align="center">
<a href="https://zue.ai/talk-to-us">Contact us</a> for custom AI automation solutions and product development.
</p>
