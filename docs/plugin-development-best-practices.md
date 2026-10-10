# Plugin Development Best Practices: Lessons from dsh-desktop-plugins

This guide distills lessons from building three DeepSeek Harness plugins: **devkit** (toolchain), **usage-insights** (UI panel), and **session-search** (Host-only tool).

---

## Table of Contents

1. [Architecture Principles](#1-architecture-principles)
2. [Testing Strategy](#2-testing-strategy)
3. [Common Pitfalls](#3-common-pitfalls)
4. [Performance Optimization](#4-performance-optimization)
5. [Internationalization](#5-internationalization)
6. [Security](#6-security)
7. [Documentation](#7-documentation)

---

## 1. Architecture Principles

### Principle 1: Pure Logic Core

**Bad** (tangled dependencies):
```javascript
// index.js - everything in one place
export function apply(ctx) {
  const sessions = await ctx.sessionQuery.listSessions()
  const totals = { tokens: 0 }
  for (const s of sessions) {
    const cache = ctx.sessionProjectionCache.cachedSnapshot(s.header, ['tokenUsage'])
    totals.tokens += cache?.values?.tokenUsage?.totals?.outputTokens ?? 0
  }
  return totals
}
```

**Problems**:
- Can't unit test without mocking `ctx`
- Can't reuse logic in CLI
- Hard to verify edge cases (missing cache, null values)

---

**Good** (pure core):
```javascript
// lib/core.js - pure logic, zero DSH dependencies
export function normalizeSession(entry) {
  const totals = entry?.values?.tokenUsage?.totals ?? {}
  return {
    tokens: {
      uncachedInputTokens: totals.uncachedInputTokens || 0,
      outputTokens: totals.outputTokens || 0,
    }
  }
}

export function aggregate(sessions) {
  const totals = { tokens: 0 }
  for (const s of sessions) {
    totals.tokens += s.tokens.outputTokens
  }
  return totals
}

// index.js - thin wrapper
export function apply(ctx) {
  const sessions = await ctx.sessionQuery.listSessions()
  const normalized = sessions.map(s => ({
    values: ctx.sessionProjectionCache.cachedSnapshot(s.header, ['tokenUsage'])?.values ?? {}
  }))
  return aggregate(normalized.map(normalizeSession))
}
```

**Benefits**:
- ✅ Test `normalize()` and `aggregate()` with plain objects
- ✅ Reuse in CLI (no `ctx` needed)
- ✅ Easy to verify edge cases

**Our evidence**: `lib/core.js` is 100% covered by tests using plain fixtures, no mocks.

---

### Principle 2: Contract-Based Integration

**Problem**: Panel shows one number, CSV export shows another (they diverge over time).

**Solution**: Single source of truth
```javascript
// lib/report.js
export function buildReport(sessions, config) {
  const totals = aggregate(sessions)
  return {
    schemaVersion: 1,
    totals,
    byDay: groupByDay(sessions),
    topSessions: selectTop(sessions, config.topN),
  }
}

// index.js (Host)
app.get('/api/usage-insights', async (req) => {
  const sessions = await collectSessions(ctx)
  const report = buildReport(sessions, config)
  return res.json(report)
})

// client.js (UI)
fetch('/api/usage-insights').then(r => r.json()).then(report => {
  renderPanel(report.totals)
})

// export.js
export function toCsv(report, table) {
  if (table === 'summary') return formatRow(report.totals)
  // ...
}
```

**Key**: Panel, API, and CSV all consume the **same** `buildReport()` output.

**Enforced by**: Contract tests that freeze JSON keys (`packages/usage-insights/test/contract.test.mjs`).

---

### Principle 3: Fail Loudly, Not Silently

**Bad** (silent fallback):
```javascript
export function toCsv(report, table) {
  if (table === 'sessions') {
    return report.sessions ? format(report.sessions) : format(report.topSessions)
    // ↑ DANGER: topSessions is only 10 rows, looks like full export but isn't
  }
}
```

**Good** (explicit error):
```javascript
export function toCsv(report, table) {
  if (table === 'sessions') {
    if (!report.sessions) {
      throw new Error('sessions 表需要 includeSessions=true，否则只有 topSessions (默认 10 条)')
    }
    return format(report.sessions)
  }
}
```

**Why**: A silent truncation is worse than a loud failure. User gets "complete" data that's actually 10/1000 rows.

**Our enforcement**: `contract.test.mjs` verifies `toCsv(report, 'sessions')` throws when `report.sessions` is absent.

---

## 2. Testing Strategy

### Strategy 1: Fixture-Driven Tests

**Bad** (mock everything):
```javascript
test('aggregation works', async () => {
  const mockCtx = {
    sessionQuery: { listSessions: sinon.stub().resolves([...]) },
    sessionProjectionCache: { cachedSnapshot: sinon.stub().returns(...) },
  }
  const result = await apply(mockCtx)
  assert.equal(result.tokens, 1000)
})
```

**Problems**:
- Mocks are verbose
- If official API changes shape, mocks don't reflect it
- Hard to maintain

---

**Good** (real data shapes):
```javascript
test('normalizeSession handles missing cache', () => {
  const entry = {
    header: { id: 's1', createdAt: 1234567890 },
    values: {}  // No tokenUsage (cache miss)
  }
  const result = normalizeSession(entry)
  assert.equal(result.tokens.outputTokens, 0)  // Should default to 0, not crash
})
```

**Why**: Fixtures capture real data shapes. When official projection cache changes, tests reflect reality.

**Our fixtures**: Copied from `~/.dsh/storages/session_projcache/sessions/*.json` (real data).

---

### Strategy 2: Mutation Testing

See [Why Mutation Testing](./why-mutation-testing.md) for details.

**Quick summary**: Inject 31 bugs, verify tests catch them all → proves tests aren't just passing by luck.

**Recommended frequency**: Once per major feature, or before v1.0 release.

---

### Strategy 3: Contract Tests

**Purpose**: Prevent accidental breaking changes to exports/APIs.

```javascript
// contract.test.mjs
test('JSON 键集冻结', () => {
  const report = buildReport(fixtures.sessions, { window: '7d' })
  const keys = Object.keys(report)
  assert.deepEqual(keys.sort(), [
    'schemaVersion', 'generatedAt', 'window', 'totals', 'cost',
    'byWorkspace', 'byDay', 'topSessions', 'coverage'
  ].sort())
  // If you add a key, this test fails → intentional (update schemaVersion)
})
```

**Enforce**: Semantic versioning (`schemaVersion` in reports).

---

### Strategy 4: Cross-Validation

**Purpose**: Ensure Host path and CLI path produce identical results.

```javascript
test('Host 与 CLI 交叉验证', async () => {
  // Host path
  const hostReport = await collectAndBuild(mockCtx, config)
  
  // CLI path (reads same cache files)
  const cliReport = buildReportFromDisk(config)
  
  assert.deepEqual(hostReport.totals, cliReport.totals)
})
```

**Why**: If they diverge, one is wrong. This test catches it immediately.

---

## 3. Common Pitfalls

### Pitfall 1: Client Bundle Importing DSH Client Packages

**Forbidden**:
```javascript
// client.js
import { Button } from '@deepseek-ai/dsh-client-ui-components'  // ❌ ERROR
```

**Official rule**: Client bundles must use `window.__ModuleLoader__.require()` for shared dependencies.

**Why**: Bundling your own copy of React/etc. causes version conflicts.

**Correct**:
```javascript
// client.js
const React = window.__ModuleLoader__.require('react')
const { Button } = window.__ModuleLoader__.require('@deepseek-ai/dsh-client-ui-components')
```

**Our check**: `devkit` has rule `client.forbidden-require` that fails if you `require('@deepseek-ai/dsh-client-*')`.

---

### Pitfall 2: Hardcoded CJK Text Without Locale

**Bad**:
```javascript
// client.js
return <div>正在加载...</div>
```

**Problem**: English UI shows Chinese (jarring UX).

**Good**:
```javascript
// client.js
const t = (key) => ctx.locale.translate('usage-insights', key)
return <div>{t('loading')}</div>

// At registration
ctx.locale.register('usage-insights', {
  zh: { loading: '正在加载...' },
  en: { loading: 'Loading...' },
})
```

**Our check**: `devkit` rule `client.hardcoded-copy` finds CJK literals without `locale.register()` call.

---

### Pitfall 3: Locale Keys Mismatch

**Bad**:
```javascript
ctx.locale.register('usage-insights', {
  zh: { loading: '加载中', error: '出错了' },
  en: { loading: 'Loading' },  // Missing 'error'
})
```

**Problem**: English UI crashes when error occurs (key not found).

**Good**: Ensure key sets match
```javascript
test('locale 键集一致', () => {
  const zh = dict.zh
  const en = dict.en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})
```

**Our enforcement**: `client.test.mjs` has this check.

---

### Pitfall 4: YAML Patch with Tab Indentation

**Bad**:
```yaml
# cordis.patch.yml
- insert:
→   - id: usage-insights  # Tab character (→)
```

**Problem**: YAML spec forbids tabs as indentation. Loader crashes.

**Good**: Use spaces
```yaml
- insert:
  - id: usage-insights  # Two spaces
```

**Our check**: `devkit` rule `patch.tab-indent` fails if tabs found.

---

### Pitfall 5: Factory ID ≠ Package Name

**Bad**:
```javascript
// package.json
{ "name": "@local/dsh-usage-insights" }

// client.js
window.__ModuleLoader__.load({
  id: 'usage-insights',  // ❌ WRONG
  factory: () => { ... }
})
```

**Problem**: Loader can't resolve module.

**Good**: Match exactly
```javascript
window.__ModuleLoader__.load({
  id: '@local/dsh-usage-insights',  // ✅ Matches package.json
  factory: () => { ... }
})
```

**Our check**: `devkit` rule `client.id-mismatch`.

---

## 4. Performance Optimization

### Optimization 1: Zero-I/O Data Access

**Problem**: Reading session logs from disk is slow (multi-frame zstd, tens of MB).

**Solution**: Use projection cache
```javascript
// Bad (reads disk)
const events = await ctx.sessionQuery.filterEvents(sessionId, () => true)
const tokens = events.reduce((sum, e) => sum + (e.tokens || 0), 0)

// Good (zero I/O)
const snapshot = ctx.sessionProjectionCache.cachedSnapshot(header, ['tokenUsage'])
const tokens = snapshot?.values?.tokenUsage?.totals?.outputTokens ?? 0
```

**Trade-off**: Data is "as recent as last checkpoint" (5s lag), but **never wrong**.

**Our usage**: `usage-insights` is zero-I/O (critical for UI responsiveness).

---

### Optimization 2: Candidate Capping

**Problem**: Tool searches all 500 sessions → 30-second timeout.

**Solution**: Explicit limits
```javascript
export const LIMITS = {
  MAX_CANDIDATE_SESSIONS: 40,   // Scan at most 40 sessions
  MAX_HITS_PER_SESSION: 5,       // Return at most 5 hits per session
  MAX_HITS: 50,                   // Total hits capped at 50
}

export function selectCandidates(headers, options) {
  const sorted = headers.sort((a, b) => b.createdAt - a.createdAt)
  return {
    candidates: sorted.slice(0, options.max ?? LIMITS.MAX_CANDIDATE_SESSIONS),
    truncated: sorted.length > options.max,
  }
}
```

**Key**: Return `truncated: true` in `notes` so model knows results are partial.

**Our usage**: `session-search` defaults to 40 sessions (configurable).

---

### Optimization 3: Lazy Evaluation

**Bad** (always compute everything):
```javascript
export function buildReport(sessions, config) {
  return {
    totals: aggregate(sessions),
    byDay: groupByDay(sessions),
    byWorkspace: groupByWorkspace(sessions),
    sessions: sessions,  // Always include (10MB+)
  }
}
```

**Good** (conditional inclusion):
```javascript
export function buildReport(sessions, config) {
  const report = {
    totals: aggregate(sessions),
    byDay: groupByDay(sessions),
    topSessions: selectTop(sessions, config.topN),
  }
  if (config.includeSessions) {
    report.sessions = sessions  // Only when explicitly requested
  }
  return report
}
```

**Why**: Panel doesn't need full session list (only top 10). Save 90% memory.

---

## 5. Internationalization

### Best Practice 1: Namespace Isolation

```javascript
// Good: each plugin has its own namespace
ctx.locale.register('usage-insights', { zh, en })
ctx.locale.register('session-search', { zh, en })

// Usage
const t = (key) => ctx.locale.translate('usage-insights', key)
```

**Why**: Prevents key collisions between plugins.

---

### Best Practice 2: Fallback Chain

```javascript
// Official behavior: zh-CN → zh → en
// Your plugin MUST provide 'en' as final fallback

ctx.locale.register('usage-insights', {
  zh: { title: '用量与成本' },
  en: { title: 'Usage & Cost' },  // Required
})
```

**Do NOT**:
```javascript
// Bad: no English
ctx.locale.register('usage-insights', {
  zh: { title: '用量与成本' },
  // Missing 'en' → English users see key name 'title'
})
```

---

### Best Practice 3: Test Both Languages

```javascript
test('English 无中文', () => {
  const html = renderToStaticMarkup(<Panel locale="en" data={mockData} />)
  // No CJK characters should appear
  assert(!/[一-鿿぀-ゟ゠-ヿ]/.test(html))
})

test('键集一致', () => {
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort())
})
```

**Why**: Catches missing translations before users see them.

---

## 6. Security

### Guideline 1: CSV Formula Injection Protection

**Danger**:
```csv
Session,Title
s1,=cmd|'/c calc'|!A1
```

**Problem**: Excel executes formula, launches calculator (or worse).

**Solution**: Escape leading special chars
```javascript
export function escapeCell(value) {
  const str = String(value ?? '')
  // Escape =, +, @, tab, carriage return
  if (/^[=+@\t\r]/.test(str)) {
    return `'${str}`  // Prefix with single quote
  }
  // Don't escape negative numbers (-42 is fine)
  if (/^-[0-9]/.test(str) && !isNaN(parseFloat(str))) {
    return str
  }
  if (/^-/.test(str)) {
    return `'${str}`  // Other leading dash: escape
  }
  return str
}
```

**Test**:
```javascript
test('公式注入防护', () => {
  assert.equal(escapeCell('=SUM(A1:A10)'), "'=SUM(A1:A10)")
  assert.equal(escapeCell('-42'), '-42')  // Not escaped
  assert.equal(escapeCell('-abc'), "'-abc")  // Escaped
})
```

---

### Guideline 2: Read-Only Operations

**Principle**: Plugin should **never modify** session data unless explicitly designed to.

```javascript
// Good: read-only
const snapshot = ctx.sessionProjectionCache.cachedSnapshot(header, keys)

// Bad: modifying (unless intentional)
await ctx.sessionQuery.updateSession(sessionId, { title: 'new' })
```

**Document in SECURITY.md**: "This plugin performs zero write operations."

---

### Guideline 3: No Network Calls (Unless Necessary)

```javascript
// Bad: phones home
fetch('https://analytics.example.com/track', { method: 'POST', body: usage })

// Good: all local
const report = buildReport(sessions, config)
```

**Exception**: If your plugin **needs** network (e.g., GitHub integration), document it clearly.

---

## 7. Documentation

### Documentation Principle 1: Honest Limitations

**Bad** (overpromise):
> "This plugin tracks usage across all models and providers."

**Good** (accurate):
> "This plugin tracks DSH desktop usage. Limitations:
> - Data is as recent as last checkpoint (5s lag)
> - Costs use single price table (no per-model pricing in v0.1)
> - Time window filters by session creation, not last activity"

**Our example**: README has entire section "已知限制" (Known Limitations).

---

### Documentation Principle 2: Verification Status

**Bad** (assume it works):
> "Install the plugin and it will work."

**Good** (transparent status):
> "Verification status (v0.1.0):
> - ✅ Unit tests: 81 cases pass
> - ✅ Mutation tests: 23 bugs caught
> - ❌ Real GUI install: Not yet verified
> - ❌ Performance on 500+ sessions: Unknown"

**Our example**: README section "验证状态" lists what's verified and what's not.

---

### Documentation Principle 3: Runnable Examples

**Bad** (pseudocode):
```markdown
Install the plugin, then configure pricing.
```

**Good** (copy-paste ready):
```markdown
## Install

1. Run static check:
   ```bash
   node packages/devkit/bin/dsh-devkit.mjs check packages/usage-insights
   ```

2. Get install path:
   ```bash
   node packages/devkit/bin/dsh-devkit.mjs install packages/usage-insights
   ```

3. In DSH GUI: Plugins → Add plugin → paste path → Install → Enable
```

**Our example**: README has step-by-step install with exact commands.

---

## Summary: The Golden Rules

1. **Pure logic core** → easy to test, reusable
2. **Single source of truth** → panel/API/export never diverge
3. **Fail loudly** → silent truncation is worse than error
4. **Fixture-driven tests** → use real data shapes
5. **Mutation testing** → prove tests catch bugs
6. **Contract tests** → freeze public APIs
7. **Zero-I/O when possible** → use projection cache
8. **Explicit limits** → cap candidates, hits, memory
9. **Namespace locales** → avoid key collisions
10. **Test both languages** → catch missing translations
11. **CSV formula protection** → don't let Excel execute code
12. **Document honestly** → list limitations, verification status

---

## Tools We Built

- **devkit**: 16 static checks to catch these pitfalls before install
- Run: `node packages/devkit/bin/dsh-devkit.mjs check <plugin-dir>`
- Catches: forbidden imports, hardcoded CJK, YAML tabs, ID mismatches, etc.

---

## Further Reading

- [DSH vs Claude Desktop](./dsh-vs-claude-desktop.md) - Architecture comparison
- [Local vs Cloud Cost Tracking](./local-vs-cloud-cost-tracking.md) - When to use which
- [Why Mutation Testing](./why-mutation-testing.md) - Our 31-bug campaign
- [Official gaps audit](./official-gaps.md) - What's missing in DSH

---

**Contribute**: Found another pitfall? Open an issue or PR!

GitHub: https://github.com/shidesheng0218/dsh-desktop-lab
