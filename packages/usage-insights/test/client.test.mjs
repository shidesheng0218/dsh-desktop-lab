/**
 * Client 半边的契约测试。
 *
 * 为什么值得为此写一个假浏览器环境：官方文档明确警告「抛异常的组件会直接让
 * 整个 slot 变成空白」（console: `slot entry crashed in '<slot>'`）。而浏览器
 * 半边的错误在装机之前完全不可见。这里用一个极简 hook 运行时真的执行
 * client.js，验证：
 *   - 工厂 id 与包名一致
 *   - 注册的 slot 名称、id / key 与官方 shipped 代码的用法一致
 *   - 加载态 / 成功态 / 失败态都能渲染，且渲染路径不抛异常
 *   - **所有可见文案走 locale**：英文下渲染结果里不得出现任何中日韩字符
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
        children: children
          .flat(Infinity)
          .filter((c) => c !== null && c !== undefined && c !== false),
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

/* --------------------------------------------------------- 假 locale 服务 */

/**
 * 复刻官方 LocaleRuntime 的对外行为：register(ns, {zh, en}) 存词典并返回
 * disposer；bind(ns) 返回 t(key, params)；{name} 插值；缺键回落到键名。
 */
function createFakeLocale() {
  const dicts = new Map();
  const listeners = new Set();
  let active = 'zh';

  const lookup = (ns, locale, key) => dicts.get(ns)?.get(locale)?.[key];
  const interpolate = (template, params) =>
    params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));

  return {
    registrations: [],
    register(ns, localeOrDicts, dict) {
      const pairs =
        typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
      if (!dicts.has(ns)) dicts.set(ns, new Map());
      for (const [locale, entries] of pairs) dicts.get(ns).set(locale, entries);
      this.registrations.push({ ns, locales: Object.keys(Object.fromEntries(pairs)) });
      return () => {};
    },
    bind(ns) {
      return (key, params) => {
        // 官方会依次查 active → 回退链（终止于 en）→ common → 键名
        const template =
          lookup(ns, active, key) ?? lookup(ns, 'en', key) ?? (ns !== 'common' ? lookup('common', active, key) : undefined) ?? key;
        return interpolate(template, params);
      };
    },
    getSnapshot() {
      return { active, locales: [], revision: 0 };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setActive(locale) {
      active = locale;
      for (const fn of listeners) fn();
    },
    dictionary(ns, locale) {
      return dicts.get(ns)?.get(locale);
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

  const run = new Function('window', `${source}\n//# sourceURL=usage-insights-client.js`);
  run(window);

  assert.ok(captured !== null, 'client.js 必须调用 window.__ModuleLoader__.load(...)');
  return captured;
}

function instantiate() {
  const definition = loadClientModule();
  const req = (name) => {
    if (name === 'react') return RUNTIME.React;
    throw new Error(`client.js 只允许 require React，但它请求了 ${name}`);
  };
  return { definition, module: definition.factory(req) };
}

// 每个用例自行创建 runtime，但 instantiate 需要拿到「当前」的 runtime。
let RUNTIME = null;

/** 注册一个只记录调用的假 slots 上下文。 */
function makeCtx({ locale } = {}) {
  const injections = [];
  const registrations = [];
  const effects = [];
  const ctx = {
    injections,
    registrations,
    effects,
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
    // 官方 Cordis 的 ctx.effect(cb)：cb 立即执行，返回值是销毁函数
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
      return dispose;
    },
    // 可选服务探测：官方写法是 ctx.get('serviceName')
    get(name) {
      return name === 'locale' ? locale : undefined;
    },
  };
  if (locale !== undefined) ctx.locale = locale;
  return ctx;
}

/** 按官方语义组装组件 props：注册项上的 inject() 提供额外 props。 */
function propsFor(registration) {
  const extra = typeof registration.spec.inject === 'function' ? registration.spec.inject() : {};
  return { ...extra };
}

/* ----------------------------------------------------------- 树遍历工具 */

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
    // 先把组件节点本身记下来（它的 props 才是调用方真正的意图），
    // 再展开成它渲染出来的内容。
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

/**
 * 递归收集所有可见文本（含展开的函数组件）。
 *
 * 必须基于 expandTree 收：函数组件节点自身的 props 就是调用方要显示的文案
 * （例如 Stat 的 {label, value, hint}），只递归 children 会把这些全部漏掉——
 * 早期版本正是如此，于是「{name} 插值生效」这条断言永远失败而看不出原因。
 */
function collectStrings(tree) {
  const out = [];
  for (const node of expandTree(tree)) {
    const { children, ...rest } = node.props ?? {};
    for (const [key, value] of Object.entries(rest)) {
      if (key === 'style' || typeof value === 'function') continue;
      if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
    }
    if (typeof children === 'string' || typeof children === 'number') out.push(String(children));
    // expandTree 只保留元素节点，纯文本子节点要在这里单独收，
    // 否则 h('div', null, '文案') 这种最普通的渲染会一个字都收不到。
    for (const child of node.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child));
    }
  }
  return out;
}

/** 找出所有形如 { label, value } 的统计卡片节点。 */
function statCards(tree) {
  return expandTree(tree).filter(
    (node) =>
      typeof node.props?.label === 'string' &&
      node.props.label.length > 0 &&
      'value' in (node.props ?? {}),
  );
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/* --------------------------------------------------------------- 夹具 */

/** 全 ASCII 的夹具：便于在英文渲染下断言「没有任何中日韩字符」。 */
function asciiReport(overrides = {}) {
  return {
    generatedAt: Date.UTC(2026, 9, 5, 4, 0, 0),
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
    byDay: [{ day: '2026-10-05', sessions: 3, tokens: { total: 3_900_000, cacheHitRate: null } }],
    topSessions: [
      {
        id: 's1',
        title: 'test session alpha',
        displayTitle: 'test session alpha',
        workspaceLabel: 'project-alpha',
        cwd: '/Users/example/project-alpha',
        createdAt: Date.UTC(2026, 9, 5),
        tokens: { total: 3_500_000 },
        cost: null,
      },
    ],
    ...overrides,
  };
}

function readyFetch(report) {
  return async () => ({ ok: true, status: 200, json: async () => ({ ok: true, report }) });
}

/** 渲染一次面板并把 effect 跑完，返回最终树。 */
async function renderReady(panel, props) {
  RUNTIME.beginRender();
  panel.component(props);
  for (const effect of RUNTIME.takeEffects()) effect();
  await new Promise((resolve) => setImmediate(resolve));
  RUNTIME.beginRender();
  return panel.component(props);
}

/* ------------------------------------------------------------------ 用例 */

test('工厂 id 必须等于包名（否则宿主找不到这个模块）', () => {
  RUNTIME = createReact();
  const { definition } = instantiate();
  assert.equal(definition.id, PACKAGE_NAME);
  assert.equal(typeof definition.factory, 'function');
});

test('模块只注入 slots，并按官方两段式注册 sidebar.panellist 与 main', () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  // locale 不放进 inject：否则没有 locale 服务的 profile 会让面板整体消失。
  assert.deepEqual(module.inject, ['slots']);

  const ctx = makeCtx({ locale: createFakeLocale() });
  module.apply(ctx);

  assert.deepEqual(ctx.injections, ['sidebar.panellist', 'main']);
  assert.equal(ctx.registrations.length, 2);

  const [icon, panel] = ctx.registrations;
  assert.equal(icon.spec.name, 'sidebar.panellist');
  assert.equal(icon.spec.id, 'usage-insights');
  assert.equal(typeof icon.spec.label, 'function');
  assert.equal(typeof icon.spec.order, 'number');

  // main 是 keyed slot：key 必须与 panellist 的 id 完全相等，
  // 否则侧栏点了图标也打不开面板（ui-layout 的 hasMainPanel 会拒绝）。
  assert.equal(panel.spec.name, 'main');
  assert.equal(panel.spec.key, icon.spec.id);
});

test('词典按官方方式注册：一个命名空间同时给出 zh 与 en，且键集完全一致', () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const locale = createFakeLocale();
  const ctx = makeCtx({ locale });
  module.apply(ctx);

  assert.equal(locale.registrations.length, 1);
  const [{ ns, locales }] = locale.registrations;
  assert.equal(ns, '@local/dsh-usage-insights/panel');
  assert.deepEqual(locales.sort(), ['en', 'zh']);

  const zh = locale.dictionary(ns, 'zh');
  const en = locale.dictionary(ns, 'en');
  assert.deepEqual(
    Object.keys(zh).sort(),
    Object.keys(en).sort(),
    '两种语言的键集必须一致，否则会有一侧显示原始键名',
  );

  // 注册必须挂在 ctx.effect 上，随插件卸载一起回收。
  assert.ok(
    ctx.effects.some((effect) => String(effect.label).includes('dictionaries')),
    'locale.register 必须包在 ctx.effect 里',
  );
});

test('侧栏标签走本地化，并且切换语言后跟着变', () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const locale = createFakeLocale();
  const ctx = makeCtx({ locale });
  module.apply(ctx);
  const [icon] = ctx.registrations;

  assert.equal(icon.spec.label(), '会话用量与成本');
  locale.setActive('en');
  // ui-sidebar 里有 ctx.locale.subscribe(syncPanels)，会重新读取 label()
  assert.equal(icon.spec.label(), 'Session Usage & Cost');
  locale.setActive('zh');
  assert.equal(icon.spec.label(), '会话用量与成本');
});

test('图标组件渲染出 SVG 且尺寸跟随传入的 size', () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({ locale: createFakeLocale() });
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
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({ locale: createFakeLocale() });
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  RUNTIME.beginRender();
  const tree = panel.component(propsFor(panel));
  const strings = collectStrings(tree);
  assert.ok(
    strings.some((s) => s.includes('正在汇总会话数据')),
    `首帧应当显示加载态，实际内容：${JSON.stringify(strings.slice(0, 10))}`,
  );
});

test('中文界面下渲染出各项指标，成本未配置时显示「未配置」', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({ locale: createFakeLocale() });
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = readyFetch(asciiReport());
  try {
    const tree = await renderReady(panel, propsFor(panel));
    const strings = collectStrings(tree).join(' | ');

    assert.match(strings, /3\.90M/, '应当显示 Token 总量');
    assert.match(strings, /60\.6%/, '应当显示缓存命中率');
    assert.match(strings, /project-alpha/, '应当显示工作区分组');
    assert.match(strings, /test session alpha/, '应当显示 Top 会话标题');
    // 插值必须真的生效
    assert.match(strings, /2\/3 个会话有用量/, '带参数的文案必须完成 {name} 插值');

    // 精确断言成本卡片本身的值，而不是全文正则：
    // 页脚里也含「未配置价目表」字样，用正则会让卡片值退化成 0 元也能通过。
    const cards = statCards(tree);
    const costCard = cards.find((card) => card.props.label === '估算成本');
    assert.ok(costCard, '必须存在「估算成本」卡片');
    assert.equal(costCard.props.value, '未配置', '没有价目表时卡片值必须是「未配置」');
    assert.equal(costCard.props.tone, 'muted');

    assert.equal(cards.find((card) => card.props.label === 'Token 总量').props.value, '3.90M');
    assert.equal(cards.find((card) => card.props.label === '缓存命中率').props.value, '60.6%');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('英文界面下渲染结果里不得出现任何中日韩字符（locale 接线完整性的硬断言）', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const locale = createFakeLocale();
  const ctx = makeCtx({ locale });
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  locale.setActive('en');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = readyFetch(asciiReport());
  try {
    const tree = await renderReady(panel, propsFor(panel));
    const strings = collectStrings(tree);
    const offending = strings.filter((value) => CJK.test(value));
    assert.deepEqual(
      offending,
      [],
      `英文界面下仍有硬编码中文：${JSON.stringify(offending.slice(0, 8))}`,
    );
    // 同时确认确实渲染了英文文案，而不是整块空白
    const joined = strings.join(' | ');
    assert.match(joined, /Total tokens/);
    assert.match(joined, /Not configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('英文界面下错误态与加载态同样不含硬编码中文', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 加载态与错误态各用一个全新实例：加载态的 effect 依赖不变，
    // 在同一个实例上改用 fetch 不会让 effect 重跑（真实 React 同理）。
    RUNTIME = createReact();
    const loadingLocale = createFakeLocale();
    const loadingCtx = makeCtx({ locale: loadingLocale });
    instantiate().module.apply(loadingCtx);
    const [, loadingPanel] = loadingCtx.registrations;
    loadingLocale.setActive('en');

    globalThis.fetch = () => new Promise(() => {});
    RUNTIME.beginRender();
    const loadingStrings = collectStrings(loadingPanel.component(propsFor(loadingPanel)));
    assert.deepEqual(loadingStrings.filter((value) => CJK.test(value)), []);
    assert.match(loadingStrings.join(' | '), /Aggregating session data/);

    // 错误态：独立实例
    RUNTIME = createReact();
    const errorLocale = createFakeLocale();
    const errorCtx = makeCtx({ locale: errorLocale });
    instantiate().module.apply(errorCtx);
    const [, errorPanel] = errorCtx.registrations;
    errorLocale.setActive('en');

    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'boom' }),
    });
    const errorTree = await renderReady(errorPanel, propsFor(errorPanel));
    const errorStrings = collectStrings(errorTree);
    assert.deepEqual(errorStrings.filter((value) => CJK.test(value)), []);
    assert.match(errorStrings.join(' | '), /Failed to load/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('切片语言后再次渲染即生效，无需重新加载插件', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const locale = createFakeLocale();
  const ctx = makeCtx({ locale });
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = readyFetch(asciiReport());
  try {
    const zhTree = await renderReady(panel, propsFor(panel));
    assert.match(collectStrings(zhTree).join(' | '), /Token 总量/);

    locale.setActive('en');
    RUNTIME.beginRender();
    const enTree = panel.component(propsFor(panel));
    assert.match(collectStrings(enTree).join(' | '), /Total tokens/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('没有 locale 服务时退回内置中文词典，且绝不显示原始键名', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({}); // 不提供 locale
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = readyFetch(asciiReport());
  try {
    const props = propsFor(panel);
    assert.equal(typeof props.t, 'function');

    const tree = await renderReady(panel, props);
    const strings = collectStrings(tree);
    assert.match(strings.join(' | '), /Token 总量/);
    for (const key of ['statTokens', 'sectionTokens', 'footWindow', 'costUnconfigured']) {
      assert.ok(
        !strings.includes(key),
        `缺少 locale 服务时把原始键名 "${key}" 渲染到了界面上`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('配置了价目表时展示金额并标注为估算', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({ locale: createFakeLocale() });
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const report = asciiReport({
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
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = readyFetch(report);
  try {
    const tree = await renderReady(panel, propsFor(panel));
    const costCard = statCards(tree).find((card) => card.props.label === '估算成本');
    assert.equal(costCard.props.value, '2.2000 CNY');
    assert.equal(costCard.props.tone, 'warn');
    assert.match(String(costCard.props.hint), /估算|非账单/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('取数失败时渲染错误态并可重试，不抛异常', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({ locale: createFakeLocale() });
  module.apply(ctx);
  const [, panel] = ctx.registrations;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: '汇总失败：persistence 不可用' }),
  });

  try {
    RUNTIME.beginRender();
    panel.component(propsFor(panel));
    for (const effect of RUNTIME.takeEffects()) effect();
    await new Promise((resolve) => setImmediate(resolve));

    RUNTIME.beginRender();
    const strings = collectStrings(panel.component(propsFor(panel))).join(' | ');
    assert.match(strings, /取数失败/);
    assert.match(strings, /persistence 不可用/);
    assert.match(strings, /重试/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('渲染路径只使用主题令牌，不出现字面颜色（成功态与失败态都查）', async () => {
  const collectStyles = (tree) =>
    JSON.stringify(expandTree(tree).map((node) => node.props?.style ?? {}));

  const originalFetch = globalThis.fetch;
  try {
    // 成功态
    RUNTIME = createReact();
    const first = instantiate();
    const ctx = makeCtx({ locale: createFakeLocale() });
    first.module.apply(ctx);
    const [, panel] = ctx.registrations;
    globalThis.fetch = readyFetch(asciiReport({ cost: { available: true, currency: 'CNY', amount: 0.004, basis: 'aggregate-single-rate', price: {} } }));
    const readyStyles = collectStyles(await renderReady(panel, propsFor(panel)));
    const literalReady = readyStyles.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(literalReady, [], `成功态出现字面颜色：${literalReady.join(', ')}`);

    // 错误态用独立运行时渲染，避免复用 hooks 状态
    RUNTIME = createReact();
    const second = instantiate();
    const ctx2 = makeCtx({ locale: createFakeLocale() });
    second.module.apply(ctx2);
    const [, panel2] = ctx2.registrations;
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ message: 'x' }) });
    RUNTIME.beginRender();
    panel2.component(propsFor(panel2));
    for (const effect of RUNTIME.takeEffects()) effect();
    await new Promise((resolve) => setImmediate(resolve));
    RUNTIME.beginRender();
    const errorStyles = collectStyles(panel2.component(propsFor(panel2)));
    const literalError = errorStyles.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(literalError, [], `错误态出现字面颜色：${literalError.join(', ')}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('首屏省略 window 参数，让 Host 配置决定默认时间窗', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({ locale: createFakeLocale() });
  module.apply(ctx);
  const [, panel] = ctx.registrations;
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, window: '30d', report: asciiReport({ window: { kind: '30d' } }) }),
    };
  };

  try {
    const tree = await renderReady(panel, propsFor(panel));
    assert.equal(requests[0].url, '/api/usage-insights');
    const segmented = expandTree(tree).find((node) => Array.isArray(node.props?.options));
    assert.equal(segmented.props.value, '30d');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('连续刷新会取消旧请求，旧响应不能覆盖新报告', async () => {
  RUNTIME = createReact();
  const { module } = instantiate();
  const ctx = makeCtx({ locale: createFakeLocale() });
  module.apply(ctx);
  const [, panel] = ctx.registrations;
  const requests = [];
  const originalFetch = globalThis.fetch;
  const response = (title) => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      report: asciiReport({
        topSessions: [{ ...asciiReport().topSessions[0], title }],
      }),
    }),
  });
  globalThis.fetch = (url, options) => {
    if (requests.length === 0) {
      requests.push({ url, options });
      return Promise.resolve(response('initial report'));
    }
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    requests.push({ url, options, resolve });
    return promise;
  };

  try {
    let tree = await renderReady(panel, propsFor(panel));
    const refresh = expandTree(tree).find((node) => node.props?.title === '重新汇总');
    refresh.props.onClick();
    refresh.props.onClick();
    assert.equal(requests.length, 3);
    assert.equal(requests[1].options.signal?.aborted, true);

    requests[2].resolve(response('newer report'));
    await new Promise((resolve) => setImmediate(resolve));
    requests[1].resolve(response('older report'));
    await new Promise((resolve) => setImmediate(resolve));

    RUNTIME.beginRender();
    tree = panel.component(propsFor(panel));
    const strings = collectStrings(tree).join(' | ');
    assert.match(strings, /newer report/);
    assert.doesNotMatch(strings, /older report/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
