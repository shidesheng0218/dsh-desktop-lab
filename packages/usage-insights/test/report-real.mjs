#!/usr/bin/env node
/**
 * 用本机真实的投影缓存跑一遍聚合，把报告打到终端。
 *
 * 两个作用：
 *  1. 让聚合核心在**真实数据**上被验证，而不是只在合成夹具上自证。
 *  2. 即使插件没装进 GUI，这个脚本本身就能给出跨会话用量结论。
 *
 * 它刻意不依赖任何 DSH 包：直接读
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
 * 这个官方 `session_projcache` 域在 json 后端下的 `per-record` 布局。
 * 插件 Host 半边走的是同一份数据的服务接口
 * （sessionQuery.listSessions + sessionProjectionCache.cachedSnapshot），
 * 两者结果应当一致——可用 `--compare` 思路人工核对。
 *
 * 用法：
 *   node test/report-real.mjs [--window 24h|7d|30d|all] [--top 10]
 *                             [--pricing '{"default":{"input":1,"output":2,"cacheRead":0.1}}']
 *                             [--currency CNY]
 *                             [--format text|json|csv] [--table summary|workspace|daily|sessions]
 *                             [--out <文件>]
 *
 *   --json 是 `--format json` 的别名，保留历史用法。
 *   JSON 与插件面板出自同一份 lib/report.js，字段契约见 docs/report-schema.md。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeSession } from '../lib/core.js';
import { buildReport } from '../lib/report.js';
import { toCsv } from '../lib/export.js';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else {
        options[key] = next;
        i += 1;
      }
    }
  }
  return options;
}

export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/**
 * 读取投影缓存目录，转成聚合核心要的形状。
 *
 * 磁盘上是 `{ version, record: { identity, rows: { key: {ver, seq, val} } } }`，
 * 而服务接口 `cachedSnapshot()` 返回的是**解包后**的 `values: { key: val }`。
 * 这里做同样的解包，让两条路径喂给核心的数据一致。
 */
export function readProjectionCache(root) {
  const dir = path.join(root, 'storages', 'session_projcache', 'sessions');
  if (!fs.existsSync(dir)) return { sessions: [], dir, skipped: 0 };

  const sessions = [];
  let skipped = 0;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(dir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      skipped += 1;
      continue;
    }
    const record = parsed?.record;
    if (record === null || typeof record !== 'object') {
      skipped += 1;
      continue;
    }
    const rows = record.rows ?? {};
    const values = {};
    for (const [key, row] of Object.entries(rows)) {
      if (row !== null && typeof row === 'object' && 'val' in row) values[key] = row.val;
    }
    sessions.push({
      header: { id: file.replace(/\.json$/, ''), ...(record.identity ?? {}) },
      values,
      // 缓存里没有 liveness 信息，脚本一律按非 live 呈现。
      live: false,
    });
  }

  return { sessions, dir, skipped };
}

function formatTokens(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms === 0) return '—';
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatPercent(ratio) {
  return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : '—';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = resolveDshHome();
  const { sessions: raw, dir, skipped } = readProjectionCache(home);

  if (raw.length === 0) {
    process.stderr.write(
      `没有在 ${dir} 找到任何投影缓存。\n` +
        '说明：该目录由 dsh-session-projection-cache 在会话产生 checkpoint 后写入；\n' +
        '全新的安装或从未对话过的环境里它是空的。先正常用一次 DSH 桌面版再来。\n',
    );
    process.exitCode = 1;
    return;
  }

  const normalized = raw.map(normalizeSession);

  let pricing;
  if (typeof options.pricing === 'string') {
    try {
      pricing = JSON.parse(options.pricing);
    } catch (error) {
      process.stderr.write(`--pricing 不是合法 JSON：${error.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // 格式协商：`--json` 是 `--format json` 的别名（历史用法，保留）。
  const format = typeof options.format === 'string' ? options.format : options.json ? 'json' : 'text';
  if (!['json', 'csv', 'text'].includes(format)) {
    process.stderr.write(`未知的 --format "${format}"；可用：text, json, csv\n`);
    process.exitCode = 1;
    return;
  }
  const table = typeof options.table === 'string' ? options.table : 'summary';

  // 折叠交给与 Host 半边共用的实现（lib/report.js），
  // 这样 CLI 与插件面板不可能算出两个不同的数字。
  const report = buildReport(normalized, {
    window: typeof options.window === 'string' ? options.window : 'all',
    pricing,
    currency: typeof options.currency === 'string' ? options.currency : 'CNY',
    topN: Number(options.top ?? 10),
    // CSV 的 sessions 表要全量明细；JSON 保持精简，不无谓放大面板负载。
    includeSessions: format === 'csv' && table === 'sessions',
  });
  report.coverage.skippedFiles = skipped;

  if (format === 'csv') {
    const csv = toCsv(report, table);
    if (typeof options.out === 'string') {
      fs.writeFileSync(options.out, csv);
      const bytes = Buffer.byteLength(csv, 'utf8');
      process.stderr.write(`已写入 ${options.out}（${bytes} 字节，表 ${table}）\n`);
    } else {
      process.stdout.write(csv);
    }
    return;
  }

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ home, dir, skipped, report }, null, 2)}\n`);
    return;
  }

  const t = report.totals;
  const lines = [
    `DSH home        ${home}`,
    `缓存目录        ${dir}`,
    `时间窗          ${report.window.kind}（按会话创建时间）`,
    skipped > 0 ? `跳过损坏文件    ${skipped}` : null,
    '',
    `会话            ${t.sessions} 个（有用量 ${t.sessionsWithUsage}，其中 live ${t.liveSessions}）`,
    `Token 合计      ${formatTokens(t.tokens.total)}`,
    `  未缓存输入    ${formatTokens(t.tokens.uncachedInputTokens)}`,
    `  缓存读取      ${formatTokens(t.tokens.cacheReadTokens)}`,
    `  缓存写入      ${formatTokens(t.tokens.cacheWriteTokens)}`,
    `  输出          ${formatTokens(t.tokens.outputTokens)}`,
    `  缓存命中率    ${formatPercent(t.tokens.cacheHitRate)}`,
    '',
    `轮次/步数       ${t.stats.turns} / ${t.stats.steps}`,
    `模型耗时        ${formatMs(t.stats.llmMs)}`,
    `工具耗时        ${formatMs(t.stats.toolMs)}`,
    '',
    report.cost.available
      ? `估算成本        ${report.currency} ${report.cost.amount.toFixed(4)}  （按你给的价目表估算，非账单）`
      : `估算成本        未配置价目表（官方不提供任何价格数据；用 --pricing 传入）`,
    '',
    '按工作区：',
  ].filter((line) => line !== null);

  for (const workspace of report.byWorkspace.slice(0, 8)) {
    lines.push(
      `  ${workspace.label.padEnd(24)} ${String(workspace.sessions).padStart(3)} 会话  ` +
        `${formatTokens(workspace.tokens.total).padStart(8)} tokens  命中率 ${formatPercent(workspace.tokens.cacheHitRate)}`,
    );
  }

  lines.push('', '按天（最近 14 天）：');
  for (const day of report.byDay.slice(-14)) {
    lines.push(
      `  ${day.day}  ${String(day.sessions).padStart(3)} 会话  ${formatTokens(day.tokens.total).padStart(8)} tokens`,
    );
  }

  lines.push('', 'Top 会话：');
  for (const session of report.topSessions) {
    lines.push(
      `  ${formatTokens(session.tokens.total).padStart(8)}  ${session.workspaceLabel.padEnd(20)} ${session.displayTitle.slice(0, 40)}`,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

// 仅在被直接执行时运行，便于测试里 import 其中的读取函数。
// 注意用 pathToFileURL 而不是拼字符串：工程路径含中文时，import.meta.url
// 是百分号编码的，直接比较会永远为假（本脚本第一版就栽在这里）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
