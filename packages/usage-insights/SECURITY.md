# Security Policy

## Data Privacy

**usage-insights** is designed with privacy as a core principle:

### What Data is Accessed

This plugin reads:
- Session headers from `ctx.sessionQuery.listSessions()`, including session IDs, creation times, and workspace paths
- Titles, token usage, session statistics, and context pressure through the Host projection-cache service
- `~/.dsh/storages/session_projcache/sessions/*.json` directly only when the standalone CLI is used

It does **not** read conversation message bodies. Session titles, session IDs, and absolute workspace paths can nevertheless be sensitive metadata and are included in relevant reports.

### Network and Export Boundary

- The plugin does not intentionally upload report data to external services.
- Its HTTP route serves the local UI through the DSH connection layer; exposure and authentication are owned by that host layer.
- JSON/CSV export happens only when requested through the API or CLI.
- The plugin registers no model-facing tool and does not itself send data to a model provider.

### Data Processing

All token aggregation and cost calculations happen **entirely on your local machine**:
1. The Host plugin reads projection cache via DeepSeek Harness's built-in services
2. Pure JavaScript functions in `lib/core.js` aggregate the data (zero I/O, zero imports of DSH packages)
3. Results are served via local HTTP endpoint `/api/usage-insights`
4. The Client panel fetches from this local endpoint and renders in your browser

### Read-Only Operations

This plugin **never modifies** any session data:
- Session logs remain untouched
- Projection cache is read synchronously via `cachedSnapshot()` (zero I/O)
- No write operations to `~/.dsh/` directory

### Offline Usage

Aggregation and export require no internet connection:
- No external runtime dependencies
- All calculations use local data
- Other DSH functionality, including model calls, is outside this plugin's offline claim

### Export Security

When exporting data (CSV/JSON):
- Files are written to the location you specify (CLI) or downloaded by your browser (HTTP)
- CSV export includes formula injection protection
- No data is intentionally sent to external services during export

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
1. Running static checks: `node packages/devkit/bin/dsh-devkit.mjs check packages/usage-insights`
2. Reading the source code and tests
3. Running tests: `npm test` (86 usage-insights cases, including export validation)
4. Inspecting network traffic for plugin-initiated external requests

## Known Limitations

- **Pricing data is user-provided**: No built-in price table to prevent accidentally using outdated/incorrect rates
- **Checkpoint delay**: Data is as recent as the last checkpoint (official write-behind is 200 events / 5 seconds)
- **Single-rate costing**: All tokens use one price table (projection cache lacks model/route dimensions)

These are design constraints from the official DeepSeek Harness architecture, not security issues.
