/**
 * 聚合核心的单元测试。
 *
 * 夹具的形状完全照抄本机 `~/.dsh/storages/session_projcache/sessions/*.json`
 * 实测到的结构；标题与 id 全部是编造的，不包含任何真实会话内容。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregate,
  filterByWindow,
  normalizeSession,
} from '../lib/core.js';
import { estimateCost, normalizePrice, resolvePrice } from '../lib/pricing.js';

function header(overrides = {}) {
  return {
    id: 'session-0000',
    formatVersion: 4,
    createdAt: 1_700_000_000_000,
    cwd: '/Users/example/project-alpha',
    isSeeded: false,
    ...overrides,
  };
}

function values(overrides = {}) {
  return {
    title: '一个测试会话',
    tokenUsage: {
      totals: {
        uncachedInputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 8000,
        cacheWriteTokens: 0,
      },
    },
    sessionStats: {
      turns: 4,
      steps: 12,
      llmMs: 60_000,
      toolMs: 20_000,
      ttftMs: 3000,
      ttftSteps: 3,
      decodeMs: 10_000,
      decodeTokens: 200,
      pendingCalls: {},
      openStep: null,
    },
    contextPressure: { surfaceTokens: 50_000, contextWindow: 1_000_000, pressureTokens: 120_000 },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ 规范化 */

test('规范化完整记录：token 桶相加、缓存命中率按「命中读取/可缓存读取」计算', () => {
  const session = normalizeSession({ header: header(), values: values(), live: true });
  assert.equal(session.tokens.billableInput, 9000);
  assert.equal(session.tokens.total, 9200);
  assert.equal(session.tokens.cacheHitRate, 8000 / 9000);
  assert.equal(session.live, true);
  assert.equal(session.hasUsage, true);
  assert.equal(session.workspaceLabel, 'project-alpha');
});

test('缺失整块 values 时不抛错，退化为零值且 hasUsage=false', () => {
  const session = normalizeSession({ header: header() });
  assert.equal(session.hasUsage, false);
  assert.equal(session.tokens.total, 0);
  assert.equal(session.tokens.cacheHitRate, null);
  assert.equal(session.stats.turns, 0);
  assert.equal(session.context.usageRatio, null);
});

test('完全空的入参也能规范化（防御投影键被后续版本增删）', () => {
  const session = normalizeSession({});
  assert.equal(session.id, '');
  assert.equal(session.displayTitle, '（未命名会话）');
  assert.equal(session.workspaceLabel, '（未知工作区）');
  assert.equal(session.createdAt, 0);
});

test('tokenUsage 存在但没有 totals 时按零处理，不产生 NaN', () => {
  const session = normalizeSession({ header: header(), values: values({ tokenUsage: {} }) });
  assert.equal(session.tokens.total, 0);
  assert.ok(Number.isFinite(session.tokens.total));
  assert.equal(session.hasUsage, false);
});

test('非数值字段被忽略而不是污染合计', () => {
  const session = normalizeSession({
    header: header(),
    values: values({
      tokenUsage: { totals: { uncachedInputTokens: 'abc', outputTokens: null, cacheReadTokens: 10 } },
    }),
  });
  assert.equal(session.tokens.uncachedInputTokens, 0);
  assert.equal(session.tokens.outputTokens, 0);
  assert.equal(session.tokens.cacheReadTokens, 10);
  assert.ok(Number.isFinite(session.tokens.total));
});

test('缓存命中率的分母不含 cacheWrite —— 首次写入缓存不应压低命中率', () => {
  // 这个用例专门用来区分两种分母口径：
  //   正确：cacheRead / (cacheRead + uncachedInput)
  //   错误：cacheRead / billableInput（billableInput 多算了 cacheWrite）
  // 若夹具里 cacheWrite 恒为 0，两者恰好相等，测试就失去鉴别力。
  const session = normalizeSession({
    header: header(),
    values: values({
      tokenUsage: {
        totals: {
          uncachedInputTokens: 1000,
          outputTokens: 0,
          cacheReadTokens: 1000,
          cacheWriteTokens: 8000,
        },
      },
    }),
  });
  assert.equal(session.tokens.billableInput, 10_000);
  assert.equal(session.tokens.cacheHitRate, 0.5);
});

test('缓存命中率的分母不含 cacheWrite，聚合后同样成立', () => {
  const single = normalizeSession({
    header: header(),
    values: values({
      tokenUsage: {
        totals: { uncachedInputTokens: 100, outputTokens: 0, cacheReadTokens: 300, cacheWriteTokens: 900 },
      },
    }),
  });
  const report = aggregate([single], {});
  assert.equal(report.totals.tokens.cacheHitRate, 0.75);
});

test('没有可缓存输入时命中率为 null，而不是 0 或 NaN', () => {
  const session = normalizeSession({
    header: header(),
    values: values({
      tokenUsage: { totals: { outputTokens: 100 } },
    }),
  });
  assert.equal(session.tokens.cacheHitRate, null);
});

test('官方未给出 contextWindow 时占用率为 null，不编造百分比', () => {
  const session = normalizeSession({
    header: header(),
    values: values({ contextPressure: { surfaceTokens: 10 } }),
  });
  assert.equal(session.context.contextWindow, 0);
  assert.equal(session.context.usageRatio, null);
});

test('派生速率指标在分母为 0 时为 null，避免 Infini', () => {
  const session = normalizeSession({
    header: header(),
    values: values({ sessionStats: { turns: 0, steps: 0, decodeMs: 0, decodeTokens: 0, ttftSteps: 0 } }),
  });
  assert.equal(session.stats.avgTurnMs, null);
  assert.equal(session.stats.outputTokensPerSecond, null);
  assert.equal(session.stats.avgTtftMs, null);
});

test('空白标题退回未命名', () => {
  const session = normalizeSession({ header: header(), values: values({ title: '   ' }) });
  assert.equal(session.title, null);
  assert.equal(session.displayTitle, '（未命名会话）');
});

/* ---------------------------------------------------------------- 时间窗筛选 */

test('时间窗按会话创建时间筛选', () => {
  const now = 1_700_000_000_000;
  const sessions = [
    normalizeSession({ header: header({ id: 'a', createdAt: now - 1000 }), values: values() }),
    normalizeSession({ header: header({ id: 'b', createdAt: now - 10 * 24 * 3600 * 1000 }), values: values() }),
  ];
  assert.equal(filterByWindow(sessions, { kind: 'all', now }).length, 2);
  assert.equal(filterByWindow(sessions, { kind: '7d', now }).length, 1);
  assert.equal(filterByWindow(sessions, { kind: '24h', now }).length, 1);
});

test('未知时间窗取值时不做筛选，而不是返回空', () => {
  const sessions = [normalizeSession({ header: header(), values: values() })];
  assert.equal(filterByWindow(sessions, { kind: '不存在的窗口' }).length, 1);
});

/* -------------------------------------------------------------------- 聚合 */

function fixture() {
  return [
    normalizeSession({
      header: header({ id: 's1', createdAt: 1_700_000_000_000, cwd: '/Users/example/alpha' }),
      values: values({ tokenUsage: { totals: { uncachedInputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000 } } }),
      live: true,
    }),
    normalizeSession({
      header: header({ id: 's2', createdAt: 1_700_000_000_000 + 86_400_000, cwd: '/Users/example/alpha' }),
      values: values({ tokenUsage: { totals: { uncachedInputTokens: 300_000, outputTokens: 100_000 } } }),
    }),
    normalizeSession({
      header: header({ id: 's3', createdAt: 1_700_000_000_000, cwd: '/Users/example/beta' }),
      values: values({ tokenUsage: { totals: { uncachedInputTokens: 50_000, outputTokens: 10_000 } } }),
    }),
    // 只有 header、没有任何投影数据的空壳会话（真实环境里很常见）
    normalizeSession({ header: header({ id: 's4', createdAt: 1_700_000_000_000, cwd: '/Users/example/beta' }) }),
  ];
}

test('守恒：按工作区求和必须等于总计', () => {
  const report = aggregate(fixture(), { topN: 2 });
  const sum = report.byWorkspace.reduce((acc, w) => acc + w.tokens.total, 0);
  assert.equal(sum, report.totals.tokens.total);
});

test('守恒：按天求和必须等于总计（防止重复累加）', () => {
  const report = aggregate(fixture(), { topN: 2 });
  const sum = report.byDay.reduce((acc, d) => acc + d.tokens.total, 0);
  assert.equal(sum, report.totals.tokens.total);
});

test('守恒：按天求和等于总计，且与工作区口径一致', () => {
  const report = aggregate(fixture(), { topN: 2 });
  const byDay = report.byDay.reduce((acc, d) => acc + d.tokens.total, 0);
  const byWorkspace = report.byWorkspace.reduce((acc, w) => acc + w.tokens.total, 0);
  assert.equal(byDay, byWorkspace);
  assert.equal(byDay, report.totals.tokens.total);
});

test('零用量会话计入会话数，但不计入有用量会话数', () => {
  const report = aggregate(fixture(), { topN: 2 });
  assert.equal(report.totals.sessions, 4);
  assert.equal(report.totals.sessionsWithUsage, 3);
  assert.equal(report.totals.liveSessions, 1);
});

test('工作区按 token 总量降序排列', () => {
  const report = aggregate(fixture(), { topN: 2 });
  assert.equal(report.byWorkspace[0].label, 'alpha');
  assert.equal(report.byWorkspace[1].label, 'beta');
  assert.ok(report.byWorkspace[0].tokens.total > report.byWorkspace[1].tokens.total);
});

test('topSessions 只含有效用的会话，按总量降序且受 topN 限制', () => {
  const report = aggregate(fixture(), { topN: 2 });
  assert.equal(report.topSessions.length, 2);
  assert.equal(report.topSessions[0].id, 's1');
  assert.ok(report.topSessions[0].tokens.total >= report.topSessions[1].tokens.total);
});

test('topN 为负数时回退默认值，而不是从末尾反向截断', () => {
  const report = aggregate(fixture(), { topN: -1 });
  assert.deepEqual(report.topSessions.map((session) => session.id), ['s1', 's2', 's3']);
});

test('没有价目表时成本不可用，且明确给出原因而不是 0 元', () => {
  const report = aggregate(fixture(), { topN: 2 });
  assert.equal(report.cost.available, false);
  assert.equal(report.cost.reason, 'no-price-table');
  assert.equal(report.topSessions[0].cost, null);
});

test('配置价目表后金额按每百万 token 精确计算', () => {
  const report = aggregate(fixture(), {
    topN: 2,
    currency: 'CNY',
    pricing: { default: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } },
  });
  // s1: 1.0M*1 + 0.5M*2 + 2.0M*0.1 = 1 + 1 + 0.2 = 2.2
  const s1 = report.topSessions.find((s) => s.id === 's1');
  assert.equal(s1.cost.toFixed(4), '2.2000');
  assert.equal(report.cost.available, true);
  assert.equal(report.cost.currency, 'CNY');
  assert.equal(report.cost.basis, 'aggregate-single-rate');
  // 总计 = s1 + s2 + s3
  const expected =
    (1_350_000 * 1 + 610_000 * 2 + 2_000_000 * 0.1) / 1_000_000;
  assert.equal(report.cost.amount.toFixed(6), expected.toFixed(6));
});

test('空集合也能聚合出结构完整的报告', () => {
  const report = aggregate([], {});
  assert.equal(report.totals.sessions, 0);
  assert.equal(report.totals.tokens.total, 0);
  assert.deepEqual(report.byWorkspace, []);
  assert.deepEqual(report.byDay, []);
  assert.deepEqual(report.topSessions, []);
});

/* -------------------------------------------------------------------- 价目表 */

test('价目表规范化：缺省桶按 0，非法值整体判为不可用', () => {
  assert.deepEqual(normalizePrice({ input: 1, output: 2 }), {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(normalizePrice({ input: -1 }), null);
  assert.equal(normalizePrice({ input: 'x' }), null);
  assert.equal(normalizePrice(null), null);
  assert.equal(normalizePrice('nope'), null);
});

test('resolvePrice 支持 default 键与直接给出四个桶两种写法', () => {
  assert.equal(resolvePrice({ default: { input: 3 } }).input, 3);
  assert.equal(resolvePrice({ input: 4 }).input, 4);
  assert.equal(resolvePrice(undefined), null);
});

test('estimateCost 在没有价目表时返回 null', () => {
  assert.equal(estimateCost({ uncachedInputTokens: 1 }, null), null);
});
