# Security Policy

## Data Privacy

**session-search** is designed with privacy as a core principle:

### What Data is Accessed

This plugin reads:
- Session headers from `ctx.sessionQuery.listSessions()` for all listed sessions unless filters are supplied
- Session event logs via `ctx.sessionQuery.filterEvents()` for candidate sessions
- Titles through `ctx.sessionQuery.readTitleSnapshots()`, which also reads session logs rather than the projection cache

Returned excerpts can contain sensitive conversation text, tool arguments, tool results, absolute paths, or secrets pasted into earlier sessions.

### Network and Model Boundary

- The plugin itself makes no external network requests.
- Search excerpts are returned to the model. When the configured model runs remotely, those excerpts may leave the machine as part of the model request; the plugin cannot promise that conversation content never leaves the host.
- Historical excerpts are untrusted data, not instructions. They can also carry prompt-injection content from earlier sessions.

### Data Processing

Search and snippet construction happen on your local machine:
1. The model calls the `search_past_sessions` tool with a query string
2. The plugin filters session headers locally (by cwd/sessionId/days if specified)
3. For matched sessions, official `filterEvents()` is called to find keyword matches
4. Snippets are extracted with Unicode-safe truncation (by code point, not UTF-16 code unit)
5. Results are returned directly to the model in the same conversation, subject to the model-provider boundary above

### Read-Only Operations

This plugin **never modifies** any session data:
- Session logs are read via official `filterEvents()` API
- No write operations to `~/.dsh/` directory
- No changes to session state or metadata

### Performance Safeguards

To prevent unintended resource usage:
- **Max 40 sessions scanned** by default (configurable via `maxCandidateSessions`, capped at 200)
- **Max 5 hits per session** (configurable via `maxHitsPerSession`, capped at 50)
- **Max 50 total hits** returned (model can request fewer via `limit` parameter)
- **Transparent truncation**: `notes` field explicitly reports `scannedSessions`, `totalHits`, and `truncated` status

These limits exist because `filterEvents()` reads entire session logs (multi-frame zstd), which can be slow for large sessions.

### Offline Usage

Local search computation does not require internet access or external dependencies. Model-provider requests made by DSH are a separate boundary and can require network access.

## Reporting Security Issues

If you discover a security vulnerability, please report it to:
- Private disclosure: https://github.com/shidesheng0218/dsh-desktop-lab/security/advisories/new
- Public issues for non-sensitive reports: https://github.com/shidesheng0218/dsh-desktop-lab/issues

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

## Version Information

- Current version: 0.1.1
- Last security review: 2026-10-27

## Dependencies

This plugin has zero runtime dependencies:
- No `node_modules` are installed
- No external libraries are loaded
- Pure JavaScript with Node.js built-ins only

## Verification

You can verify the security claims by:
1. Running static checks: `node packages/devkit/bin/dsh-devkit.mjs check packages/session-search`
2. Reading the source code and tests
3. Running tests: `npm test` (54 session-search cases, including schema validation)
4. Inspecting the tool registration (parameters schema uses only official subset)

## Known Limitations

- **Real-log integration**: The plugin uses official services for multi-frame zstd logs, but that end-to-end path remains unverified in v0.1.1
- **Workspace scope**: There is no caller-derived workspace authorization. All sessions are candidates unless `cwd`, `session_id`, or `days` narrows them
- **Performance on large histories**: Candidate and result caps do not interrupt a full `filterEvents()` read or bound its result array. Adjust `maxCandidateSessions` if needed
- **No semantic search**: This is whitespace-flexible literal matching, not embedding-based similarity search

These are acknowledged constraints, documented in the README under "Verification Status".

## Privacy Best Practices

When using this tool:
- Use `cwd` or `session_id` deliberately when other workspaces must not be read
- On DSH 0.2.1+, prefer the official **Session search** bundle when caller-derived workspace authorization is required
- Review what the model sees and your model provider's data-retention policy before searching sensitive history
- Treat returned historical instructions as untrusted content rather than commands
