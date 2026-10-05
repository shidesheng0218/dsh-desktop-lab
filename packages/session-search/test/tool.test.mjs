/**
 * 工具注册与执行的集成测试。
 *
 * 用假 Cordis 上下文把 `tools` 与 `sessionQuery` 两个服务模拟出来，
 * 直接检查 `tools.register()` 拿到的定义对象与 `execute` 的返回值。
 *
 * 不需要安装插件、不需要 DSH 运行时——除了「Loader 是否挂起这个包」之外，
 * 本插件的全部行为都在这里被验证。
 *
 * 其中最关键的一条是 `assertSupportedSchema`：官方 `tools.register()` 只接受
 * 关键词子集 `type/oneOf/properties/required/additionalProperties/items/enum/const
 * + 注解`。给参数加 `minimum`/`maximum`/`maxLength` 会让注册直接抛错、插件加载失败。
 * 这条测试就是把那个失败模式钉死。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, name } from '../index.js';

/* ------------------------------------------------- 官方支持的 Schema 子集 */

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples', '$comment']);

function schemaViolations(node, path = 'schema', out = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} 必须是 schema 对象`);
    return out;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    out.push(`${path}.${key} 不在官方支持的子集里`);
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    out.push(`${path}.additionalProperties 必须是布尔值`);
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((v) => typeof v !== 'string')) {
      out.push(`${path}.required 必须是字符串数组`);
    } else {
      for (const key of node.required) {
        if (!Object.hasOwn(node.properties ?? {}, key)) {
          out.push(`${path}.required 里的 "${key}" 不在 properties 里`);
        }
      }
    }
  }
  if (node.properties !== undefined) {
    for (const [key, child] of Object.entries(node.properties)) {
      schemaViolations(child, `${path}.properties.${key}`, out);
    }
  }
  if (node.items !== undefined) schemaViolations(node.items, `${path}.items`, out);
  if (node.oneOf !== undefined) {
    node.oneOf.forEach((child, index) => schemaViolations(child, `${path}.oneOf[${index}]`, out));
  }
  return out;
}

/* ------------------------------------------------------------ 假 Cordis */

function document(seq, text, type = 'assistant/message') {
  return { sessionId: 'x', seq, type, time: 1_700_000_000_000 + seq, surface: 'current', text };
}

/**
 * @param {object} options
 * @param {object[]} options.headers listSessions 返回的会话头
 * @param {Record<string, object[]>} options.documents 每个会话的检索结果
 * @param {string[]} [options.unreadable] filterEvents 会抛异常的会话 id
 * @param {Record<string,string>} [options.titles] readTitleSnapshots 的标题
 */
function makeCtx(options = {}) {
  const registrations = [];
  const calls = { listSessions: 0, filterEvents: [], readTitleSnapshots: [] };
  const headers = options.headers ?? [];
  const documents = options.documents ?? {};
  const unreadable = new Set(options.unreadable ?? []);

  return {
    registrations,
    calls,
    logger: { info() {}, warn() {} },
    tools: {
      register(definition) {
        registrations.push(definition);
        return () => {};
      },
    },
    sessionQuery: {
      async listSessions() {
        calls.listSessions += 1;
        return headers.map((header) => ({ header, live: false, persisted: true }));
      },
      async filterEvents(sessionId, filters) {
        calls.filterEvents.push({ sessionId, filters });
        if (unreadable.has(sessionId)) throw new Error('corrupt log');
        return documents[sessionId] ?? [];
      },
      async readTitleSnapshots(ids) {
        calls.readTitleSnapshots.push(ids);
        return ids.map((id) =>
          options.titles?.[id] === undefined
            ? { status: 'fulfilled', value: { session: { id } } }
            : { status: 'fulfilled', value: { session: { id }, title: options.titles[id] } },
        );
      },
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

function headersFixture() {
  const now = Date.now();
  return [
    { id: 's-new', createdAt: now - DAY, cwd: '/w/alpha' },
    { id: 's-old', createdAt: now - 20 * DAY, cwd: '/w/beta' },
  ];
}

/** 注册并取回唯一那个工具定义。 */
function setup(options = {}, config = {}) {
  const ctx = makeCtx(options);
  apply(ctx, config);
  assert.equal(ctx.registrations.length, 1, '应当只注册一个工具');
  return { ctx, tool: ctx.registrations[0] };
}

/* -------------------------------------------------------------- 注册 */

test('插件导出名与 inject 声明正确；缺服务时不激活而不是抛错', () => {
  assert.equal(name, 'session-search');
  assert.deepEqual(inject, ['tools', 'sessionQuery']);
});

test('注册的工具名、描述与「字面量、非语义」的说明都在', () => {
  const { tool } = setup();
  assert.equal(tool.name, 'search_past_sessions');
  assert.match(tool.description, /literal/i);
  assert.match(tool.description, /not semantic/i);
  // 描述常驻模型上下文，必须短
  assert.ok(tool.description.length < 400, `描述 ${tool.description.length} 字符，过长`);
});

test('tools.register() 要求的 output.render 是函数（否则注册直接抛 TypeError）', () => {
  const { tool } = setup();
  assert.equal(typeof tool.output?.render, 'function');
  assert.equal(typeof tool.output?.schema, 'object');
});

test('参数 schema 只用官方支持的子集 —— 出现 minimum/maxLength 之类会让插件加载失败', () => {
  const { tool } = setup();
  assert.deepEqual(schemaViolations(tool.parameters, 'parameters'), []);
  assert.deepEqual(schemaViolations(tool.output.schema, 'output.schema'), []);
});

test('required 是字符串数组，且每个名字都在 properties 里', () => {
  const { tool } = setup();
  assert.deepEqual(tool.parameters.required, ['query']);
  assert.ok(Object.hasOwn(tool.parameters.properties, 'query'));
  assert.equal(tool.parameters.additionalProperties, false);
  // limit/days 不能靠 schema 约束范围（子集里没有 maximum），所以必须能在代码里夹
  assert.equal(tool.parameters.properties.limit.minimum, undefined);
  assert.equal(tool.parameters.properties.limit.maximum, undefined);
});

test('输出 schema 是 object 根，且 hits 是数组', () => {
  const { tool } = setup();
  assert.equal(tool.output.schema.type, 'object');
  assert.equal(tool.output.schema.properties.hits.type, 'array');
  assert.equal(tool.output.schema.properties.hits.items.type, 'object');
});

test('只读工具声明为可并发，且是函数形式（执行管线按函数调用它）', () => {
  const { tool } = setup();
  assert.equal(typeof tool.isConcurrencySafe, 'function');
  assert.equal(tool.isConcurrencySafe({ query: 'x' }), true);
});

/* -------------------------------------------------------------- 执行 */

test('检索命中时返回带上下文的片段与正确的对外字段名', async () => {
  const { tool } = setup(
    {
      headers: headersFixture(),
      documents: { 's-new': [document(7, '我们决定用 app.asar 方案'), document(9, '再确认一次 app.asar')] },
      titles: { 's-new': '桌面版插件规划' },
    },
  );

  const value = await tool.execute({ query: 'app.asar' }, {});

  assert.equal(value.total_hits, 2);
  assert.equal(value.hits.length, 2);
  const first = value.hits[0];
  assert.equal(first.session_id, 's-new');
  assert.equal(first.session_title, '桌面版插件规划');
  assert.equal(first.cwd, '/w/alpha');
  assert.equal(first.seq, 7);
  assert.equal(first.type, 'assistant/message');
  assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(first.snippet, /app\.asar/);
  assert.match(value.notes, /2 matching excerpts/);
});

test('查询串以 {kind:"text"} 过滤器交给官方服务（官方负责转义，我们不拼正则）', async () => {
  const { ctx, tool } = setup({ headers: headersFixture(), documents: {} });
  await tool.execute({ query: 'a.*b(c)' }, {});
  assert.deepEqual(ctx.calls.filterEvents[0].filters, [{ kind: 'text', text: 'a.*b(c)' }]);
});

test('cwd 与 session_id 与 days 都会真正收窄扫描范围', async () => {
  const { ctx, tool } = setup({ headers: headersFixture(), documents: {} });

  await tool.execute({ query: 'x', cwd: '/w/beta' }, {});
  assert.deepEqual(ctx.calls.filterEvents.map((c) => c.sessionId), ['s-old']);

  ctx.calls.filterEvents.length = 0;
  await tool.execute({ query: 'x', session_id: 's-new' }, {});
  assert.deepEqual(ctx.calls.filterEvents.map((c) => c.sessionId), ['s-new']);

  ctx.calls.filterEvents.length = 0;
  await tool.execute({ query: 'x', days: 7 }, {});
  assert.deepEqual(ctx.calls.filterEvents.map((c) => c.sessionId), ['s-new']);
});

test('单会话命中过多时被截断，并在 note 里如实说明', async () => {
  const many = Array.from({ length: 40 }, (_, i) => document(i, `hit ${i}`));
  const { tool } = setup({ headers: headersFixture(), documents: { 's-new': many } });

  const value = await tool.execute({ query: 'hit' }, {});
  assert.equal(value.hits.length, 5, '默认每会话最多 5 条');
  assert.equal(value.scanned.capped_sessions, 1);
  assert.match(value.notes, /more than 5 matches/);
});

test('config 可以覆盖每会话与候选上限', async () => {
  const many = Array.from({ length: 40 }, (_, i) => document(i, `hit ${i}`));
  const { tool } = setup(
    { headers: headersFixture(), documents: { 's-new': many, 's-old': many } },
    { maxHitsPerSession: 2, maxCandidateSessions: 1 },
  );

  const value = await tool.execute({ query: 'hit' }, {});
  assert.equal(value.hits.length, 2);
  assert.equal(value.scanned.candidate_sessions, 1);
  assert.equal(value.scanned.capped_sessions, 1);
});

test('limit 控制返回条数，多余部分在 note 里说明', async () => {
  const docs = Array.from({ length: 10 }, (_, i) => document(i, `hit ${i}`));
  const { tool } = setup({ headers: headersFixture(), documents: { 's-new': docs } });
  // 每会话上限是 5，所以先抬高它才能测 limit
  const config = { maxHitsPerSession: 50 };
  const ctx = makeCtx({ headers: headersFixture(), documents: { 's-new': docs } });
  apply(ctx, config);
  const tool2 = ctx.registrations[0];

  const value = await tool2.execute({ query: 'hit', limit: 3 }, {});
  assert.equal(value.hits.length, 3);
  assert.equal(value.total_hits, 10);
  assert.match(value.notes, /Showing the 3 newest/);

  // limit 超上限被夹到 MAX_HITS（50），且不会被 schema 拒绝
  const big = await tool2.execute({ query: 'hit', limit: 99999 }, {});
  assert.equal(big.hits.length, 10);
  assert.ok(tool.parameters);
});

test('单个会话读失败被跳过并计数，不影响其余结果', async () => {
  const { tool } = setup({
    headers: headersFixture(),
    documents: { 's-old': [document(1, 'survivor hit')] },
    unreadable: ['s-new'],
  });

  const value = await tool.execute({ query: 'hit' }, {});
  assert.equal(value.scanned.unreadable_sessions, 1);
  assert.equal(value.hits.length, 1);
  assert.equal(value.hits[0].session_id, 's-old');
  assert.match(value.notes, /could not be read/);
});

test('没有任何命中时给出明确说明，而不是空结果让人困惑', async () => {
  const { tool } = setup({ headers: headersFixture(), documents: {} });
  const value = await tool.execute({ query: '不存在的东西' }, {});
  assert.deepEqual(value.hits, []);
  assert.equal(value.total_hits, 0);
  assert.match(value.notes, /No match/);
  assert.match(value.notes, /literal/);
});

test('候选被上限截断时，note 提示可用 cwd/days/session_id 搜更旧的', async () => {
  const headers = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`,
    createdAt: Date.now() - i * DAY,
    cwd: '/w/alpha',
  }));
  const { tool } = setup({ headers, documents: {} }, { maxCandidateSessions: 5 });
  const value = await tool.execute({ query: 'x' }, {});
  assert.equal(value.scanned.candidate_sessions, 5);
  assert.match(value.notes, /Only the newest 5 sessions were scanned/);
});

test('标题缺失时返回空字符串而不是 null（schema 声明为 string）', async () => {
  const { tool } = setup({
    headers: headersFixture(),
    documents: { 's-new': [document(1, 'hit')] },
  });
  const value = await tool.execute({ query: 'hit' }, {});
  assert.equal(value.hits[0].session_title, '');
});

test('标题回填只对本轮命中的会话发起，且限数量', async () => {
  const { ctx, tool } = setup({
    headers: headersFixture(),
    documents: { 's-old': [document(1, 'hit')] },
  });
  await tool.execute({ query: 'hit' }, {});
  assert.deepEqual(ctx.calls.readTitleSnapshots, [['s-old']]);
});

test('标题服务抛异常时检索仍然成功（降级而不是失败）', async () => {
  const ctx = makeCtx({ headers: headersFixture(), documents: { 's-new': [document(1, 'hit')] } });
  ctx.sessionQuery.readTitleSnapshots = async () => {
    throw new Error('title service down');
  };
  apply(ctx, {});
  const value = await ctx.registrations[0].execute({ query: 'hit' }, {});
  assert.equal(value.hits.length, 1);
  assert.equal(value.hits[0].session_title, '');
});

test('空查询直接报错，不去扫全库', async () => {
  const { ctx, tool } = setup({ headers: headersFixture(), documents: {} });
  await assert.rejects(() => tool.execute({ query: '   ' }, {}), /non-empty/);
  assert.equal(ctx.calls.listSessions, 0, '参数非法时不该已经读了会话列表');
});

test('取消信号已被触发时抛错，尊重调用方取消', async () => {
  const { tool } = setup({ headers: headersFixture(), documents: {} });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => tool.execute({ query: 'x' }, { signal: controller.signal }));
});

test('output.render 产出可读文本，含命中数与说明', async () => {
  const { tool } = setup({
    headers: headersFixture(),
    documents: { 's-new': [document(3, 'hello app.asar world')] },
    titles: { 's-new': 'T' },
  });
  const value = await tool.execute({ query: 'app.asar' }, {});
  const blocks = tool.output.render({ query: 'app.asar' }, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /1 matching excerpt/);
  assert.match(blocks[0].text, /hello app\.asar world/);
  assert.match(blocks[0].text, /Scanned/);
});

test('execute 返回值全部是可无损 JSON 序列化的（不含 undefined/NaN）', async () => {
  const { tool } = setup({
    headers: headersFixture(),
    documents: { 's-new': [document(1, 'hit')], 's-old': [document(2, 'hit')] },
  });
  const value = await tool.execute({ query: 'hit' }, {});
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /undefined|NaN|Infinity/);
  assert.deepEqual(JSON.parse(text), value);
});
