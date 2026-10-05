/**
 * Client 半边的契约测试。
 *
 * 为什么值得为此写一个假浏览器环境：官方文档明确警告「抛异常的组件会直接让
 * 整个 slot 变成空白」（console: `slot entry crashed in '<slot>'`）。而浏览器
 * 半边的错误在装机之前完全不可见。这里用一个极简 hook 运行时真的执行
 * client.js，验证：
 *   - 工厂 id 与包名一致
 *   - 注册的 slot 名称、id / key 与官方 shipped 代码的用法一致
 *   - 加载态与成功态都能渲染出内容，且渲染路径不抛异常
 *
 * 覆盖不到：真实 React 的渲染结果、CSS 令牌是否生效、面板在 GUI 里的样子。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.resolve(HERE, '..', 'client.js');
const PACKAGE_NAME = '@local/dsh-usage-insights';

/* ------------------------------------------------------------ 假 React */

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/**
 * 支持 createElement / useState / useCallback / useEffect 的最小运行时。
 * 元素形状为 { type, props, children }，便于直接遍历断言。
 */
function createReact() {
  let hooks = [];
  let cursor = 0;
  let pendingEffects = [];

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      };
    },
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [
        hooks[index],
        (next) => {
          hooks[index] = typeof next === 'function' ? next(hooks[index]) : next;
        },
      ];
    },
    useCallback(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previous = hooks[index];
      if (previous === undefined || !sameDeps(previous.deps, deps)) hooks[index] = { fn, deps };
      return hooks[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor;
      cursor += 1;
      const previous = hooks[index];
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        hooks[index] = { deps };
        pendingEffects.push(fn);
      }
    },
  };

  return {
    React,
    beginRender() {
      cursor = 0;
      pendingEffects = [];
    },
    takeEffects() {
      const effects = pendingEffects;
      pendingEffects = [];
      return effects;
    },
  };
}

/* ------------------------------------------------------- 加载 client.js */

function loadClientModule() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  let captured = null;

  const window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  };

  // 用 Function 构造器隔离作用域，并把 window 注入进去。
  const run = new Function('window', `${source}\n//# sourceURL=usage-insights-client.js`);
  run(window);

  assert.ok(captured !== null, 'client.js 必须调用 window.__ModuleLoader__.load(...)');
  return captured;
}

function instantiate(runtime) {
  const definition = loadClientModule();
  const req = (name) => {
    if (name === 'react') return runtime.React;
    throw new Error(`client.js 只允许 require React，但它请求了 ${name}`);
  };
  return { definition, module: definition.factory(req) };
}

/** 注册一个只记录调用的假 slots 服务。 */
function makeSlotsContext() {
  const injections = [];
  const registrations = [];
  return {
    injections,
    registrations,
    slots: {
      inject(owner, callback) {
        injections.push(owner);
        callback();
      },
      register(spec, component) {
        registrations.push({ spec, component });
        return () => {};
      },
    },
  };
}

/** 递归收集元素树里出现的所有字符串。 */
function collectStrings(node, out = [], depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (depth > 20) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out, depth);
    return out;
  }
  if (typeof node.type === 'function') {
    collectStrings(node.type(node.props), out, depth + 1);
    return out;
  }
  const { children, ...rest } = node.props ?? {};
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'style' || typeof value === 'function') continue;
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  }
  if (typeof children === 'string' || typeof children === 'number') out.push(String(children));
  else if (Array.isArray(children)) for (const child of children) collectStrings(child, out, depth);
  for (const child of node.children ?? []) collectStrings(child, out, depth);
  return out;
}

/** 递归收集所有元素节点，便于按 type 查找。 */
function collectElements(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  out.push(node);
  for (const child of node.children ?? []) collectElements(child, out);
  return out;
}

/**
 * 展开元素树：把无状态函数组件真的调用掉，返回所有最终节点的列表。
 *
 * 断言必须打在展开后的节点上。早期版本只做字符串正则匹配，
 * 结果「未配置」这条断言被页脚文案意外满足——把卡片值改成 0 元也能通过。
 * 变异测试暴露了这一点，所以这里改成按节点属性精确断言。
 */
function expandTree(node, out = [], depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 20) return out;
  if (Array.isArray(node)) {
    for (const child of node) expandTree(child, out, depth);
    return out;
  }
  if (typeof node.type === 'function') {
    // 先把组件节点本身记下来（它的 props 才是调用方真正的意图，
    // 例如 Stat 的 {label, value}），再展开成它渲染出来的内容。
    out.push({ type: node.type, props: node.props, isComponent: true });
    expandTree(node.type(node.props), out, depth + 1);
    return out;
  }
  out.push(node);
  const { children } = node.props ?? {};
  if (Array.isArray(children)) for (const child of children) expandTree(child, out, depth);
  for (const child of node.children ?? []) expandTree(child, out, depth);
  return out;
}

/** 找出所有形如 { label, value } 的统计卡片节点。 */
function statCards(tree) {
  return expandTree(tree).filter(
    (node) => typeof node.props?.label === 'string' && node.props.label.length > 0 && 'value' in (node.props ?? {}),
  );
}

/* ------------------------------------------------------------------ 用例 */

test('工厂 id 必须等于包名（否则宿主找不到这个模块）', () => {
  const runtime = createReact();
  const { definition } = instantiate(runtime);
  assert.equal(definition.id, PACKAGE_NAME);
  assert.equal(typeof definition.factory, 'function');
});

test('模块只注入 slots，并按官方两段式注册 sidebar.panellist 与 main', () => {
  const runtime = createReact();
  const { module } = instantiate(runtime);
  assert.deepEqual(module.inject, ['slots']);

  const ctx = makeSlotsContext();
  module.apply(ctx);

  assert.deepEqual(ctx.injections, ['sidebar.panellist', 'main']);
  assert.equal(ctx.registrations.length, 2);

  const [icon, panel] = ctx.registrations;
  assert.equal(icon.spec.name, 'sidebar.panellist');
  assert.equal(icon.spec.id, 'usage-insights');
  assert.equal(typeof icon.spec.label, 'function');
  assert.equal(icon.spec.label(), '会话用量与成本');
  assert.equal(typeof icon.spec.order, 'number');

  // main 是 keyed slot：key 必须与 panellist 的 id 完全相等，
  // 否则侧栏点了图标也打不开面板。
  assert.equal(panel.spec.name, 'main');
  assert.equal(panel.spec.key, icon.spec.id);
});

test('图标组件渲染出 SVG 且尺寸跟随传入的 size', () => {
  const runtime = createReact();
  const { module } = instantiate(runtime);
  const ctx = makeSlotsContext();
  module.apply(ctx);
  const [icon] = ctx.registrations;

  const small = icon.component({ size: 16 });
  assert.equal(small.type, 'svg');
  assert.equal(small.props.width, 16);
  assert.equal(small.props.height, 16);

  const large = icon.component({ size: 24 });
  assert.equal(large.props.width, 24);

  // 不带 props 时也必须能渲染（宿主可能不传 size）
  const bare = icon.component({});
  assert.equal(bare.type, 'svg');
  assert.ok(Number.isFinite(bare.props.width));
});

test('面板首帧渲染加载态，不抛异常', async () => {
  const runtime = createReact();
  const { module } = instantiate(runtime);
  const ctx = makeSlotsContext();
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  runtime.beginRender();
  const tree = panel.component({});
  const strings = collectStrings(tree);
  assert.ok(
    strings.some((s) => s.includes('正在汇总会话数据')),
    `首帧应当显示加载态，实际内容：${JSON.stringify(strings.slice(0, 10))}`,
  );
});

test('取数成功后渲染出各项指标，且金额随价目表状态变化', async () => {
  const runtime = createReact();
  const { module } = instantiate(runtime);
  const ctx = makeSlotsContext();
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const report = {
    generatedAt: Date.now(),
    window: { kind: 'all' },
    currency: 'CNY',
    totals: {
      sessions: 3,
      sessionsWithUsage: 2,
      liveSessions: 1,
      tokens: {
        uncachedInputTokens: 1_300_000,
        outputTokens: 600_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 0,
        billableInput: 3_300_000,
        total: 3_900_000,
        cacheHitRate: 2_000_000 / 3_300_000,
      },
      stats: { turns: 5, steps: 20, llmMs: 60_000, toolMs: 30_000, wallMs: 90_000 },
      openSteps: 0,
    },
    cost: { available: false, currency: 'CNY', reason: 'no-price-table' },
    byWorkspace: [
      {
        cwd: '/Users/example/project-alpha',
        label: 'project-alpha',
        sessions: 3,
        tokens: { total: 3_900_000, cacheHitRate: 2_000_000 / 3_300_000 },
        stats: {},
        cost: null,
      },
    ],
    byDay: [
      { day: '2026-10-05', sessions: 3, tokens: { total: 3_900_000, cacheHitRate: null } },
    ],
    topSessions: [
      {
        id: 's1',
        title: '一个测试会话',
        workspaceLabel: 'project-alpha',
        createdAt: Date.now(),
        tokens: { total: 3_500_000 },
        cost: null,
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, report }) });

  try {
    runtime.beginRender();
    panel.component({});
    const effects = runtime.takeEffects();
    for (const effect of effects) effect();
    await new Promise((resolve) => setImmediate(resolve));

    runtime.beginRender();
    const tree = panel.component({});
    const strings = collectStrings(tree).join(' | ');

    assert.match(strings, /3\.90M/, '应当显示 Token 总量');
    assert.match(strings, /60\.6%/, '应当显示缓存命中率');
    assert.match(strings, /project-alpha/, '应当显示工作区分组');
    assert.match(strings, /一个测试会话/, '应当显示 Top 会话标题');

    // 精确断言成本卡片本身的值，而不是全文正则：
    // 页脚里也含「未配置价目表」字样，用正则会让卡片值退化成 0 元也能通过。
    const cards = statCards(tree);
    const costCard = cards.find((card) => card.props.label === '估算成本');
    assert.ok(costCard, '必须存在「估算成本」卡片');
    assert.equal(costCard.props.value, '未配置', '没有价目表时卡片值必须是「未配置」');
    assert.equal(costCard.props.tone, 'muted');

    const tokenCard = cards.find((card) => card.props.label === 'Token 总量');
    assert.equal(tokenCard.props.value, '3.90M');

    const cacheCard = cards.find((card) => card.props.label === '缓存命中率');
    assert.equal(cacheCard.props.value, '60.6%');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('取数失败时渲染错误态并可重试，不抛异常', async () => {
  const runtime = createReact();
  const { module } = instantiate(runtime);
  const ctx = makeSlotsContext();
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ message: '汇总失败：persistence 不可用' }) });

  try {
    runtime.beginRender();
    panel.component({});
    for (const effect of runtime.takeEffects()) effect();
    await new Promise((resolve) => setImmediate(resolve));

    runtime.beginRender();
    const tree = panel.component({});
    const strings = collectStrings(tree).join(' | ');
    assert.match(strings, /取数失败/);
    assert.match(strings, /persistence 不可用/);
    assert.match(strings, /重试/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('配置了价目表时展示金额并标注为估算，且与未配置态互斥', async () => {
  const runtime = createReact();
  const { module } = instantiate(runtime);
  const ctx = makeSlotsContext();
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const report = {
    generatedAt: Date.now(),
    window: { kind: 'all' },
    currency: 'CNY',
    totals: {
      sessions: 1,
      sessionsWithUsage: 1,
      liveSessions: 0,
      tokens: {
        uncachedInputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 0,
        billableInput: 3_000_000,
        total: 3_500_000,
        cacheHitRate: 2 / 3,
      },
      stats: { turns: 1, steps: 2, llmMs: 1000, toolMs: 0, wallMs: 1000 },
      openSteps: 0,
    },
    cost: {
      available: true,
      currency: 'CNY',
      amount: 2.2,
      basis: 'aggregate-single-rate',
      price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    },
    byWorkspace: [],
    byDay: [],
    topSessions: [],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, report }) });
  try {
    runtime.beginRender();
    panel.component({});
    for (const effect of runtime.takeEffects()) effect();
    await new Promise((resolve) => setImmediate(resolve));

    runtime.beginRender();
    const tree = panel.component({});
    const costCard = statCards(tree).find((card) => card.props.label === '估算成本');
    assert.equal(costCard.props.value, '2.2000 CNY');
    assert.equal(costCard.props.tone, 'warn');
    assert.match(String(costCard.props.hint), /估算|非账单/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('渲染路径只使用主题令牌，不出现字面颜色（成功态与失败态都查）', async () => {
  const runtime = createReact();
  const { module } = instantiate(runtime);
  const ctx = makeSlotsContext();
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const report = {
    generatedAt: Date.now(),
    window: { kind: 'all' },
    currency: 'CNY',
    totals: {
      sessions: 2, sessionsWithUsage: 2, liveSessions: 0,
      tokens: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, billableInput: 45, total: 65, cacheHitRate: 0.75 },
      stats: { turns: 1, steps: 1, llmMs: 1, toolMs: 1, wallMs: 2 },
      openSteps: 0,
    },
    cost: { available: true, currency: 'CNY', amount: 0.004, basis: 'aggregate-single-rate', price: {} },
    byWorkspace: [{ cwd: '/x', label: 'x', sessions: 1, tokens: { total: 65, cacheHitRate: 0.5 }, stats: {}, cost: 0.004 }],
    byDay: [{ day: '2026-10-05', sessions: 1, tokens: { total: 65, cacheHitRate: null } }],
    topSessions: [{ id: 's', title: 't', workspaceLabel: 'x', createdAt: Date.now(), tokens: { total: 65 }, cost: 0.004 }],
  };

  const originalFetch = globalThis.fetch;
  const collectStyles = (tree) =>
    JSON.stringify(expandTree(tree).map((node) => node.props?.style ?? {}));

  try {
    // 成功态
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, report }) });
    runtime.beginRender();
    panel.component({});
    for (const effect of runtime.takeEffects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    runtime.beginRender();
    const readyStyles = collectStyles(panel.component({}));

    // 失败态（用同一份 hooks 状态会导致 deps 不重跑，所以直接读当前树）
    const literalReady = readyStyles.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(literalReady, [], `成功态出现字面颜色：${literalReady.join(', ')}`);

    // 错误态用独立运行时渲染，避免复用 hooks 状态
    const runtime2 = createReact();
    const second = instantiate(runtime2);
    const ctx2 = makeSlotsContext();
    second.module.apply(ctx2);
    const [, panel2] = ctx2.registrations;
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ message: 'x' }) });
    runtime2.beginRender();
    panel2.component({});
    for (const effect of runtime2.takeEffects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    runtime2.beginRender();
    const errorStyles = collectStyles(panel2.component({}));
    const literalError = errorStyles.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(literalError, [], `错误态出现字面颜色：${literalError.join(', ')}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
