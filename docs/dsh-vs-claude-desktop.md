# DSH vs Claude Desktop: Plugin Architecture Comparison

This document compares the plugin/extension architecture of **DeepSeek Harness (DSH)** and **Claude Desktop**, two local AI assistant platforms released in 2026.

---

## Quick Comparison Table

| Dimension | DeepSeek Harness | Claude Desktop |
|---|---|---|
| **Release Date** | August 2026 (dev preview) | MCP protocol: Nov 2024 |
| **Core Architecture** | Cordis plugin tree | Electron + MCP protocol |
| **Philosophy** | "Everything is a plugin" | "Core + external bridges" |
| **Plugin Types** | Host / Client / Hybrid | MCP servers (protocol-based) |
| **Official Docs** | Locked in `app.asar`, zero `.d.ts` | Full docs + JSON-RPC spec |
| **Installation** | GUI manual path paste | One-click + auto-update |
| **Ecosystem Size** | ~1000s (2 months, Oct 2026) | 2300+ servers (18 months) |
| **License** | MIT (DSH), packages proprietary | MCP: Linux Foundation |

---

## 1. Architecture Philosophy

### DSH: "Everything is a plugin"

DeepSeek Harness uses **Cordis**, a dependency-injection framework originally from Koishi bot framework:

```yaml
# cordis.patch.yml - the heart of DSH extensibility
- insert:
  - id: dsh-session-query
    name: '@deepseek-ai/dsh-session-query'
  - id: usage-insights
    name: '@local/dsh-usage-insights'  # your plugin
```

**Key characteristics**:
- Models, tools, skills, sessions, storage, UI—all are plugins
- Plugins inject services (`ctx.sessionQuery`, `ctx.tools`) and consume others
- Hot-reloadable: change a plugin, profile reloads
- No central API contract: each plugin declares `inject` and `export`

**Pros**:
- Maximum flexibility: you can replace **any** part of the stack
- Unified extension model: same mechanism for Host and Client
- Framework-grade: dependency graph, lifecycle hooks, `ctx.effect()` cleanup

**Cons**:
- High learning curve: must understand Cordis DI model
- Fragile: one plugin crash can take down the entire profile
- Documentation scattered: 287 packages, READMEs locked in `app.asar`

---

### Claude Desktop: "Core + MCP Bridges"

Claude Desktop's extensibility is via **Model Context Protocol (MCP)**:

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}
```

**Key characteristics**:
- Core UI and model are **not** replaceable
- MCP servers run as separate processes (stdio or SSE transport)
- Standard JSON-RPC 2.0 protocol: `tools/list`, `resources/read`, `prompts/get`
- Claude calls MCP servers for tools/resources, servers respond with structured data

**Pros**:
- Low learning curve: standard JSON-RPC, language-agnostic
- Process isolation: one server crash doesn't affect others
- Excellent docs: [claude.com/docs/mcp](https://claude.com/docs/third-party/claude-desktop/extensions)
- One-click install: Desktop Extensions feature (May 2026)

**Cons**:
- Limited scope: can't modify core UI, model routing, or session management
- IPC overhead: stdio transport adds latency vs in-process plugins
- No UI extensions: can't add sidebar panels or custom views (yet)

---

## 2. Plugin/Extension Types

### DSH Plugin Categories

| Type | Runs | Can Access | Example |
|---|---|---|---|
| **Host** | Node.js backend | `ctx.sessionQuery`, `ctx.tools`, file system | `usage-insights` (data aggregation) |
| **Client** | Browser (React) | `window.__ModuleLoader__`, `ctx.slots` | `usage-insights` (sidebar panel) |
| **Hybrid** | Both | Full stack | `dsh-client-ui-sidebar` (official) |
| **Skill** | Loaded by agent | Markdown + prompt | `.dsh/skills/deploy.md` |

All use the same **Cordis DI** system.

---

### Claude Desktop Extension Types

| Type | Protocol | Can Access | Example |
|---|---|---|---|
| **Tools** | `tools/list`, `tools/call` | External APIs, file system | GitHub server (create issue) |
| **Resources** | `resources/list`, `resources/read` | Files, databases, internal data | Filesystem server (read files) |
| **Prompts** | `prompts/list`, `prompts/get` | Pre-written prompt templates | Git commit message generator |

All communicate via **JSON-RPC 2.0** over stdio or SSE.

---

## 3. Development Experience

### Writing a DSH Plugin

**Minimal Host plugin** (tools):
```javascript
// index.js
export const inject = ['tools']  // declare dependency

export function apply(ctx) {
  ctx.tools.register({
    name: 'get_weather',
    description: 'Get current weather',
    parameters: { /* JSON Schema */ },
    execute: async (args) => {
      return { temp: 72, condition: 'sunny' }
    }
  })
}
```

**Challenges**:
1. Must extract API docs from `app.asar` (official docs incomplete)
2. No `.d.ts` files shipped (need to read `lib/index.js` source)
3. Manifest rules scattered across multiple READMEs:
   - `dsh.bundle.patch` required
   - `exports["./client"]` required for hybrid plugins
   - Client bundle must call `__ModuleLoader__.load()`
4. Hard to debug: profile reload on error, sparse error messages

**Our solution**: [dsh-devkit](../packages/devkit) — 16 static checks, asar extraction, scaffold generator

---

### Writing an MCP Server

**Minimal MCP server** (tools):
```typescript
// server.ts
import { Server } from '@modelcontextprotocol/sdk/server'

const server = new Server({
  name: 'weather-server',
  version: '1.0.0'
})

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'get_weather',
    description: 'Get current weather',
    inputSchema: { /* JSON Schema */ }
  }]
}))

server.setRequestHandler('tools/call', async (req) => {
  const { temp, condition } = await fetchWeather(req.params.arguments.city)
  return { content: [{ type: 'text', text: `${temp}°F, ${condition}` }] }
})

server.listen()  // stdio transport
```

**Advantages**:
1. Official SDK with TypeScript types: `@modelcontextprotocol/sdk`
2. Protocol spec: [spec.modelcontextprotocol.io](https://spec.modelcontextprotocol.io)
3. Language-agnostic: Python, Rust, Go SDKs available
4. Easy debugging: MCP Inspector tool, stderr logging

---

## 4. Use Cases Each Excels At

### DSH Wins

| Use Case | Why DSH is Better |
|---|---|
| **Replace core components** | Want a different model router? Swap `dsh-model-router` |
| **Custom UI panels** | Add sidebar panels, custom views (like `usage-insights`) |
| **Deep integration** | Access session internals (`sessionProjectionCache`, zero-I/O reads) |
| **Hot reload** | Develop plugins with instant reload (no restart) |
| **Local-first** | Everything runs in one process, no network |

**Example**: Our `usage-insights` panel directly reads projection cache with **zero I/O**, aggregates tokens across sessions, and renders in sidebar—impossible with MCP.

---

### Claude Desktop Wins

| Use Case | Why Claude Desktop is Better |
|---|---|
| **External integrations** | Connect to GitHub, Slack, databases via standard protocol |
| **Language-agnostic** | Write servers in any language (Python, Rust, Go) |
| **Process isolation** | One buggy server won't crash the UI |
| **Standard protocol** | MCP works across Cursor, Windsurf, 200+ tools |
| **Ease of use** | One-click install, auto-update, curated directory |

**Example**: A Python-based database MCP server can serve both Claude Desktop and Cursor simultaneously—write once, use everywhere.

---

## 5. Ecosystem & Community

### DSH Ecosystem (Oct 2026)

- **Age**: 2 months since dev preview (Aug 13, 2026)
- **Size**: ~1000s plugins across multiple directories:
  - [awesome-deepseek-harness](https://github.com/vvlife/awesome-deepseek-harness-plugins)
  - [DSH Plugin Store](https://dshpluginstore.com/)
  - [dshmarketplace.dev](https://dshmarketplace.dev/)
- **Quality**: Mixed—some high-quality (like this project), many untested
- **Discovery**: Multiple competing plugin directories, no official curated list

**Pain points**:
- No official verification system (community-driven L1-L5 levels)
- Many plugins assume knowledge of internal APIs
- Breaking changes likely as DSH matures (0.2.0-rc.2 still in RC)

---

### Claude Desktop Ecosystem (Oct 2026)

- **Age**: 18 months since MCP launch (Nov 2024)
- **Size**: 2300+ public MCP servers
- **Quality**: Generally higher (protocol contract enforces structure)
- **Discovery**: Official directory at [claude.com/mcp-servers](https://www.anthropic.com/engineering/desktop-extensions)

**Advantages**:
- Anthropic-maintained SDK and docs
- MCP donated to Linux Foundation (Dec 2025)—vendor-neutral
- Protocol adoption across competitors (Cursor, Windsurf, etc.)

---

## 6. Performance Considerations

| Metric | DSH Plugin (in-process) | MCP Server (out-of-process) |
|---|---|---|
| **Latency** | <1ms (direct function call) | 5-20ms (stdio IPC) |
| **Memory** | Shared heap (efficient) | Separate process (overhead) |
| **Crash isolation** | ❌ Can crash profile | ✅ Process isolated |
| **Language** | JavaScript only | Any language |
| **Hot reload** | ✅ Instant | ❌ Need restart |

**Rule of thumb**:
- **DSH plugin** for: high-frequency calls (e.g., UI rendering), deep integration, zero-latency needs
- **MCP server** for: external APIs, long-running operations, non-JavaScript tools

---

## 7. Security Model

### DSH Plugins

- Run with **full Node.js permissions** (file system, network, child processes)
- No sandboxing between plugins (they share `ctx`)
- User approval required for tool calls, but plugins themselves are trusted
- **Risk**: Malicious plugin can read all sessions, exfiltrate data

**Mitigation**: Code review, community verification (L1-L5), static analysis ([dsh-devkit](../packages/devkit))

---

### Claude Desktop MCP Servers

- Run as **separate processes** with own permissions
- Can restrict via OS-level controls (e.g., Docker, chroot)
- Stdio transport means servers can't make outbound network calls unless explicitly allowed
- **Risk**: Malicious server can still access what it's given (e.g., GITHUB_TOKEN env var)

**Mitigation**: Official curation, one-click install only from trusted sources

---

## 8. Which to Choose?

### Choose DSH if you need:

- ✅ Custom UI panels or sidebar modifications
- ✅ Deep integration with session/model internals
- ✅ Hot-reload development experience
- ✅ Zero-latency, high-frequency operations
- ✅ Full control over the stack (replace any component)

**Trade-offs**: Steeper learning curve, fragility, documentation gaps

---

### Choose Claude Desktop (MCP) if you need:

- ✅ External integrations (GitHub, Slack, databases)
- ✅ Language-agnostic development (Python, Rust, Go)
- ✅ Process isolation and stability
- ✅ Write once, use across multiple AI tools (Cursor, Windsurf)
- ✅ Low learning curve with excellent docs

**Trade-offs**: Can't modify core UI, IPC latency, limited to protocol features

---

## 9. Can They Coexist?

**Yes!** In fact, DSH has **built-in MCP support**:

```yaml
# DSH can consume MCP servers
- id: mcp-client
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    servers:
      github:
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
```

**Hybrid strategy**:
1. Use **DSH plugins** for UI panels, session integration, cost tracking (like our project)
2. Use **MCP servers** for external APIs, databases, third-party tools
3. Best of both worlds: deep local integration + standard external protocol

---

## 10. Future Outlook

### DSH Trajectory

- **Short term (6mo)**: Stabilize plugin API, ship official `.d.ts`, improve docs
- **Medium term (1y)**: Official plugin marketplace, verification system
- **Risk**: If DSH adoption stays niche, ecosystem may stagnate

### MCP Trajectory

- **Short term (6mo)**: More official servers, IDE integrations
- **Medium term (1y)**: MCP 2.0 with UI extension support (competing with DSH's strength)
- **Opportunity**: If MCP adds UI panels, DSH's main differentiator weakens

---

## Conclusion

DSH and Claude Desktop represent two philosophies:

- **DSH**: Maximalist—everything is a plugin, infinite flexibility, steeper curve
- **Claude Desktop**: Minimalist—core is fixed, extensions via protocol, easier adoption

For **this project** (dsh-desktop-plugins):
- `usage-insights` **requires** DSH's architecture (sidebar panel, zero-I/O cache access)
- `session-search` **could** be an MCP server, but DSH native is more efficient
- `devkit` is DSH-specific by nature

**Our roadmap** (Phase 3) will support **both**:
- Keep DSH plugins for deep integration users
- Offer MCP adapters for cross-platform reach

---

## References

- DSH official: [deepseek.com/harness](https://www.deepseek.com) (hypothetical)
- MCP spec: [spec.modelcontextprotocol.io](https://spec.modelcontextprotocol.io)
- MCP servers: [modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers)
- Cordis docs: [cordis.js.org](https://cordis.js.org)
- This project: [github.com/shidesheng0218/dsh-desktop-lab](https://github.com/shidesheng0218/dsh-desktop-lab)
