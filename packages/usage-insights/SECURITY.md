# Security Policy

## Data Privacy

**usage-insights** is designed with privacy as a core principle:

### What Data is Accessed

This plugin reads:
- Session projection cache: `~/.dsh/storages/session_projcache/sessions/*.json`
- Session headers from `ctx.sessionQuery.listSessions()`

### What Data is NOT Collected

- ❌ No data is uploaded to any external server
- ❌ No network requests are made (except to serve the local UI panel)
- ❌ No session content or conversation history is read
- ❌ No personally identifiable information is accessed

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

This plugin works completely offline:
- No internet connection required
- No external dependencies at runtime
- All calculations use local data only

### Export Security

When exporting data (CSV/JSON):
- Files are written to the location you specify (CLI) or downloaded by your browser (HTTP)
- CSV export includes formula injection protection (leading `=` `+` `@` are escaped)
- No data is sent to external services during export

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
1. Running static checks: `node packages/devkit/bin/dsh-devkit.mjs check packages/usage-insights`
2. Reading the source code (only ~2000 lines, well-documented)
3. Running tests: `npm test` (81 test cases including export validation)
4. Inspecting network traffic (should see zero external requests)

## Known Limitations

- **Pricing data is user-provided**: No built-in price table to prevent accidentally using outdated/incorrect rates
- **Checkpoint delay**: Data is as recent as the last checkpoint (official write-behind is 200 events / 5 seconds)
- **Single-rate costing**: All tokens use one price table (projection cache lacks model/route dimensions)

These are design constraints from the official DeepSeek Harness architecture, not security issues.
