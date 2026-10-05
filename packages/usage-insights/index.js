/**
 * Host 半边：跨会话用量与成本面板的数据供给。
 *
 * 取数路径（每一处 API 都从官方已构建源码里核对过，不是照 README 猜的）：
 *
 *   await ctx.sessionQuery.listSessions()
 *     → [{ header: {id, formatVersion, createdAt, cwd, isSeeded, ...}, live, persisted }]
 *       按最新在前排序；header 是不读日志的会话头。
 *
 *   ctx.sessionProjectionCache.cachedSnapshot(header, keys)   // 同步，零 I/O
 *     → { asOfSeq, values: { tokenUsage, sessionStats, title, contextPressure } } | undefined
 *       值已解包（不是 {ver, seq, val}）；读取的是 storageDomain 的内存表，
 *       与官方会话列表看到的是同一份事实，只是「与最后一次 checkpoint 一样旧」。
 *
 * 供数路径：连接层的 exact Fetch 路由。官方 dsh-session-log-export 用同一条路
 * 把会话 ZIP 递给浏览器（`GET /api/session.export`），这里照做。
 * 注意 assertFetchRoute 要求路径必须落在 `/api/` 之下，否则注册时直接抛错。
 *
 * 为什么不在 Host 侧做任何会失败的事：apply() 抛异常会拖垮整个 profile，
 * 所以取数失败被折成 HTTP 500 + JSON 错误体，面板能显示原因并重试。
 */
import { aggregate, filterByWindow, normalizeSession } from './lib/core.js';

/** 路径必须位于 /api/ 之下。 */
const DATA_PATH = '/api/usage-insights';

/** 需要的投影键；官方增删其它键不影响本插件。 */
const PROJECTION_KEYS = ['tokenUsage', 'sessionStats', 'title', 'contextPressure'];

const DEFAULT_WINDOW = '7d';
const VALID_WINDOWS = new Set(['24h', '7d', '30d', 'all']);

/**
 * 声明依赖的服务。缺任何一个，本插件保持未激活——
 * 比抛异常拖垮 profile 好，也比半死不活地注册一个永远 500 的路由好。
 */
export const inject = ['sessionQuery', 'sessionProjectionCache', 'connection'];

/**
 * 把全量会话折叠成报告。
 * @param {object} ctx Cordis 上下文
 * @param {{pricing?:object, currency?:string, topN?:number}} config
 * @param {string} windowKind
 */
async function buildReport(ctx, config, windowKind) {
  const records = await ctx.sessionQuery.listSessions();

  const sessions = [];
  let missingCache = 0;

  for (const record of records) {
    const header = record?.header;
    if (header === undefined || header === null) continue;
    let snapshot;
    try {
      snapshot = ctx.sessionProjectionCache.cachedSnapshot(header, PROJECTION_KEYS);
    } catch {
      // 单个会话的缓存读失败不应让整份报告失败。
      snapshot = undefined;
    }
    if (snapshot === undefined) missingCache += 1;
    sessions.push({
      header,
      values: snapshot?.values ?? {},
      live: record.live === true,
      asOfSeq: snapshot?.asOfSeq,
    });
  }

  const normalized = sessions.map(normalizeSession);
  const now = Date.now();
  const windowed = filterByWindow(normalized, { kind: windowKind, now });

  const report = aggregate(windowed, {
    now,
    pricing: config.pricing,
    currency: config.currency,
    topN: config.topN,
    // 时间窗要同时进「筛选」与「报告标注」：只传给 filterByWindow 会让
    // report.window.kind 永远是 all，面板与数据就对不上了。
    window: { kind: windowKind },
  });

  // 让面板能如实说明「有多少会话没有缓存数据」。
  report.coverage = {
    listed: normalized.length,
    inWindow: windowed.length,
    withoutCacheRecord: missingCache,
  };

  return report;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * @param {object} ctx
 * @param {{window?:string, currency?:string, topN?:number, pricing?:object}} config
 */
export function apply(ctx, config = {}) {
  const settings = {
    window: VALID_WINDOWS.has(config.window) ? config.window : DEFAULT_WINDOW,
    currency: config.currency,
    topN: config.topN,
    pricing: config.pricing,
  };

  // connection.fetch.register 内部已用 owner.effect 管理生命周期
  // （官方 session-log-export 同样直接调用），因此不再包一层 ctx.effect。
  ctx.connection.fetch.register({
    path: DATA_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const requested = new URL(request.url).searchParams.get('window');
      const windowKind = requested !== null && VALID_WINDOWS.has(requested) ? requested : settings.window;

      let response;
      try {
        const report = await buildReport(ctx, settings, windowKind);
        response = jsonResponse({
          ok: true,
          window: windowKind,
          generatedAt: report.generatedAt,
          report,
        });
      } catch (error) {
        ctx.logger?.warn?.('usage-insights: 汇总失败', error);
        response = jsonResponse(
          {
            ok: false,
            message: `汇总失败：${error?.message ?? String(error)}`,
          },
          500,
        );
      }

      if (request.method === 'GET') return response;
      // HEAD 不允许带响应体。
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    },
  });

  ctx.logger?.info?.(`usage-insights: 数据路由已注册于 ${DATA_PATH}`);
}
