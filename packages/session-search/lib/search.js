/**
 * 历史检索的纯逻辑：候选筛选、片段截取、结果装配。
 *
 * 本文件不 import 任何 DSH 包，也不碰网络与文件系统——插件里真正容易出错的
 * 部分（边界、截断、排序、Unicode）全部落在这里，可用真实形状的夹具直接单测。
 * `index.js` 只剩「调官方服务取数 + 把结果喂给这里的函数」。
 *
 * 为什么必须有上限：官方 `filterEvents()` 内部是 `_corpus.load(sessionId)`，
 * **会读整个会话日志**。不加闸门的话，一次工具调用就会把全库的日志扫一遍——
 * 对用户是几秒到几十秒的卡顿，对模型是一个可能超时的工具。
 */

/** 各处硬上限。宁可少给结果并如实说明，也不要无界扫描。 */
export const LIMITS = Object.freeze({
  /** 最多扫描多少个候选会话。listSessions 是「最新在前」，所以这个上限等于「只看最近 N 个会话」。 */
  MAX_CANDIDATE_SESSIONS: 40,
  /** 单次调用最多返回多少条命中。 */
  MAX_HITS: 50,
  /** 模型不传 limit 时的默认条数。 */
  DEFAULT_LIMIT: 10,
  /** 每条命中摘要的最大字符数。 */
  MAX_SNIPPET_CHARS: 240,
  /** 单个会话最多取多少条命中。像 "the" 这种词会让一个会话命中成千上万次。 */
  MAX_HITS_PER_SESSION: 5,
  /** 最多为多少个命中会话回填标题。 */
  MAX_TITLE_LOOKUPS: 10,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 从会话头里挑候选。
 *
 * 输入来自 `ctx.sessionQuery.listSessions()`，官方保证「最新在前」；
 * 这里仍重新排序一次，因为「最新在前」是那个方法的实现细节，
 * 而本函数的截断语义（丢掉最旧的）依赖这个顺序。
 *
 * @param {{id:string, createdAt?:number, cwd?:string}[]} headers
 * @param {{cwd?:string, days?:number, sessionId?:string, now?:number, max?:number}} options
 * @returns {{candidates:object[], matched:number, truncated:boolean}}
 */
export function selectCandidates(headers, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : LIMITS.MAX_CANDIDATE_SESSIONS;

  let matched = headers.filter((header) => header !== null && typeof header === 'object');

  if (typeof options.sessionId === 'string' && options.sessionId.length > 0) {
    matched = matched.filter((header) => header.id === options.sessionId);
  }
  if (typeof options.cwd === 'string' && options.cwd.length > 0) {
    matched = matched.filter((header) => header.cwd === options.cwd);
  }
  if (Number.isInteger(options.days) && options.days > 0) {
    const since = now - options.days * MS_PER_DAY;
    matched = matched.filter((header) => Number.isFinite(header.createdAt) && header.createdAt >= since);
  }

  const sorted = [...matched].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );

  return {
    candidates: sorted.slice(0, max),
    matched: sorted.length,
    truncated: sorted.length > max,
  };
}

/**
 * 在文档文本里定位关键词，截取一段上下文。
 *
 * 匹配方式与官方一致：**大小写不敏感的字面量**（官方在 filterEvents 内部把
 * query 编译成转义后的 Unicode 感知正则，本函数复刻这个语义以保证
 * 「官方说命中了，但摘要里找不到关键词」不会发生）。
 *
 * 截断按**码点**而非 UTF-16 码元，因此不会切碎代理对（emoji、部分汉字扩展区）。
 * 这不等于按字素簇切分，组合字符仍可能被切开——这是有意的取舍：
 * 引入字素簇分段要带来一个不小的表，而收益只是摘要边界更整齐。
 *
 * @param {string} text 文档全文
 * @param {string} query 关键词
 * @param {number} [max] 摘要最大码点数
 * @returns {string}
 */
export function makeSnippet(text, query, max = LIMITS.MAX_SNIPPET_CHARS) {
  const source = typeof text === 'string' ? text : '';
  const points = [...source];
  if (points.length === 0) return '';

  const needle = (typeof query === 'string' ? query : '').trim();
  const pattern = needle.length === 0
    ? null
    : new RegExp(
        needle
          .split(/\s+/u)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
          .join('\\s+'),
        'iu',
      );
  const match = pattern?.exec(source) ?? null;

  if (match === null) {
    // 没定位到（理论上不该发生：官方已判定命中）时退回开头截断，
    // 而不是返回空串——空摘要会让人以为「命中了但没内容」。
    return points.length <= max ? source : `${points.slice(0, max).join('')}…`;
  }

  // 把 UTF-16 下标换算成码点下标，后续切割统一按码点走。
  const matchPoint = [...source.slice(0, match.index)].length;
  const matchLength = [...match[0]].length;

  if (points.length <= max) return source;

  // 长查询只保留其开头 max 个码点；普通查询尽量居中并保证完整命中。
  let start = matchLength >= max
    ? matchPoint
    : Math.max(0, matchPoint - Math.floor((max - matchLength) / 2));
  start = Math.min(start, points.length - max);
  const end = start + max;

  const head = start > 0 ? '…' : '';
  const tail = end < points.length ? '…' : '';
  return `${head}${points.slice(start, end).join('')}${tail}`;
}

/**
 * 装配工具返回值：排序、截断、生成给模型看的说明。
 *
 * 排序是「会话从新到旧，同一会话内 seq 升序」——符合人回忆事情的顺序：
 * 先找回什么时候聊过，再顺着当时的顺序看下去。
 *
 * @param {object[]} hits 原始命中
 * @param {{limit?:number, maxHitsPerSession?:number, scanned?:object, truncated?:boolean, skipped?:object[]}} options
 */
export function assembleResult(hits, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, LIMITS.MAX_HITS)
    : LIMITS.DEFAULT_LIMIT;
  const maxHitsPerSession = Number.isInteger(options.maxHitsPerSession) && options.maxHitsPerSession > 0
    ? options.maxHitsPerSession
    : LIMITS.MAX_HITS_PER_SESSION;

  const sorted = [...hits].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });

  const visible = sorted.slice(0, limit);
  const scanned = {
    candidateSessions: options.scanned?.candidateSessions ?? 0,
    scannedSessions: options.scanned?.scannedSessions ?? 0,
    matchedSessions: options.scanned?.matchedSessions ?? 0,
    unreadableSessions: options.scanned?.unreadableSessions ?? 0,
    cappedSessions: options.scanned?.cappedSessions ?? 0,
  };

  // 说明是给模型看的，必须如实：它据此决定要不要收窄条件再来一次。
  const notes = [];
  notes.push(
    `Scanned ${scanned.scannedSessions} of ${scanned.candidateSessions} candidate sessions ` +
      `(${scanned.matchedSessions} had matches); ${sorted.length} matching excerpts.`,
  );
  if (visible.length < sorted.length) {
    notes.push(`Showing the ${visible.length} newest; raise \`limit\` (max ${LIMITS.MAX_HITS}) for more.`);
  }
  if (scanned.cappedSessions > 0) {
    notes.push(
      `${scanned.cappedSessions} session(s) had more than ${maxHitsPerSession} matches; ` +
        'only the first few from each are listed. Use `session_id` to narrow the scan to one session.',
    );
  }
  if (options.truncated === true) {
    notes.push(
      `Only the newest ${scanned.candidateSessions} sessions were scanned. ` +
        'Narrow with `cwd`, `days`, or `session_id` to search older ones.',
    );
  }
  if (scanned.unreadableSessions > 0) {
    notes.push(`${scanned.unreadableSessions} session(s) could not be read and were skipped.`);
  }
  if (sorted.length === 0) {
    notes.push('No match. The search is a literal (case-insensitive) match, not a semantic one.');
  }

  return {
    hits: visible,
    totalHits: sorted.length,
    scanned,
    notes: notes.join(' '),
  };
}
