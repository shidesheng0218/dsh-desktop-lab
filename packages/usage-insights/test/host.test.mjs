/**
 * Host 半边的集成测试。
 *
 * 本机无法安装 bundle（桌面版的 plugin_manager 工具行默认 disabled，
 * 我这个会话也没有该工具），所以「跑起来看看」这条路走不通。
 * 替代方案是把 Cordis 上下文模拟出来——只模拟本插件真正用到的三个服务，
 * 然后对注册出来的路由发真实 Request，验证整条取数链路。
 *
 * 这样能覆盖的：路由注册形状、参数解析、聚合结果、HEAD 语义、错误降级。
 * 覆盖不到的：Loader 是否真的把这个包挂起来、浏览器能否取到面板。
 * 后者只能由使用者在 GUI 里装一次确认，README 里已如实写明。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, inject } from '../index.js';
import { readProjectionCache, resolveDshHome } from './report-real.mjs';

/** 造一个只含本插件所需服务的最小 Cordis 上下文。 */
function makeCtx(records, options = {}) {
  const routes = [];
  return {
    routes,
    connection: { fetch: { register: (route) => routes.push(route) } },
    sessionQuery: {
      listSessions: async () => {
        if (options.listFails === true) throw new Error('persistence 不可用');
        return records;
      },
    },
    sessionProjectionCache: {
      cachedSnapshot: (header) => {
        if (options.snapshotThrowsFor?.includes(header.id) === true) {
          throw new Error('corrupt checkpoint');
        }
        const values = options.values?.[header.id];
        if (values === undefined) return undefined;
        return { asOfSeq: 100, values };
      },
    },
    logger: { info() {}, warn() {} },
  };
}

function record(id, values, extra = {}) {
  return {
    header: {
      id,
      formatVersion: 4,
      // 夹具必须用相对当前时间的 createdAt：写死一个绝对时间戳会让
      // 「7 天窗」把所有会话都过滤掉，测试就会在断言 session 数量时莫名失败。
      createdAt: Date.now() - 60_000,
      cwd: '/Users/example/project-alpha',
      isSeeded: false,
    },
    live: false,
    ...extra,
  };
}

function usage(uncachedInputTokens, outputTokens, cacheReadTokens = 0) {
  return { tokenUsage: { totals: { uncachedInputTokens, outputTokens, cacheReadTokens } } };
}

const VALUES = {
  s1: { ...usage(1_000_000, 500_000, 2_000_000), title: '会话一' },
  s2: { ...usage(300_000, 100_000), title: '会话二' },
};

function setup(options = {}) {
  const ctx = makeCtx(
    [
      record('s1'),
      record('s2'),
      // 没有缓存记录的会话：真实环境里很常见
      record('s3'),
    ],
    { values: VALUES, ...options },
  );
  apply(ctx, { window: '7d', currency: 'CNY', topN: 5 });
  return ctx;
}

function request(url, method = 'GET') {
  return new Request(url, { method });
}

/* ------------------------------------------------------------------ 注册 */

test('apply 注册出恰好一条路由，且路径在 /api/ 之下（连接层强制要求）', () => {
  const ctx = setup();
  assert.equal(ctx.routes.length, 1);
  const route = ctx.routes[0];
  assert.equal(route.path, '/api/usage-insights');
  assert.ok(route.path.startsWith('/api/'), '路径不在 /api/ 下时 assertFetchRoute 会直接抛错');
  assert.deepEqual(route.methods, ['GET', 'HEAD']);
  assert.equal(route.requestBody, 'buffered');
  assert.equal(typeof route.fetch, 'function');
});

test('inject 声明了全部依赖服务，缺失时插件保持未激活而不是抛错', () => {
  assert.deepEqual(inject, ['sessionQuery', 'sessionProjectionCache', 'connection']);
});

/* -------------------------------------------------------------- 取数链路 */

test('GET 返回完整报告，聚合结果正确', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights?window=all'));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.equal(body.window, 'all');
  assert.equal(body.report.totals.sessions, 3);
  assert.equal(body.report.totals.sessionsWithUsage, 2);
  // 1.3M 未缓存 + 0.6M 输出 + 2M 缓存读 = 3.9M
  assert.equal(body.report.totals.tokens.total, 3_900_000);
  assert.equal(body.report.byWorkspace.length, 1);
  assert.equal(body.report.topSessions.length, 2);
});

test('没有缓存记录的会话被计入 coverage.withoutCacheRecord，但不让请求失败', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights?window=all'));
  const body = await response.json();
  assert.equal(body.report.coverage.listed, 3);
  assert.equal(body.report.coverage.inWindow, 3);
  assert.equal(body.report.coverage.withoutCacheRecord, 1);
});

test('单个会话的投影读取抛异常时，整体报告仍然成功', async () => {
  const ctx = setup({ snapshotThrowsFor: ['s1'] });
  const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights?window=all'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  // s1 退化零值，只剩 s2 的 400k
  assert.equal(body.report.totals.tokens.total, 400_000);
  assert.equal(body.report.coverage.withoutCacheRecord, 2);
});

test('未配置价目表时报告里明确标注不可用，而不是给 0 元', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights?window=all'));
  const body = await response.json();
  assert.equal(body.report.cost.available, false);
  assert.equal(body.report.cost.reason, 'no-price-table');
});

/* ------------------------------------------------------------------ 参数 */

test('window 查询参数覆盖配置默认值', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights?window=24h'));
  const body = await response.json();
  assert.equal(body.window, '24h');
  // 只断言外层 body.window 不够：真正渲染到面板上的是 report.window.kind。
  // 早期版本就是外层对了、内层永远是 all（aggregate 没收到 window）。
  assert.equal(body.report.window.kind, '24h');
});

test('report.window.kind 必须跟随实际生效的时间窗', async () => {
  const ctx = setup();
  const route = ctx.routes[0];
  for (const kind of ['24h', '7d', '30d', 'all']) {
    const body = await (await route.fetch(request(`http://127.0.0.1/api/usage-insights?window=${kind}`))).json();
    assert.equal(body.window, kind);
    assert.equal(body.report.window.kind, kind, `report.window.kind 应为 ${kind}`);
  }
});

test('非法 window 取值退回配置默认值，而不是报错或返回空', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(
    request('http://127.0.0.1/api/usage-insights?window=__proto__'),
  );
  const body = await response.json();
  assert.equal(body.window, '7d');
  assert.equal(body.report.totals.sessions, 3);
});

test('时间窗真的会排除窗口外的旧会话', async () => {
  const ctx = makeCtx(
    [
      record('recent'),
      record('ancient', undefined, {
        header: {
          id: 'ancient',
          formatVersion: 4,
          createdAt: Date.now() - 90 * 24 * 3600 * 1000,
          cwd: '/Users/example/project-alpha',
          isSeeded: false,
        },
      }),
    ],
    { values: { recent: VALUES.s1, ancient: VALUES.s2 } },
  );
  apply(ctx, { window: '7d' });
  const route = ctx.routes[0];

  const weekly = await (await route.fetch(request('http://127.0.0.1/api/usage-insights?window=7d'))).json();
  assert.equal(weekly.report.totals.sessions, 1);
  assert.equal(weekly.report.totals.tokens.total, 3_500_000);

  const all = await (await route.fetch(request('http://127.0.0.1/api/usage-insights?window=all'))).json();
  assert.equal(all.report.totals.sessions, 2);
  assert.equal(all.report.totals.tokens.total, 3_900_000);
});

test('缺少 window 参数时使用配置默认值', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights'));
  const body = await response.json();
  assert.equal(body.window, '7d');
});

/* -------------------------------------------------------------------- HEAD */

test('HEAD 返回同样的状态码但没有响应体', async () => {
  const ctx = setup();
  const route = ctx.routes[0];
  const getResponse = await route.fetch(request('http://127.0.0.1/api/usage-insights?window=all'));
  const headResponse = await route.fetch(request('http://127.0.0.1/api/usage-insights?window=all', 'HEAD'));
  assert.equal(headResponse.status, getResponse.status);
  assert.equal(await headResponse.text(), '');
});

/* -------------------------------------------------------------------- 降级 */

test('取数整体失败时返回 500 + JSON 错误体，而不是抛异常拖垮 profile', async () => {
  const ctx = setup({ listFails: true });
  const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights'));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.message, /persistence 不可用/);
});

test('失败路径下 HEAD 同样不泄漏响应体', async () => {
  const ctx = setup({ listFails: true });
  const response = await ctx.routes[0].fetch(
    request('http://127.0.0.1/api/usage-insights', 'HEAD'),
  );
  assert.equal(response.status, 500);
  assert.equal(await response.text(), '');
});

/* -------------------------------------------------- 真实数据端到端交叉验证 */

function loadRealRecords() {
  const { sessions } = readProjectionCache(resolveDshHome());
  return sessions;
}

const realRecords = loadRealRecords();

test(
  '用本机真实投影缓存跑通 Host 链路，并与 report-real 的口径一致',
  { skip: realRecords.length === 0 ? '本机投影缓存为空，跳过真实数据交叉验证' : false },
  async () => {
    const ctx = makeCtx(
      realRecords.map((entry) => ({
        header: entry.header,
        live: false,
        persisted: true,
      })),
      {
        values: Object.fromEntries(
          realRecords.map((entry) => [entry.header.id, entry.values]),
        ),
      },
    );
    apply(ctx, { window: 'all', topN: 5 });

    const response = await ctx.routes[0].fetch(
      request('http://127.0.0.1/api/usage-insights?window=all'),
    );
    assert.equal(response.status, 200);
    const body = await response.json();

    // 逐条独立重算：真实数据上不允许出现 NaN / undefined。
    let expectedTotal = 0;
    for (const entry of realRecords) {
      const totals = entry.values?.tokenUsage?.totals ?? {};
      expectedTotal +=
        (totals.uncachedInputTokens ?? 0) +
        (totals.outputTokens ?? 0) +
        (totals.cacheReadTokens ?? 0) +
        (totals.cacheWriteTokens ?? 0);
    }

    assert.equal(body.report.totals.sessions, realRecords.length);
    assert.equal(body.report.totals.tokens.total, expectedTotal);
    assert.ok(Number.isFinite(body.report.totals.tokens.total));
    // 守恒：按天与按工作区求和必须等于总计
    const byDay = body.report.byDay.reduce((acc, d) => acc + d.tokens.total, 0);
    const byWorkspace = body.report.byWorkspace.reduce((acc, w) => acc + w.tokens.total, 0);
    assert.equal(byDay, expectedTotal);
    assert.equal(byWorkspace, expectedTotal);
  },
);

test(
  '真实数据的 JSON 响应可以无损序列化（不含 undefined / NaN）',
  { skip: realRecords.length === 0 ? '本机投影缓存为空' : false },
  async () => {
    const ctx = makeCtx(
      realRecords.map((entry) => ({ header: entry.header, live: false })),
      { values: Object.fromEntries(realRecords.map((e) => [e.header.id, e.values])) },
    );
    apply(ctx, {});
    const response = await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights'));
    const text = await response.text();
    assert.doesNotMatch(text, /NaN|Infinity|undefined/);
  },
);

/* -------------------------------------------------- 导出（格式协商） */

test('默认返回 JSON，且不携带全量会话明细（面板只需要 topN）', async () => {
  const ctx = setup();
  const body = await (
    await ctx.routes[0].fetch(request('http://127.0.0.1/api/usage-insights?window=all'))
  ).json();
  assert.equal(body.ok, true);
  assert.equal(body.report.schemaVersion, 1);
  assert.ok(!('sessions' in body.report), '默认响应不应带上全量明细');
});

test('format=csv 返回 CSV：正确的 content-type、下载头与 BOM', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(
    request('http://127.0.0.1/api/usage-insights?window=all&format=csv&table=workspace'),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(
    response.headers.get('content-disposition'),
    /^attachment; filename="usage-insights-workspace-all-\d{4}-\d{2}-\d{2}\.csv"$/,
  );

  // 注意：不能断言 `csv.startsWith('\uFEFF')` —— Response.text() 走的是
  // WHATWG 的 UTF-8 decode，会把前导 BOM 吃掉。必须校验原始字节。
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  assert.deepEqual(
    [...bytes.slice(0, 3)],
    [0xef, 0xbb, 0xbf],
    'CSV 字节流必须以 UTF-8 BOM 开头，否则 Excel 打开中文乱码',
  );

  const csv = await response.text();
  const lines = csv.replace('\uFEFF', '').trimEnd().split('\n');
  assert.equal(lines.length, 2, '表头 + 1 个工作区行');
  assert.match(lines[0], /^cwd,workspace,sessions,/);
});

test('format=csv&table=sessions 携带全量明细，行数等于会话数', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(
    request('http://127.0.0.1/api/usage-insights?window=all&format=csv&table=sessions'),
  );
  const csv = await response.text();
  const lines = csv.replace('\uFEFF', '').trimEnd().split('\n');
  // 夹具里有 3 个会话
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^session_id,title,cwd,/);
});

test('未知 format 返回 400，而不是静默回退成 JSON', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(
    request('http://127.0.0.1/api/usage-insights?format=xml'),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.message, /未知的 format/);
});

test('未知 table 返回 400 并列出可用表', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(
    request('http://127.0.0.1/api/usage-insights?format=csv&table=nope'),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /可用：.*summary/);
});

test('CSV 的 HEAD 请求返回同样的状态码与头，但没有响应体', async () => {
  const ctx = setup();
  const response = await ctx.routes[0].fetch(
    request('http://127.0.0.1/api/usage-insights?format=csv&table=summary', 'HEAD'),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.equal(await response.text(), '');
});

test('CSV 导出与 JSON 报告出自同一份数据（总计一致）', async () => {
  const ctx = setup();
  const route = ctx.routes[0];
  const json = await (
    await route.fetch(request('http://127.0.0.1/api/usage-insights?window=all'))
  ).json();
  const csv = await (
    await route.fetch(
      request('http://127.0.0.1/api/usage-insights?window=all&format=csv&table=summary'),
    )
  ).text();

  const [headerLine, valueLine] = csv.replace('\uFEFF', '').trimEnd().split('\n');
  const header = headerLine.split(',');
  const values = valueLine.split(',');
  const row = Object.fromEntries(header.map((key, index) => [key, values[index]]));

  assert.equal(Number(row.total_tokens), json.report.totals.tokens.total);
  assert.equal(Number(row.sessions), json.report.totals.sessions);
  assert.equal(Number(row.schema_version), json.report.schemaVersion);
});
