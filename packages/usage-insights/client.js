/**
 * Client 半边：跨会话用量与成本面板。
 *
 * 四条硬约束（前三条来自官方文档，违反会让整个 slot 空白或与宿主不一致）：
 *  1. 不 import 任何 Harness 客户端包。React 从浏览器模块表里取，其余自备。
 *  2. 只用主题令牌着色，不写字面颜色。令牌名取自官方 dsh-client-ui-theme
 *     的令牌表（403 个），不是猜的；每个都带兜底值。
 *  3. 挂载点走官方 shipped 代码验证过的两段式：
 *       sidebar.panellist  左侧栏图标（侧栏自己调 selectPanel(id)）
 *       main               keyed 面板主体，key 必须等于 panellist 的 id
 *     —— 对照 dsh-client-ui-schedule 的 client.js。
 *  4. **所有可见文案走 ctx.locale**，不硬编码。官方文档要求
 *     "Route visible UI text through the Client locale service"。
 *     词典同时注册 zh 与 en；缺 locale 服务时退回内置中文词典并按 {name} 插值，
 *     保证任何情况下都不会把原始键名渲染到界面上。
 *
 * 数据全部来自 Host 半边注册的 `/api/usage-insights`，本半边不做任何聚合。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-usage-insights',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'usage-insights';
    const DATA_PATH = '/api/usage-insights';
    // 命名空间带上包名，避免与其它插件撞车。
    const NS = '@local/dsh-usage-insights/panel';

    /**
     * 词典。两种语言必须键集完全一致——官方 locale 命名空间就是这么要求的
     * （TS 部署里由编译器强制；这里是纯 JS，靠 devkit check 与单元测试兜底）。
     */
    const DICT = {
      zh: {
        panel: '会话用量与成本',
        loading: '正在汇总会话数据…',
        errorTitle: '取数失败',
        retry: '重试',
        malformed: 'Host 返回的数据格式不符合预期。',
        refresh: '刷新',
        refreshTitle: '重新汇总',
        win24h: '24 小时',
        win7d: '7 天',
        win30d: '30 天',
        winAll: '全部',
        statTokens: 'Token 总量',
        statCache: '缓存命中率',
        statOutput: '输出 token',
        statCost: '估算成本',
        hintSessions: '{withUsage}/{total} 个会话有用量',
        hintCacheRead: '缓存读取 {value}',
        hintTurns: '轮次 {turns} / 步 {steps}',
        hintCostEstimated: '按你配置的价目表估算，非账单',
        hintCostUnconfigured: '官方不提供价格数据，需在插件 config 里填价目表',
        costUnconfigured: '未配置',
        sectionTokens: 'Token 构成',
        segUncachedInput: '未缓存输入',
        segCacheRead: '缓存读取',
        segCacheWrite: '缓存写入',
        segOutput: '输出',
        metaLlm: '模型耗时',
        metaTool: '工具耗时',
        metaTotal: '合计',
        metaLive: '进行中会话',
        metaGeneratedAt: '汇总于 {time}',
        sectionWorkspace: '按工作区',
        sectionDaily: '按天（最近 14 天）',
        sectionTop: 'Token 最多的会话',
        colWorkspace: '工作区',
        colSessions: '会话',
        colTokens: 'Token',
        colCacheHit: '命中率',
        colCost: '成本',
        colEstimatedCost: '估算成本',
        colCreatedAt: '创建于',
        colSession: '会话',
        untitled: '（未命名会话）',
        unknownWorkspace: '（未知工作区）',
        footWindow:
          '口径：时间窗按「会话创建时间」筛选，不是最后活动时间；官方投影缓存里没有可靠的最后活动字段。',
        footSource:
          '数据源：sessionQuery.listSessions() + sessionProjectionCache.cachedSnapshot()，为零 I/O 读取，数值与官方会话列表一致。',
        footCostEstimated:
          '金额：按你在插件 config 里配置的价目表估算。官方全部 287 个包中不存在货币价格数据，因此这不是账单。',
        footCostUnconfigured:
          '金额：未配置价目表，故不显示任何金额——官方不提供价格数据，此处不臆造数字。',
        durationHours: '{value} 小时',
        durationMinutes: '{value} 分钟',
        durationSeconds: '{value} 秒',
        durationMs: '{value} 毫秒',
        durationNone: '—',
      },
      en: {
        panel: 'Session Usage & Cost',
        loading: 'Aggregating session data…',
        errorTitle: 'Failed to load',
        retry: 'Retry',
        malformed: 'The Host returned an unexpected payload shape.',
        refresh: 'Refresh',
        refreshTitle: 'Re-aggregate',
        win24h: '24 hours',
        win7d: '7 days',
        win30d: '30 days',
        winAll: 'All',
        statTokens: 'Total tokens',
        statCache: 'Cache hit rate',
        statOutput: 'Output tokens',
        statCost: 'Estimated cost',
        hintSessions: '{withUsage}/{total} sessions with usage',
        hintCacheRead: 'Cache reads {value}',
        hintTurns: '{turns} turns / {steps} steps',
        hintCostEstimated: 'Estimated from your price table; not a bill',
        hintCostUnconfigured:
          'No price data ships with the harness; set a price table in this plugin\u2019s config',
        costUnconfigured: 'Not configured',
        sectionTokens: 'Token composition',
        segUncachedInput: 'Uncached input',
        segCacheRead: 'Cache reads',
        segCacheWrite: 'Cache writes',
        segOutput: 'Output',
        metaLlm: 'Model time',
        metaTool: 'Tool time',
        metaTotal: 'Total',
        metaLive: 'Live sessions',
        metaGeneratedAt: 'Aggregated at {time}',
        sectionWorkspace: 'By workspace',
        sectionDaily: 'By day (last 14)',
        sectionTop: 'Top sessions by tokens',
        colWorkspace: 'Workspace',
        colSessions: 'Sessions',
        colTokens: 'Tokens',
        colCacheHit: 'Hit rate',
        colCost: 'Cost',
        colEstimatedCost: 'Est. cost',
        colCreatedAt: 'Created',
        colSession: 'Session',
        untitled: '(untitled session)',
        unknownWorkspace: '(unknown workspace)',
        footWindow:
          'Scope: the time window filters by session creation time, not last activity; the official projection cache carries no reliable last-activity field.',
        footSource:
          'Source: sessionQuery.listSessions() + sessionProjectionCache.cachedSnapshot() — zero-I/O reads, consistent with the official session list.',
        footCostEstimated:
          'Amounts are estimated from the price table in this plugin\u2019s config. No monetary price data exists anywhere in the 287 official packages, so this is not a bill.',
        footCostUnconfigured:
          'Amounts are hidden because no price table is configured — the harness ships no price data, and this panel does not invent numbers.',
        durationHours: '{value} h',
        durationMinutes: '{value} min',
        durationSeconds: '{value} s',
        durationMs: '{value} ms',
        durationNone: '—',
      },
    };

    /** 官方 translate() 用的插值语法是 {name}。 */
    function interpolate(template, params) {
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      );
    }

    /**
     * 拿到翻译函数。
     *
     * 有 locale 服务时按官方 shipped 方式注册词典并 bind；
     * 没有时退回内置中文词典——面板宁可显示中文，也不能把
     * "statTokens" 这种原始键名渲染给用户。
     */
    function setupTranslator(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale;
      if (locale === undefined || typeof locale.bind !== 'function') {
        return {
          t: (key, params) => interpolate(DICT.zh[key] ?? key, params),
          locale: undefined,
        };
      }
      if (typeof locale.register === 'function') {
        // register 返回 disposer，必须挂在 effect 上随插件卸载一起回收。
        ctx.effect(() => locale.register(NS, DICT), 'usage-insights: dictionaries');
      }
      return { t: locale.bind(NS), locale };
    }

    /**
     * 语言切换时强制重渲染。
     * 官方界面在切语言后不需要刷新页面，面板也应如此。
     */
    function useLocaleRefresh(locale) {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => bump((value) => value + 1));
      }, [locale]);
    }

    /* ------------------------------------------------------------ 主题令牌 */

    const type = (scale, fallbackSize) => ({
      fontSize: `var(--dsw-font-${scale}-font-size, ${fallbackSize}px)`,
      lineHeight: `var(--dsw-font-${scale}-line-height, ${Math.round(fallbackSize * 1.5)}px)`,
      fontWeight: `var(--dsw-font-${scale}-font-weight, 400)`,
    });

    const T = {
      xxs: type('xxs-12', 12),
      xs: type('xs-13', 13),
      s: type('s-14', 14),
      base: type('base-16', 16),
      xl: type('xl-24', 24),
    };

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      text2: 'var(--dsw-alias-label-secondary, inherit)',
      text3: 'var(--dsw-alias-label-tertiary, inherit)',
      caption: 'var(--dsw-alias-label-caption, inherit)',
      dimmed: 'var(--dsw-alias-label-dimmed, inherit)',
      bgBase: 'var(--dsw-alias-bg-base, transparent)',
      card: 'var(--dsw-alias-bg-layer-1, transparent)',
      cardAlt: 'var(--dsw-alias-bg-layer-2, transparent)',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.18))',
      accent: 'var(--dsw-alias-brand-primary, currentColor)',
      success: 'var(--dsw-alias-state-success-primary, currentColor)',
      warn: 'var(--dsw-alias-state-warn-primary, currentColor)',
      error: 'var(--dsw-alias-state-error-primary, currentColor)',
    };

    const radius = {
      sm: 'var(--dsw-radius-sm, 6px)',
      md: 'var(--dsw-radius-md, 8px)',
      lg: 'var(--dsw-radius-lg, 12px)',
    };

    /* -------------------------------------------------------------- 工具 */

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
      if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
      return String(value);
    }

    function formatPercent(ratio) {
      return typeof ratio === 'number' && Number.isFinite(ratio)
        ? `${(ratio * 100).toFixed(1)}%`
        : '—';
    }

    function formatDuration(ms, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms === 0) return t('durationNone');
      if (ms >= 3_600_000) return t('durationHours', { value: (ms / 3_600_000).toFixed(1) });
      if (ms >= 60_000) return t('durationMinutes', { value: (ms / 60_000).toFixed(1) });
      if (ms >= 1000) return t('durationSeconds', { value: (ms / 1000).toFixed(1) });
      return t('durationMs', { value: Math.round(ms) });
    }

    function formatMoney(amount, currency) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
      if (amount === 0) return `0 ${currency}`;
      if (amount < 0.01) return `${amount.toFixed(6)} ${currency}`;
      return `${amount.toFixed(4)} ${currency}`;
    }

    function formatDate(ms) {
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) return '—';
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${date.getFullYear()}-${month}-${day}`;
    }

    /* ------------------------------------------------------------ 小组件 */

    function Card({ children, style }) {
      return h(
        'div',
        {
          style: {
            background: C.card,
            border: `1px solid ${C.borderSoft}`,
            borderRadius: radius.md,
            padding: '12px 14px',
            ...style,
          },
        },
        children,
      );
    }

    function Stat({ label, value, hint, tone }) {
      return h(
        Card,
        null,
        h('div', { style: { ...T.xxs, color: C.text3, marginBottom: 6 } }, label),
        h(
          'div',
          {
            style: {
              ...T.xl,
              color: tone === 'warn' ? C.warn : tone === 'muted' ? C.text3 : C.text,
              whiteSpace: 'nowrap',
            },
          },
          value,
        ),
        hint === undefined
          ? null
          : h('div', { style: { ...T.xxs, color: C.caption, marginTop: 6 } }, hint),
      );
    }

    function Segmented({ options, value, onChange }) {
      return h(
        'div',
        {
          style: {
            display: 'inline-flex',
            gap: 2,
            padding: 2,
            background: C.cardAlt,
            borderRadius: radius.sm,
            border: `1px solid ${C.borderSoft}`,
          },
        },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'aria-pressed': option.value === value,
              onClick: () => onChange(option.value),
              style: {
                ...T.xs,
                padding: '4px 10px',
                border: 'none',
                borderRadius: radius.sm,
                cursor: 'pointer',
                color: option.value === value ? C.text : C.text3,
                background: option.value === value ? C.bgBase : 'transparent',
                fontWeight: option.value === value ? 600 : 400,
              },
            },
            option.label,
          ),
        ),
      );
    }

    /** 横向堆叠条：未缓存输入 / 缓存读取 / 缓存写入 / 输出。 */
    function TokenBar({ tokens, t }) {
      const segments = [
        { key: 'uncachedInputTokens', label: t('segUncachedInput'), color: C.accent },
        { key: 'cacheReadTokens', label: t('segCacheRead'), color: C.success },
        { key: 'cacheWriteTokens', label: t('segCacheWrite'), color: C.warn },
        { key: 'outputTokens', label: t('segOutput'), color: C.text3 },
      ];
      const total = tokens.total > 0 ? tokens.total : 1;
      return h(
        'div',
        null,
        h(
          'div',
          {
            style: {
              display: 'flex',
              height: 10,
              borderRadius: 999,
              overflow: 'hidden',
              background: C.cardAlt,
              border: `1px solid ${C.borderSoft}`,
            },
          },
          segments.map((segment) => {
            const value = tokens[segment.key] ?? 0;
            if (value <= 0) return null;
            return h('div', {
              key: segment.key,
              title: `${segment.label} ${formatTokens(value)}`,
              style: {
                width: `${(value / total) * 100}%`,
                background: segment.color,
                opacity: segment.key === 'outputTokens' ? 0.55 : 0.9,
              },
            });
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 } },
          segments.map((segment) =>
            h(
              'span',
              { key: segment.key, style: { ...T.xxs, color: C.text3 } },
              h('span', {
                style: {
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  marginRight: 6,
                  borderRadius: 2,
                  background: segment.color,
                  opacity: segment.key === 'outputTokens' ? 0.55 : 0.9,
                },
              }),
              `${segment.label} ${formatTokens(tokens[segment.key] ?? 0)}`,
            ),
          ),
        ),
      );
    }

    function SectionTitle({ children }) {
      return h(
        'div',
        { style: { ...T.s, color: C.text, fontWeight: 600, margin: '18px 0 8px' } },
        children,
      );
    }

    function Table({ head, rows }) {
      return h(
        'div',
        {
          style: {
            border: `1px solid ${C.borderSoft}`,
            borderRadius: radius.md,
            overflow: 'hidden',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: head.map((column) => column.width).join(' '),
              gap: 8,
              padding: '8px 12px',
              background: C.cardAlt,
              ...T.xxs,
              color: C.text3,
            },
          },
          head.map((column) => h('div', { key: column.key }, column.label)),
        ),
        rows.map((row, index) =>
          h(
            'div',
            {
              key: row.key ?? index,
              style: {
                display: 'grid',
                gridTemplateColumns: head.map((column) => column.width).join(' '),
                gap: 8,
                padding: '8px 12px',
                borderTop: `1px solid ${C.borderSoft}`,
                ...T.xs,
                color: C.text2,
                alignItems: 'center',
              },
            },
            row.cells.map((cell, cellIndex) =>
              h(
                'div',
                {
                  key: cellIndex,
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                cell,
              ),
            ),
          ),
        ),
      );
    }

    function DailyBars({ days }) {
      const max = days.reduce((acc, day) => Math.max(acc, day.tokens.total), 0) || 1;
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 72, padding: '0 2px' } },
        days.map((day) =>
          h('div', {
            key: day.day,
            title: `${day.day}  ${formatTokens(day.tokens.total)} tokens  ·  ${day.sessions}`,
            style: {
              flex: '1 1 0',
              minWidth: 3,
              height: `${Math.max(3, (day.tokens.total / max) * 100)}%`,
              background: C.accent,
              opacity: 0.85,
              borderRadius: '2px 2px 0 0',
            },
          }),
        ),
      );
    }

    /* ------------------------------------------------------------- 面板 */

    function Panel({ t, locale }) {
      useLocaleRefresh(locale);
      const [windowKind, setWindowKind] = React.useState(null);
      const [state, setState] = React.useState({ status: 'loading' });
      const activeController = React.useRef(null);
      const requestSerial = React.useRef(0);

      const load = React.useCallback(
        (kind) => {
          activeController.current?.abort();
          const controller = new AbortController();
          activeController.current = controller;
          const requestId = ++requestSerial.current;
          setState({ status: 'loading' });
          const suffix = kind === null ? '' : `?window=${encodeURIComponent(kind)}`;
          fetch(`${DATA_PATH}${suffix}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          })
            .then(async (response) => {
              const body = await response.json().catch(() => null);
              if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`);
              return body;
            })
            .then((data) => {
              if (activeController.current === controller && requestSerial.current === requestId) {
                setState({ status: 'ready', data });
              }
            })
            .catch((error) => {
              if (
                activeController.current !== controller ||
                requestSerial.current !== requestId ||
                error?.name === 'AbortError'
              ) return;
              setState({ status: 'error', message: String(error.message ?? error) });
            });
          return () => {
            if (activeController.current === controller) activeController.current = null;
            controller.abort();
          };
        },
        [],
      );

      React.useEffect(() => load(windowKind), [load, windowKind]);

      const shell = (children) =>
        h(
          'div',
          {
            style: {
              height: '100%',
              overflow: 'auto',
              background: C.bgBase,
              color: C.text,
              padding: '16px 18px 32px',
              fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)',
            },
          },
          children,
        );

      if (state.status === 'loading') {
        return shell(h('div', { style: { ...T.s, color: C.text3 } }, t('loading')));
      }

      if (state.status === 'error') {
        return shell([
          h(
            'div',
            { key: 'title', style: { ...T.s, color: C.error, marginBottom: 8 } },
            t('errorTitle'),
          ),
          h(
            'div',
            { key: 'msg', style: { ...T.xs, color: C.text2, marginBottom: 12 } },
            state.message,
          ),
          h(
            'button',
            {
              key: 'retry',
              type: 'button',
              onClick: () => load(windowKind),
              style: {
                ...T.xs,
                padding: '6px 12px',
                borderRadius: radius.sm,
                border: `1px solid ${C.border}`,
                background: C.card,
                color: C.text,
                cursor: 'pointer',
              },
            },
            t('retry'),
          ),
        ]);
      }

      const report = state.data?.report;
      if (report === undefined) {
        return shell(h('div', { style: { ...T.s, color: C.text3 } }, t('malformed')));
      }

      const totals = report.totals;
      const cost = report.cost ?? { available: false };

      return shell([
        h(
          'div',
          {
            key: 'head',
            style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
          },
          h('div', { style: { ...T.base, fontWeight: 600, flex: '1 1 auto' } }, t('panel')),
          h(Segmented, {
            value: windowKind ?? state.data?.window ?? '7d',
            onChange: setWindowKind,
            options: [
              { value: '24h', label: t('win24h') },
              { value: '7d', label: t('win7d') },
              { value: '30d', label: t('win30d') },
              { value: 'all', label: t('winAll') },
            ],
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => load(windowKind),
              title: t('refreshTitle'),
              style: {
                ...T.xs,
                padding: '5px 10px',
                borderRadius: radius.sm,
                border: `1px solid ${C.border}`,
                background: C.card,
                color: C.text2,
                cursor: 'pointer',
              },
            },
            t('refresh'),
          ),
        ),

        h(
          'div',
          {
            key: 'stats',
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 10,
              marginTop: 14,
            },
          },
          [
            h(Stat, {
              key: 'tokens',
              label: t('statTokens'),
              value: formatTokens(totals.tokens.total),
              hint: t('hintSessions', {
                withUsage: totals.sessionsWithUsage,
                total: totals.sessions,
              }),
            }),
            h(Stat, {
              key: 'cache',
              label: t('statCache'),
              value: formatPercent(totals.tokens.cacheHitRate),
              hint: t('hintCacheRead', { value: formatTokens(totals.tokens.cacheReadTokens) }),
            }),
            h(Stat, {
              key: 'output',
              label: t('statOutput'),
              value: formatTokens(totals.tokens.outputTokens),
              hint: t('hintTurns', { turns: totals.stats.turns, steps: totals.stats.steps }),
            }),
            cost.available
              ? h(Stat, {
                  key: 'cost',
                  label: t('statCost'),
                  value: formatMoney(cost.amount, cost.currency),
                  hint: t('hintCostEstimated'),
                  tone: 'warn',
                })
              : h(Stat, {
                  key: 'cost',
                  label: t('statCost'),
                  value: t('costUnconfigured'),
                  hint: t('hintCostUnconfigured'),
                  tone: 'muted',
                }),
          ],
        ),

        h(SectionTitle, { key: 't1' }, t('sectionTokens')),
        h(Card, { key: 'bar' }, h(TokenBar, { tokens: totals.tokens, t })),

        h(
          'div',
          {
            key: 'meta',
            style: {
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              marginTop: 10,
              ...T.xxs,
              color: C.text3,
            },
          },
          [
            h('span', { key: 'llm' }, `${t('metaLlm')} ${formatDuration(totals.stats.llmMs, t)}`),
            h('span', { key: 'tool' }, `${t('metaTool')} ${formatDuration(totals.stats.toolMs, t)}`),
            h(
              'span',
              { key: 'wall' },
              `${t('metaTotal')} ${formatDuration(totals.stats.wallMs, t)}`,
            ),
            h('span', { key: 'live' }, `${t('metaLive')} ${totals.liveSessions}`),
            h(
              'span',
              { key: 'at' },
              t('metaGeneratedAt', { time: new Date(report.generatedAt).toLocaleTimeString() }),
            ),
          ],
        ),

        report.byWorkspace.length > 0 ? h(SectionTitle, { key: 't2' }, t('sectionWorkspace')) : null,
        report.byWorkspace.length > 0
          ? h(Table, {
              key: 'ws',
              head: [
                { key: 'label', label: t('colWorkspace'), width: 'minmax(0,2fr)' },
                { key: 'sessions', label: t('colSessions'), width: '64px' },
                { key: 'tokens', label: t('colTokens'), width: '88px' },
                { key: 'cache', label: t('colCacheHit'), width: '72px' },
                {
                  key: 'cost',
                  label: cost.available ? t('colEstimatedCost') : t('colCost'),
                  width: '116px',
                },
              ],
              rows: report.byWorkspace.map((workspace) => ({
                key: workspace.cwd ?? workspace.label,
                // 工作区名缺失时用本地化文案，而不是让 Host 侧的中文兜底串漏出来。
                cells: [
                  workspace.cwd === null || workspace.cwd === undefined
                    ? t('unknownWorkspace')
                    : workspace.label,
                  String(workspace.sessions),
                  formatTokens(workspace.tokens.total),
                  formatPercent(workspace.tokens.cacheHitRate),
                  cost.available
                    ? formatMoney(workspace.cost, cost.currency)
                    : t('costUnconfigured'),
                ],
              })),
            })
          : null,

        report.byDay.length > 0 ? h(SectionTitle, { key: 't3' }, t('sectionDaily')) : null,
        report.byDay.length > 0
          ? h(Card, { key: 'bars' }, h(DailyBars, { days: report.byDay.slice(-14) }))
          : null,

        report.topSessions.length > 0 ? h(SectionTitle, { key: 't4' }, t('sectionTop')) : null,
        report.topSessions.length > 0
          ? h(Table, {
              key: 'top',
              head: [
                { key: 'title', label: t('colSession'), width: 'minmax(0,3fr)' },
                { key: 'workspace', label: t('colWorkspace'), width: 'minmax(0,1.2fr)' },
                { key: 'date', label: t('colCreatedAt'), width: '96px' },
                { key: 'tokens', label: t('colTokens'), width: '84px' },
              ],
              rows: report.topSessions.map((session) => ({
                key: session.id,
                cells: [
                  // 标题缺失时用本地化文案；Host 仍会给中文兜底串，这里优先取原值。
                  session.title ?? t('untitled'),
                  session.cwd === null || session.cwd === undefined
                    ? t('unknownWorkspace')
                    : session.workspaceLabel,
                  formatDate(session.createdAt),
                  formatTokens(session.tokens.total),
                ],
              })),
            })
          : null,

        h(
          'div',
          { key: 'foot', style: { ...T.xxs, color: C.caption, marginTop: 20, lineHeight: '18px' } },
          [
            h('div', { key: 'a' }, t('footWindow')),
            h('div', { key: 'b' }, t('footSource')),
            h(
              'div',
              { key: 'c' },
              cost.available ? t('footCostEstimated') : t('footCostUnconfigured'),
            ),
          ],
        ),
      ]);
    }

    /* -------------------------------------------------------------- 图标 */

    function Icon({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 19V5' }),
        h('path', { d: 'M4 19h16' }),
        h('path', { d: 'M8 15.5V9' }),
        h('path', { d: 'M13 15.5v-4' }),
        h('path', { d: 'M18 15.5V7' }),
      );
    }

    /* -------------------------------------------------------------- 注册 */

    return {
      // 本半边依赖 slots 服务；缺它就保持未激活而不是抛错。
      // locale 是可选依赖，用 ctx.get('locale') 探测，不放进 inject——
      // 否则一个没有 locale 服务的 profile 会让整个面板直接消失。
      inject: ['slots'],
      apply(ctx) {
        const { t, locale } = setupTranslator(ctx);
        // inject 返回的对象会作为额外 props 合并进组件。保持引用稳定，
        // 避免每次渲染产生新对象造成无谓的重渲染。
        const panelProps = { t, locale };

        // 左侧栏图标：侧栏自己负责 selectPanel(id)，这里只画字形。
        // label 用函数形式，侧栏在语言切换时会重新同步它
        // （ui-sidebar 里有 ctx.locale.subscribe(syncPanels)）。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              locale: NS,
              label: () => t('panel'),
            },
            Icon,
          ),
        );
        // 面板主体：main 是 keyed slot，key 必须与上面的 id 相同。
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: () => panelProps },
            Panel,
          ),
        );
      },
    };
  },
});
