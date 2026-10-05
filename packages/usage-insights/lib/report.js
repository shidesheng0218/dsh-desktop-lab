/**
 * 报告构建：CLI 与 Host 半边共用的唯一实现。
 *
 * 为什么要把这段从两个调用点抽出来：导出契约一旦被外部工具消费，
 * 「CLI 算出来的数」与「插件面板显示的数」必须是同一套代码算的，
 * 否则两者会以最难查的方式漂移（同一份数据、两个数字）。
 *
 * 对外契约见 `docs/report-schema.md`。改动顶层或各表字段集必须先升
 * `SCHEMA_VERSION`，`test/contract.test.mjs` 会冻结键集并拦住无意的变更。
 */
import { aggregate, filterByWindow, normalizeSession } from './core.js';

/** 对外报告 schema 的版本号。字段集变更必须递增。 */
export const SCHEMA_VERSION = 1;

/**
 * 各导出表的列定义 —— JSON 的 `sessions` 与 CSV 的全部表都由这里派生，
 * 是「JSON 与 CSV 不会漂移」的唯一保证。
 *
 * `get(source)` 的 source 语义按表而定：
 *   summary   → 整个 report
 *   workspace → report.byWorkspace 的一项
 *   daily     → report.byDay 的一项
 *   sessions  → report.sessions 的一项（规范化后的会话）
 */
const TOKENS = {
  uncachedInput: (t) => t.tokens.uncachedInputTokens,
  cacheRead: (t) => t.tokens.cacheReadTokens,
  cacheWrite: (t) => t.tokens.cacheWriteTokens,
  output: (t) => t.tokens.outputTokens,
  total: (t) => t.tokens.total,
  cacheHitRate: (t) => t.tokens.cacheHitRate,
};

export const TABLES = Object.freeze({
  summary: {
    description: '一行总计',
    columns: [
      { key: 'schemaVersion', header: 'schema_version', get: (r) => r.schemaVersion },
      { key: 'generatedAt', header: 'generated_at', get: (r) => r.generatedAt },
      { key: 'window', header: 'window', get: (r) => r.window.kind },
      { key: 'currency', header: 'currency', get: (r) => r.currency },
      { key: 'sessions', header: 'sessions', get: (r) => r.totals.sessions },
      { key: 'sessionsWithUsage', header: 'sessions_with_usage', get: (r) => r.totals.sessionsWithUsage },
      { key: 'liveSessions', header: 'live_sessions', get: (r) => r.totals.liveSessions },
      { key: 'uncachedInputTokens', header: 'uncached_input_tokens', get: (r) => TOKENS.uncachedInput(r.totals) },
      { key: 'cacheReadTokens', header: 'cache_read_tokens', get: (r) => TOKENS.cacheRead(r.totals) },
      { key: 'cacheWriteTokens', header: 'cache_write_tokens', get: (r) => TOKENS.cacheWrite(r.totals) },
      { key: 'outputTokens', header: 'output_tokens', get: (r) => TOKENS.output(r.totals) },
      { key: 'totalTokens', header: 'total_tokens', get: (r) => TOKENS.total(r.totals) },
      { key: 'cacheHitRate', header: 'cache_hit_rate', get: (r) => TOKENS.cacheHitRate(r.totals) },
      { key: 'turns', header: 'turns', get: (r) => r.totals.stats.turns },
      { key: 'steps', header: 'steps', get: (r) => r.totals.stats.steps },
      { key: 'llmMs', header: 'llm_ms', get: (r) => r.totals.stats.llmMs },
      { key: 'toolMs', header: 'tool_ms', get: (r) => r.totals.stats.toolMs },
      { key: 'costAvailable', header: 'cost_available', get: (r) => r.cost.available },
      { key: 'costAmount', header: 'cost_amount', get: (r) => (r.cost.available ? r.cost.amount : '') },
      { key: 'costBasis', header: 'cost_basis', get: (r) => (r.cost.available ? r.cost.basis : '') },
      { key: 'listedSessions', header: 'listed_sessions', get: (r) => r.coverage.listed },
      { key: 'sessionsInWindow', header: 'sessions_in_window', get: (r) => r.coverage.inWindow },
      {
        key: 'withoutCacheRecord',
        header: 'without_cache_record',
        get: (r) => r.coverage.withoutCacheRecord ?? '',
      },
    ],
  },

  workspace: {
    description: '按工作区一行',
    columns: [
      { key: 'cwd', header: 'cwd', get: (w) => w.cwd ?? '' },
      { key: 'label', header: 'workspace', get: (w) => w.label },
      { key: 'sessions', header: 'sessions', get: (w) => w.sessions },
      { key: 'uncachedInputTokens', header: 'uncached_input_tokens', get: (w) => TOKENS.uncachedInput(w) },
      { key: 'cacheReadTokens', header: 'cache_read_tokens', get: (w) => TOKENS.cacheRead(w) },
      { key: 'cacheWriteTokens', header: 'cache_write_tokens', get: (w) => TOKENS.cacheWrite(w) },
      { key: 'outputTokens', header: 'output_tokens', get: (w) => TOKENS.output(w) },
      { key: 'totalTokens', header: 'total_tokens', get: (w) => TOKENS.total(w) },
      { key: 'cacheHitRate', header: 'cache_hit_rate', get: (w) => TOKENS.cacheHitRate(w) },
      { key: 'turns', header: 'turns', get: (w) => w.stats.turns },
      { key: 'llmMs', header: 'llm_ms', get: (w) => w.stats.llmMs },
      { key: 'toolMs', header: 'tool_ms', get: (w) => w.stats.toolMs },
      { key: 'cost', header: 'cost', get: (w) => (w.cost === null || w.cost === undefined ? '' : w.cost) },
    ],
  },

  daily: {
    description: '按本地日期一行',
    columns: [
      { key: 'day', header: 'day', get: (d) => d.day },
      { key: 'sessions', header: 'sessions', get: (d) => d.sessions },
      { key: 'uncachedInputTokens', header: 'uncached_input_tokens', get: (d) => TOKENS.uncachedInput(d) },
      { key: 'cacheReadTokens', header: 'cache_read_tokens', get: (d) => TOKENS.cacheRead(d) },
      { key: 'cacheWriteTokens', header: 'cache_write_tokens', get: (d) => TOKENS.cacheWrite(d) },
      { key: 'outputTokens', header: 'output_tokens', get: (d) => TOKENS.output(d) },
      { key: 'totalTokens', header: 'total_tokens', get: (d) => TOKENS.total(d) },
      { key: 'cacheHitRate', header: 'cache_hit_rate', get: (d) => TOKENS.cacheHitRate(d) },
    ],
  },

  sessions: {
    description: '按会话一行（最细粒度；需要 includeSessions）',
    columns: [
      { key: 'id', header: 'session_id', get: (s) => s.id },
      { key: 'title', header: 'title', get: (s) => s.title ?? '' },
      { key: 'cwd', header: 'cwd', get: (s) => s.cwd ?? '' },
      { key: 'workspace', header: 'workspace', get: (s) => s.workspaceLabel },
      { key: 'createdAt', header: 'created_at_ms', get: (s) => s.createdAt },
      { key: 'createdAtIso', header: 'created_at_iso', get: (s) => new Date(s.createdAt).toISOString() },
      { key: 'live', header: 'live', get: (s) => s.live },
      { key: 'hasUsage', header: 'has_usage', get: (s) => s.hasUsage },
      { key: 'uncachedInputTokens', header: 'uncached_input_tokens', get: (s) => TOKENS.uncachedInput(s) },
      { key: 'cacheReadTokens', header: 'cache_read_tokens', get: (s) => TOKENS.cacheRead(s) },
      { key: 'cacheWriteTokens', header: 'cache_write_tokens', get: (s) => TOKENS.cacheWrite(s) },
      { key: 'outputTokens', header: 'output_tokens', get: (s) => TOKENS.output(s) },
      { key: 'totalTokens', header: 'total_tokens', get: (s) => TOKENS.total(s) },
      { key: 'cacheHitRate', header: 'cache_hit_rate', get: (s) => TOKENS.cacheHitRate(s) },
      { key: 'turns', header: 'turns', get: (s) => s.stats.turns },
      { key: 'steps', header: 'steps', get: (s) => s.stats.steps },
      { key: 'llmMs', header: 'llm_ms', get: (s) => s.stats.llmMs },
      { key: 'toolMs', header: 'tool_ms', get: (s) => s.stats.toolMs },
      { key: 'decodeMs', header: 'decode_ms', get: (s) => s.stats.decodeMs },
      { key: 'surfaceTokens', header: 'surface_tokens', get: (s) => s.context.surfaceTokens },
      { key: 'contextWindow', header: 'context_window', get: (s) => s.context.contextWindow },
      { key: 'contextUsageRatio', header: 'context_usage_ratio', get: (s) => s.context.usageRatio ?? '' },
    ],
  },
});

export const TABLE_NAMES = Object.freeze(Object.keys(TABLES));

/**
 * 取一张表的行源数组。
 * @param {object} report buildReport 的返回值
 * @param {string} table 表名
 * @returns {unknown[]|null} 表不存在时返回 null
 */
export function tableRows(report, table) {
  switch (table) {
    case 'summary':
      return [report];
    case 'workspace':
      return report.byWorkspace;
    case 'daily':
      return report.byDay;
    case 'sessions':
      // 绝不静默截断：没有 includeSessions 就没有这张表，
      // 而不是拿 topSessions 冒充全量。
      return Array.isArray(report.sessions) ? report.sessions : null;
    default:
      return null;
  }
}

/**
 * 把一组已规范化的会话折叠成对外报告。
 * @param {ReturnType<typeof normalizeSession>[]} sessions 已 normalizeSession 的会话
 * @param {object} options
 * @param {string} [options.window] 时间窗：24h | 7d | 30d | all
 * @param {number} [options.now] 注入式时钟，便于测试
 * @param {object} [options.pricing] 价目表
 * @param {string} [options.currency]
 * @param {number} [options.topN]
 * @param {number} [options.withoutCacheRecord] 只给 Host：多少会话没有缓存记录
 * @param {boolean} [options.includeSessions] 是否携带全量会话明细（导出用）
 */
export function buildReport(sessions, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const windowKind = typeof options.window === 'string' ? options.window : 'all';
  const windowed = filterByWindow(sessions, { kind: windowKind, now });

  const report = aggregate(windowed, {
    now,
    pricing: options.pricing,
    currency: options.currency,
    topN: options.topN,
    // 时间窗要同时进「筛选」与「报告标注」：只传给 filterByWindow 会让
    // report.window.kind 永远是 all，面板与数据就对不上了。
    window: { kind: windowKind },
  });

  report.schemaVersion = SCHEMA_VERSION;
  report.coverage = {
    listed: sessions.length,
    inWindow: windowed.length,
    ...(Number.isInteger(options.withoutCacheRecord)
      ? { withoutCacheRecord: options.withoutCacheRecord }
      : {}),
  };

  if (options.includeSessions === true) {
    report.sessions = windowed;
  }

  return report;
}

export { normalizeSession };
