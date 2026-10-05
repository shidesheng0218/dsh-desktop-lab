/**
 * 导出契约测试。
 *
 * 目的不是「跑通」，而是**冻结对外形状**：一旦有外部工具消费这份 JSON/CSV，
 * 任何字段的增删改都是一次破坏性变更。这里把当前的键集写死，改动必须
 * 同时升 SCHEMA_VERSION 并更新 docs/report-schema.md，否则测试红。
 *
 * 覆盖三块：报告键集、CSV 序列化（含注入防护）、表的行源语义。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSession } from '../lib/core.js';
import { SCHEMA_VERSION, TABLES, buildReport, tableRows } from '../lib/report.js';
import {
  CSV_CONTENT_TYPE,
  UTF8_BOM,
  csvCell,
  csvFilename,
  toCsv,
  toJson,
} from '../lib/export.js';

/* ------------------------------------------------------------------ 夹具 */

function session(overrides = {}) {
  const values = {
    title: '会话标题',
    tokenUsage: {
      totals: {
        uncachedInputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 8000,
        cacheWriteTokens: 50,
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
    ...overrides.values,
  };
  return normalizeSession({
    header: {
      id: 'session-0001',
      formatVersion: 4,
      createdAt: Date.UTC(2026, 9, 5, 4, 0, 0),
      cwd: '/Users/example/project-alpha',
      isSeeded: false,
      ...overrides.header,
    },
    values,
    live: overrides.live ?? false,
  });
}

function report(options = {}) {
  return buildReport([session()], {
    window: 'all',
    now: Date.UTC(2026, 9, 5, 12, 0, 0),
    includeSessions: options.includeSessions,
    withoutCacheRecord: options.withoutCacheRecord,
  });
}

const keys = (value) => Object.keys(value).sort();

/* -------------------------------------------------------------- 键集冻结 */

test('SCHEMA_VERSION 是 1；改字段集必须递增它', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(report().schemaVersion, 1);
});

test('报告顶层键集被冻结', () => {
  assert.deepEqual(keys(report()), [
    'byDay',
    'byWorkspace',
    'cost',
    'coverage',
    'currency',
    'generatedAt',
    'schemaVersion',
    'topSessions',
    'totals',
    'window',
  ]);
});

test('sessions 明细只在 includeSessions 时出现（不静默放大面板负载）', () => {
  assert.ok(!('sessions' in report()));
  assert.ok('sessions' in report({ includeSessions: true }));
});

test('totals / tokens / stats 键集被冻结', () => {
  const r = report();
  assert.deepEqual(keys(r.totals), [
    'liveSessions',
    'openSteps',
    'sessions',
    'sessionsWithUsage',
    'stats',
    'tokens',
  ]);
  assert.deepEqual(keys(r.totals.tokens), [
    'billableInput',
    'cacheHitRate',
    'cacheReadTokens',
    'cacheWriteTokens',
    'outputTokens',
    'total',
    'uncachedInputTokens',
  ]);
  assert.deepEqual(keys(r.totals.stats), [
    'decodeMs',
    'decodeTokens',
    'llmMs',
    'steps',
    'toolMs',
    'turns',
    'wallMs',
  ]);
});

test('cost 在未配置价目表与已配置时的形状都被冻结', () => {
  const unavailable = report().cost;
  assert.deepEqual(keys(unavailable), ['available', 'currency', 'reason']);

  const available = buildReport([session()], {
    window: 'all',
    now: Date.UTC(2026, 9, 5, 12, 0, 0),
    pricing: { default: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } },
  }).cost;
  assert.deepEqual(keys(available), ['amount', 'available', 'basis', 'currency', 'price']);
});

test('各表的行键集被冻结', () => {
  const r = report({ includeSessions: true });
  assert.deepEqual(keys(r.byWorkspace[0]), ['cost', 'cwd', 'label', 'sessions', 'stats', 'tokens']);
  assert.deepEqual(keys(r.byDay[0]), ['day', 'sessions', 'tokens']);
  assert.deepEqual(keys(r.topSessions[0]), [
    'cost',
    'createdAt',
    'cwd',
    'displayTitle',
    'id',
    'title',
    'tokens',
    'workspaceLabel',
  ]);
  assert.deepEqual(keys(r.sessions[0]), [
    'context',
    'createdAt',
    'cwd',
    'displayTitle',
    'hasUsage',
    'id',
    'live',
    'stats',
    'title',
    'tokens',
    'workspaceLabel',
  ]);
  assert.deepEqual(keys(r.sessions[0].context), [
    'contextWindow',
    'pressureTokens',
    'surfaceTokens',
    'usageRatio',
  ]);
});

test('coverage 反映「列了多少 / 落在窗内多少 / 多少没有缓存记录」', () => {
  const r = report({ withoutCacheRecord: 3 });
  assert.deepEqual(r.coverage, { listed: 1, inWindow: 1, withoutCacheRecord: 3 });
  // withoutCacheRecord 是 Host 专属信息；CLI 不传时不应凭空出现一个 0
  assert.deepEqual(keys(report().coverage), ['inWindow', 'listed']);
});

/* ---------------------------------------------------------------- CSV */

test('CSV 以 BOM 开头（否则 Excel 打开中文是乱码）', () => {
  // 用字面量断言，不要写 `startsWith(UTF8_BOM)`：那样把常量改成空串
  // 断言仍会通过，等于什么都没测。变异测试抓出过这个弱点。
  const csv = toCsv(report(), 'summary');
  assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV 首字符必须是 U+FEFF');
  assert.deepEqual([...Buffer.from(csv, 'utf8').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(UTF8_BOM, '\uFEFF');
  assert.equal(CSV_CONTENT_TYPE, 'text/csv; charset=utf-8');
});

test('CSV 表头与 TABLES 的列定义一致 —— JSON 与 CSV 不会漂移', () => {
  for (const table of ['summary', 'workspace', 'daily']) {
    const csv = toCsv(report(), table);
    const header = csv.replace(UTF8_BOM, '').split('\n')[0];
    assert.equal(
      header,
      TABLES[table].columns.map((column) => column.header).join(','),
      `${table} 表头与列定义不一致`,
    );
  }
});

test('CSV 行数等于表行数（不含表头）', () => {
  const r = report();
  const csv = toCsv(r, 'workspace').replace(UTF8_BOM, '').trimEnd();
  assert.equal(csv.split('\n').length, r.byWorkspace.length + 1);
});

test('CSV 单元格按 RFC 4180 转义：逗号、引号、换行', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(false), 'false');
});

test('CSV 公式注入防护：= + @ 与制表符开头会被降级为文本', () => {
  for (const dangerous of ['=1+1', '=cmd|\' /c calc\'!A0', '+1', '@SUM(A1)', '\tx']) {
    const cell = csvCell(dangerous);
    assert.ok(cell.startsWith("'"), `${JSON.stringify(dangerous)} 未被降级：${cell}`);
  }
});

test('CSV 注入防护不误伤负数与数字字符串', () => {
  assert.equal(csvCell('-1'), '-1');
  assert.equal(csvCell(-42), '-42');
  assert.equal(csvCell('-1.5e3'), '-1.5e3');
  // 但 -1+1 这种「不是数字的 - 开头」仍要防护
  assert.ok(csvCell('-1+1').startsWith("'"));
});

test('sessions 表需要全量明细；缺失时报错而不是用 topSessions 冒充全量', () => {
  assert.throws(
    () => toCsv(report(), 'sessions'),
    /includeSessions/,
    '缺少明细时必须显式报错，不能静默截断',
  );
  // 带上明细就能导出，且行数等于会话数
  const r = report({ includeSessions: true });
  const csv = toCsv(r, 'sessions').replace(UTF8_BOM, '').trimEnd();
  assert.equal(csv.split('\n').length, r.sessions.length + 1);
});

test('未知表名报错并列出可用表', () => {
  assert.throws(() => toCsv(report(), 'nope'), /未知的导出表/);
});

test('列取值抛异常时留空，而不是让整次导出失败', () => {
  const broken = { columns: TABLES.workspace.columns };
  const r = report();
  // 构造一行缺字段的 byWorkspace，模拟源形状漂移
  const mutated = { ...r, byWorkspace: [{}] };
  const csv = toCsv(mutated, 'workspace');
  const lines = csv.replace(UTF8_BOM, '').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(broken.columns.length > 0);
});

test('csvFilename 带表名、时间窗与日期', () => {
  const name = csvFilename(report(), 'workspace');
  assert.match(name, /^usage-insights-workspace-all-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('toJson 输出可被 JSON.parse 且与报告等价', () => {
  const r = report();
  assert.deepEqual(JSON.parse(toJson(r)), JSON.parse(JSON.stringify(r)));
});

/* ------------------------------------------------------------ 表行语义 */

test('tableRows 的表语义：summary 单行、sessions 缺明细返回 null', () => {
  const r = report();
  assert.equal(tableRows(r, 'summary').length, 1);
  assert.equal(tableRows(r, 'workspace')[0], r.byWorkspace[0]);
  assert.equal(tableRows(r, 'daily')[0], r.byDay[0]);
  assert.equal(tableRows(r, 'sessions'), null);
  assert.equal(tableRows(r, 'nope'), null);
});
