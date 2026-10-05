/**
 * 历史检索纯逻辑的单元测试。
 *
 * 这里覆盖的是插件里真正容易出错的部分：候选截断语义、Unicode 边界、
 * 排序与「如实说明」的 note 文案。全部不需要 DSH 运行时。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS, assembleResult, makeSnippet, selectCandidates } from '../lib/search.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

function header(id, createdAt, cwd = '/w/a') {
  return { id, createdAt, cwd };
}

/* ------------------------------------------------------------ 候选筛选 */

test('候选取「最新在前」，即使输入顺序是乱的', () => {
  const { candidates } = selectCandidates(
    [header('old', NOW - 10 * DAY), header('new', NOW - DAY), header('mid', NOW - 5 * DAY)],
    { now: NOW },
  );
  assert.deepEqual(candidates.map((c) => c.id), ['new', 'mid', 'old']);
});

test('按 cwd 精确匹配收窄', () => {
  const headers = [header('a', NOW, '/w/alpha'), header('b', NOW, '/w/beta')];
  assert.deepEqual(selectCandidates(headers, { cwd: '/w/beta' }).candidates.map((c) => c.id), ['b']);
  // 前缀不算命中：必须是精确相等，否则 /w/a 会误伤 /w/abc
  assert.equal(selectCandidates(headers, { cwd: '/w/al' }).candidates.length, 0);
});

test('按 sessionId 收窄到唯一一个', () => {
  const headers = [header('a', NOW), header('b', NOW)];
  const { candidates, matched } = selectCandidates(headers, { sessionId: 'b' });
  assert.deepEqual(candidates.map((c) => c.id), ['b']);
  assert.equal(matched, 1);
});

test('按 days 过滤，边界取「大于等于」', () => {
  const headers = [header('edge', NOW - 7 * DAY), header('older', NOW - 7 * DAY - 1)];
  const { candidates } = selectCandidates(headers, { days: 7, now: NOW });
  assert.deepEqual(candidates.map((c) => c.id), ['edge']);
});

test('days 为非正数或非整数时视为不筛选', () => {
  const headers = [header('a', NOW - 100 * DAY)];
  for (const days of [0, -1, 1.5, undefined, null, 'x']) {
    assert.equal(selectCandidates(headers, { days, now: NOW }).candidates.length, 1, String(days));
  }
});

test('封顶时保留最新的，并如实报告 truncated 与封顶前的匹配总数', () => {
  const headers = Array.from({ length: 10 }, (_, i) => header(`s${i}`, NOW - i * DAY));
  const { candidates, matched, truncated } = selectCandidates(headers, { max: 3, now: NOW });
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((c) => c.id), ['s0', 's1', 's2']);
  assert.equal(matched, 10, 'matched 应是封顶前的数量，否则 note 会撒谎');
  assert.equal(truncated, true);
});

test('未超上限时 truncated 为 false', () => {
  const { truncated, matched } = selectCandidates([header('a', NOW)], { max: 5, now: NOW });
  assert.equal(truncated, false);
  assert.equal(matched, 1);
});

test('没有 createdAt 的会话排到最后而不是让排序崩掉', () => {
  const { candidates } = selectCandidates(
    [header('noTime', undefined), header('hasTime', NOW)],
    { now: NOW },
  );
  assert.deepEqual(candidates.map((c) => c.id), ['hasTime', 'noTime']);
});

test('空输入与垃圾输入都不抛', () => {
  assert.deepEqual(selectCandidates([], {}).candidates, []);
  const { candidates } = selectCandidates([null, undefined, 42, header('ok', NOW)], { now: NOW });
  assert.deepEqual(candidates.map((c) => c.id), ['ok']);
});

/* ---------------------------------------------------------------- 摘要 */

/** 判断字符串里有没有落单的代理码元（截断切碎 emoji 的特征）。 */
function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('短文本原样返回，不加省略号', () => {
  assert.equal(makeSnippet('hello world', 'world', 100), 'hello world');
});

test('命中在开头时不加前导省略号', () => {
  const text = 'KEYWORD' + 'x'.repeat(500);
  const snippet = makeSnippet(text, 'KEYWORD', 50);
  assert.ok(snippet.startsWith('KEYWORD'));
  assert.ok(snippet.endsWith('…'));
});

test('命中在结尾时不加尾随省略号', () => {
  const text = 'x'.repeat(500) + 'KEYWORD';
  const snippet = makeSnippet(text, 'KEYWORD', 50);
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('KEYWORD'));
});

test('命中在中间时两侧都有省略号，且关键词落在窗口内', () => {
  const text = 'x'.repeat(500) + 'KEYWORD' + 'y'.repeat(500);
  const snippet = makeSnippet(text, 'KEYWORD', 60);
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.ok(snippet.includes('KEYWORD'), '关键词被截掉了，摘要就没用了');
  // 按码点数除省略号外不超过上限
  assert.ok([...snippet.replace(/…/g, '')].length <= 60);
});

test('匹配大小写不敏感，且保留原文大小写', () => {
  const text = 'x'.repeat(200) + 'KeyWord' + 'y'.repeat(200);
  const snippet = makeSnippet(text, 'keyword', 40);
  assert.ok(snippet.includes('KeyWord'), '应保留原文而不是替换成查询串');
});

test('没命中时退回开头截断，而不是返回空串', () => {
  const snippet = makeSnippet('a'.repeat(100), 'nomatch', 20);
  assert.equal(snippet, `${'a'.repeat(20)}…`);
});

test('空文本与空查询都不抛', () => {
  assert.equal(makeSnippet('', 'x', 10), '');
  assert.equal(makeSnippet(null, 'x', 10), '');
  assert.equal(makeSnippet('hello', '', 10), 'hello');
  assert.equal(makeSnippet('a'.repeat(100), '', 10), `${'a'.repeat(10)}…`);
});

test('截断按码点走，不会切碎代理对（emoji）', () => {
  const text = '😀'.repeat(300);
  for (const max of [1, 2, 3, 7, 41, 99]) {
    const snippet = makeSnippet(text, '😀', max);
    assert.ok(!hasLoneSurrogate(snippet), `max=${max} 时切出了落单代理码元：${JSON.stringify(snippet)}`);
  }
});

test('中文与 emoji 混排时同样不切碎', () => {
  const text = `${'会话历史'.repeat(80)}🎯${'尾部'.repeat(80)}`;
  const snippet = makeSnippet(text, '🎯', 37);
  assert.ok(!hasLoneSurrogate(snippet));
  assert.ok(snippet.includes('🎯'));
});

/* ------------------------------------------------------------ 结果装配 */

function hit(overrides = {}) {
  return {
    sessionId: 's1',
    sessionTitle: null,
    cwd: '/w/a',
    createdAt: NOW,
    seq: 1,
    type: 'assistant/message',
    snippet: 'text',
    ...overrides,
  };
}

test('排序：会话从新到旧，同一会话内 seq 升序', () => {
  const result = assembleResult([
    hit({ sessionId: 'old', createdAt: NOW - DAY, seq: 5 }),
    hit({ sessionId: 'new', createdAt: NOW, seq: 9 }),
    hit({ sessionId: 'new', createdAt: NOW, seq: 3 }),
  ]);
  assert.deepEqual(
    result.hits.map((h) => `${h.sessionId}:${h.seq}`),
    ['new:3', 'new:9', 'old:5'],
  );
});

test('limit 生效，且 note 说明还有更多', () => {
  const hits = Array.from({ length: 30 }, (_, i) => hit({ seq: i }));
  const result = assembleResult(hits, { limit: 5 });
  assert.equal(result.hits.length, 5);
  assert.equal(result.totalHits, 30);
  assert.match(result.notes, /Showing the 5 newest/);
});

test('limit 默认 10，超过上限被夹到 MAX_HITS', () => {
  const hits = Array.from({ length: 120 }, (_, i) => hit({ seq: i }));
  assert.equal(assembleResult(hits, {}).hits.length, LIMITS.DEFAULT_LIMIT);
  assert.equal(assembleResult(hits, { limit: 9999 }).hits.length, LIMITS.MAX_HITS);
  assert.equal(assembleResult(hits, { limit: 0 }).hits.length, LIMITS.DEFAULT_LIMIT);
  assert.equal(assembleResult(hits, { limit: -3 }).hits.length, LIMITS.DEFAULT_LIMIT);
});

test('note 如实报告扫描量 —— 模型靠它决定要不要收窄条件', () => {
  const result = assembleResult([hit()], {
    limit: 10,
    scanned: { candidateSessions: 40, scannedSessions: 12, matchedSessions: 3 },
  });
  assert.match(result.notes, /Scanned 12 of 40 candidate sessions/);
  assert.match(result.notes, /3 had matches/);
});

test('候选被截断时 note 明确提示可以用 cwd/days/session_id 收窄', () => {
  const result = assembleResult([hit()], { truncated: true, scanned: { candidateSessions: 40 } });
  assert.match(result.notes, /Only the newest 40 sessions were scanned/);
  assert.match(result.notes, /cwd/);
});

test('单会话命中过多时如实说明，并指出可用 session_id 看全', () => {
  const result = assembleResult([hit()], { scanned: { cappedSessions: 2 } });
  assert.match(result.notes, /more than 5 matches/);
  assert.match(result.notes, /session_id/);
});

test('不可读会话数与零命中都有明确说明', () => {
  const withUnreadable = assembleResult([hit()], { scanned: { unreadableSessions: 2 } });
  assert.match(withUnreadable.notes, /2 session\(s\) could not be read/);

  const empty = assembleResult([], {});
  assert.equal(empty.hits.length, 0);
  assert.equal(empty.totalHits, 0);
  assert.match(empty.notes, /No match/);
  assert.match(empty.notes, /literal \(case-insensitive\)/);
});

test('装配不改动传入的命中对象（避免调用方数据被就地污染）', () => {
  const original = hit({ sessionId: 'a', seq: 1 });
  const input = [{ ...original }];
  assembleResult(input, {});
  assert.deepEqual(input[0], original);
});
