/**
 * 跨会话用量聚合的纯逻辑核心。
 *
 * 设计约束：本文件**不允许 import 任何 DSH 包，也不碰文件系统与网络**。
 * 它只做一件事：把「投影缓存里读到的原始记录」折叠成一份可渲染的报告。
 * 这样它就能用真实数据在本机直接单测——插件里真正容易出错的部分（聚合、
 * 边界、缺失值）全部落在可验证的范围内，而 Host 半边只剩取数接线。
 *
 * 输入数据的真实形状（来自本机 `~/.dsh/storages/session_projcache/sessions/*.json`，
 * 以及官方 sessionProjectionCache.cachedSnapshot() 的解包结果）：
 *
 *   header: { id, formatVersion, createdAt, cwd, isSeeded, ... }
 *   values: {
 *     tokenUsage:      { totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last }
 *     sessionStats:    { turns, steps, llmMs, toolMs, ttftMs, decodeMs, decodeTokens, ... }
 *     title:           string | null
 *     contextPressure: { surfaceTokens, contextWindow, pressureTokens, sampledSurfaceTokens }
 *   }
 *
 * 任何一层缺失都必须被容忍：投影缓存曾经被清理、会话刚创建还没有 checkpoint、
 * 官方在后续版本增删投影键——这些都不该让面板报错。
 */
import { estimateCost, resolvePrice } from './pricing.js';

/** 面板提供的固定时间窗。 */
export const WINDOWS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});

const UNTITLED = '（未命名会话）';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 安全取数：任意一层缺失都返回 undefined，而不是抛错。 */
function pick(source, ...keys) {
  let current = source;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function numberOr(value, fallback = 0) {
  return isFiniteNumber(value) ? value : fallback;
}

/**
 * 把一条会话记录规范化为面板使用的摘要。
 * @param {{header?:object, values?:object, live?:boolean}} entry
 */
export function normalizeSession(entry) {
  const header = entry?.header ?? {};
  const values = entry?.values ?? {};

  const totals = pick(values, 'tokenUsage', 'totals') ?? {};
  const tokens = {
    uncachedInputTokens: numberOr(totals.uncachedInputTokens),
    outputTokens: numberOr(totals.outputTokens),
    cacheReadTokens: numberOr(totals.cacheReadTokens),
    cacheWriteTokens: numberOr(totals.cacheWriteTokens),
  };
  tokens.billableInput = tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
  tokens.total = tokens.billableInput + tokens.outputTokens;

  // 缓存命中率的口径：命中的输入 / 全部可缓存的输入读取量。
  // cacheWrite 是新写入缓存的量，不计入分母，否则首次写入会把命中率压低。
  const cacheable = tokens.cacheReadTokens + tokens.uncachedInputTokens;
  tokens.cacheHitRate = cacheable > 0 ? tokens.cacheReadTokens / cacheable : null;

  const rawStats = values.sessionStats ?? {};
  const stats = {
    turns: numberOr(rawStats.turns),
    steps: numberOr(rawStats.steps),
    llmMs: numberOr(rawStats.llmMs),
    toolMs: numberOr(rawStats.toolMs),
    ttftMs: numberOr(rawStats.ttftMs),
    ttftSteps: numberOr(rawStats.ttftSteps),
    decodeMs: numberOr(rawStats.decodeMs),
    decodeTokens: numberOr(rawStats.decodeTokens),
    pendingCalls: Object.keys(rawStats.pendingCalls ?? {}).length,
    openStep: rawStats.openStep ?? null,
  };
  stats.wallMs = stats.llmMs + stats.toolMs;
  stats.avgTurnMs = stats.turns > 0 ? stats.wallMs / stats.turns : null;
  stats.avgTtftMs = stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : null;
  stats.outputTokensPerSecond = stats.decodeMs > 0 ? stats.outputTokens / (stats.decodeMs / 1000) : null;

  const pressure = values.contextPressure ?? {};
  const contextWindow = numberOr(pressure.contextWindow);
  const context = {
    surfaceTokens: numberOr(pressure.surfaceTokens),
    pressureTokens: numberOr(pressure.pressureTokens),
    contextWindow,
    // 占用率只在官方给出 contextWindow 时才有意义；否则为 null，
    // 面板显示「—」而不是编一个百分比出来。
    usageRatio:
      contextWindow > 0 && isFiniteNumber(pressure.pressureTokens)
        ? pressure.pressureTokens / contextWindow
        : null,
  };

  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null;
  const title = typeof values.title === 'string' && values.title.trim().length > 0 ? values.title : null;

  return {
    id: String(header.id ?? ''),
    title,
    displayTitle: title ?? UNTITLED,
    cwd,
    workspaceLabel: cwd === null ? '（未知工作区）' : cwd.split('/').filter(Boolean).pop() ?? cwd,
    createdAt: numberOr(header.createdAt),
    live: entry?.live === true,
    hasUsage: tokens.total > 0,
    tokens,
    stats,
    context,
  };
}

/**
 * 按时间窗筛选。
 *
 * 诚实口径：用的是会话**创建时间**（header.createdAt），不是最后一次活动时间。
 * 一个 30 天前创建、今天还在继续用的长会话不会被「最近 7 天」选中。
 * 投影缓存里没有可靠的「最后活动时间」字段，所以面板把这个口径写在界面上。
 * @param {ReturnType<typeof normalizeSession>[]} sessions
 * @param {{kind:string, now?:number}} window
 */
export function filterByWindow(sessions, window) {
  const kind = window?.kind ?? 'all';
  const span = WINDOWS[kind];
  if (span === undefined) return sessions;
  const now = numberOr(window?.now, Date.now());
  const since = now - span;
  return sessions.filter((session) => session.createdAt >= since);
}

function localDayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyTokenTotals() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    billableInput: 0,
    total: 0,
    cacheHitRate: null,
  };
}

function emptyStats() {
  return { turns: 0, steps: 0, llmMs: 0, toolMs: 0, wallMs: 0, decodeMs: 0, decodeTokens: 0 };
}

function addTokens(target, tokens) {
  target.uncachedInputTokens += tokens.uncachedInputTokens;
  target.outputTokens += tokens.outputTokens;
  target.cacheReadTokens += tokens.cacheReadTokens;
  target.cacheWriteTokens += tokens.cacheWriteTokens;
  target.billableInput += tokens.billableInput;
  target.total += tokens.total;
  return target;
}

function addStats(target, stats) {
  target.turns += stats.turns;
  target.steps += stats.steps;
  target.llmMs += stats.llmMs;
  target.toolMs += stats.toolMs;
  target.wallMs += stats.wallMs;
  target.decodeMs += stats.decodeMs;
  target.decodeTokens += stats.decodeTokens;
  return target;
}

function finalizeTokens(tokens) {
  const cacheable = tokens.cacheReadTokens + tokens.uncachedInputTokens;
  tokens.cacheHitRate = cacheable > 0 ? tokens.cacheReadTokens / cacheable : null;
  return tokens;
}

/**
 * 折叠成一份完整报告。
 * @param {ReturnType<typeof normalizeSession>[]} sessions 已经过时间窗筛选
 * @param {{pricing?:object, currency?:string, window?:{kind:string}, now?:number, topN?:number, generatedAt?:number}} options
 */
export function aggregate(sessions, options = {}) {
  const now = numberOr(options.now, Date.now());
  const price = resolvePrice(options.pricing);
  const currency = typeof options.currency === 'string' && options.currency.length > 0
    ? options.currency
    : 'USD';

  const totals = {
    sessions: sessions.length,
    sessionsWithUsage: 0,
    liveSessions: 0,
    tokens: emptyTokenTotals(),
    stats: emptyStats(),
    openSteps: 0,
  };

  const workspaces = new Map();
  const days = new Map();

  for (const session of sessions) {
    if (session.hasUsage) totals.sessionsWithUsage += 1;
    if (session.live) totals.liveSessions += 1;
    totals.openSteps += session.stats.openStep === null ? 0 : 1;
    addTokens(totals.tokens, session.tokens);
    addStats(totals.stats, session.stats);

    const workspaceKey = session.cwd ?? '（未知工作区）';
    if (!workspaces.has(workspaceKey)) {
      workspaces.set(workspaceKey, {
        cwd: session.cwd,
        label: session.workspaceLabel,
        sessions: 0,
        tokens: emptyTokenTotals(),
        stats: emptyStats(),
      });
    }
    const workspace = workspaces.get(workspaceKey);
    workspace.sessions += 1;
    addTokens(workspace.tokens, session.tokens);
    addStats(workspace.stats, session.stats);

    const dayKey = localDayKey(session.createdAt);
    if (!days.has(dayKey)) {
      days.set(dayKey, { day: dayKey, sessions: 0, tokens: emptyTokenTotals() });
    }
    const day = days.get(dayKey);
    day.sessions += 1;
    addTokens(day.tokens, session.tokens);
  }

  finalizeTokens(totals.tokens);
  for (const workspace of workspaces.values()) finalizeTokens(workspace.tokens);
  for (const day of days.values()) finalizeTokens(day.tokens);

  const cost = price === null
    ? { available: false, currency, reason: 'no-price-table' }
    : {
        available: true,
        currency,
        amount: estimateCost(totals.tokens, price),
        // 官方投影缓存不含路由/模型维度，因此全量按同一条价目表估算。
        basis: 'aggregate-single-rate',
        price,
      };

  const byWorkspace = [...workspaces.values()]
    .map((workspace) => ({
      ...workspace,
      cost:
        price === null
          ? null
          : estimateCost(workspace.tokens, price),
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total);

  const byDay = [...days.values()]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .slice(-30);

  const topN = Number.isInteger(options.topN) ? options.topN : 10;
  const topSessions = sessions
    .filter((session) => session.hasUsage)
    .sort((a, b) => b.tokens.total - a.tokens.total)
    .slice(0, topN)
    .map((session) => ({
      id: session.id,
      // `title` 是原值（可能为 null），留给界面做本地化兜底；
      // `displayTitle` 带中文兜底串，供没有 locale 概念的 CLI 直接使用。
      // 两者都给出，是为了不让 Host 侧的显示文案污染到多语言界面。
      title: session.title,
      displayTitle: session.displayTitle,
      workspaceLabel: session.workspaceLabel,
      cwd: session.cwd,
      createdAt: session.createdAt,
      tokens: session.tokens,
      cost: price === null ? null : estimateCost(session.tokens, price),
    }));

  return {
    generatedAt: numberOr(options.generatedAt, now),
    window: { kind: options.window?.kind ?? 'all' },
    currency,
    totals,
    cost,
    byWorkspace,
    byDay,
    topSessions,
  };
}

export { estimateCost, resolvePrice };
