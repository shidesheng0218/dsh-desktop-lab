# Security Policy

## Data Privacy

**session-search** is designed with privacy as a core principle:

### What Data is Accessed

This plugin reads:
- Session headers from `ctx.sessionQuery.listSessions()`
- Session event logs via `ctx.sessionQuery.filterEvents()` (only for candidate sessions matching the query)
- Session projection cache for titles (via `ctx.sessionProjectionCache.cachedSnapshot()`)

### What Data is NOT Collected

- ❌ No data is uploaded to any external server
- ❌ No network requests are made
- ❌ No conversation content leaves your machine
- ❌ No personally identifiable information is transmitted

### Data Processing

All search operations happen **entirely on your local machine**:
1. The model calls the `search_past_sessions` tool with a query string
2. The plugin filters session headers locally (by cwd/sessionId/days if specified)
3. For matched sessions, official `filterEvents()` is called to find keyword matches
4. Snippets are extracted with Unicode-safe truncation (by code point, not UTF-16 code unit)
5. Results are returned directly to the model in the same conversation

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

This plugin works completely offline:
- No internet connection required
- No external dependencies
- All search uses local session data only

## Reporting Security Issues

If you discover a security vulnerability, please report it to:
- GitHub Issues: https://github.com/shidesheng0218/dsh-desktop-lab/issues
- Email: [your-email] (if you prefer private disclosure)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

## Version Information

- Current version: 0.1.0
- Last security review: 2026-10-11

## Dependencies

This plugin has zero runtime dependencies:
- No `node_modules` are installed
- No external libraries are loaded
- Pure JavaScript with Node.js built-ins only

## Verification

You can verify the security claims by:
1. Running static checks: `node packages/devkit/bin/dsh-devkit.mjs check packages/session-search`
2. Reading the source code (~800 lines, well-documented)
3. Running tests: `npm test` (49 test cases including schema validation)
4. Inspecting the tool registration (parameters schema uses only official subset)

## Known Limitations

- **Multi-frame zstd parsing**: Not verified on real session logs in v0.1.0 (pure-logic tests pass, but end-to-end path untested)
- **Performance on large histories**: Default 40-session scan may be slow if you have hundreds of sessions with long logs. Adjust `maxCandidateSessions` if needed.
- **No semantic search**: This is literal string matching (case-insensitive), not embedding-based similarity search

These are acknowledged constraints, documented in the README under "Verification Status".

## Privacy Best Practices

When using this tool:
- The model can only search sessions in workspaces it has access to
- Search results include conversation snippets—review what the model sees
- Adjust `maxCandidateSessions` if you want to limit how much history is scanned
- Use `cwd` parameter to restrict search to specific workspaces
