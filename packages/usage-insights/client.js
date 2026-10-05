/**
 * Client 半边：跨会话用量与成本面板。
 *
 * 三条硬约束（都来自官方文档，违反会直接让整个 slot 空白）：
 *  1. 不 import 任何 Harness 客户端包。React 从浏览器模块表里取，其余自备。
 *  2. 只用主题令牌着色，不写字面颜色。令牌名取自官方 dsh-client-ui-theme
 *     的令牌表（403 个），不是猜的；每个都带兜底值，令牌被重命名时只是
 *     外观退化，不会渲染失败。
 *  3. 挂载点走官方 shipped 代码验证过的两段式：
 *       sidebar.panellist  左侧栏图标（侧栏自己调 selectPanel(id)，图标只画字形）
 *       main               keyed 面板主体，key 必须等于 panellist 的 id
 *     —— 对照 dsh-client-ui-schedule 的 client.js。
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

    /* ------------------------------------------------------------ 主题令牌 */

    // 通过子令牌（-font-size / -line-height / -font-weight）而不是 font 简写，
    // 这样单个令牌缺失时只退化一个属性。
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
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))',
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

    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms === 0) return '—';
      if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`;
      if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
      if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
      return `${Math.round(ms)} ms`;
    }

    function formatMoney(amount, currency) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
      if (amount === 0) return `0 ${currency}`;
      if (amount < 0.01) return `${amount.toFixed(6)} ${currency}`;
      return `${amount.toFixed(4)} ${currency}`;
    }

    function formatDate(ms) {
      try {
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } catch {
        return '—';
      }
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
    function TokenBar({ tokens }) {
      const segments = [
        { key: 'uncachedInputTokens', label: '未缓存输入', color: C.accent },
        { key: 'cacheReadTokens', label: '缓存读取', color: C.success },
        { key: 'cacheWriteTokens', label: '缓存写入', color: C.warn },
        { key: 'outputTokens', label: '输出', color: C.text3 },
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
      return h('div', { style: { ...T.s, color: C.text, fontWeight: 600, margin: '18px 0 8px' } }, children);
    }

    function Table({ head, rows }) {
      return h(
        'div',
        { style: { border: `1px solid ${C.borderSoft}`, borderRadius: radius.md, overflow: 'hidden' } },
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: head.map((c) => c.width).join(' '),
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
                gridTemplateColumns: head.map((c) => c.width).join(' '),
                gap: 8,
                padding: '8px 12px',
                borderTop: `1px solid ${C.borderSoft}`,
                ...T.xs,
                color: C.text2,
                alignItems: 'center',
              },
            },
            row.cells.map((cell, cellIndex) => h('div', { key: cellIndex, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cell)),
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
          h(
            'div',
            {
              key: day.day,
              title: `${day.day}  ${formatTokens(day.tokens.total)} tokens  ${day.sessions} 会话`,
              style: {
                flex: '1 1 0',
                minWidth: 3,
                height: `${Math.max(3, (day.tokens.total / max) * 100)}%`,
                background: C.accent,
                opacity: 0.85,
                borderRadius: '2px 2px 0 0',
              },
            },
          ),
        ),
      );
    }

    /* ------------------------------------------------------------- 面板 */

    function Panel() {
      const [windowKind, setWindowKind] = React.useState('7d');
      const [state, setState] = React.useState({ status: 'loading' });

      const load = React.useCallback(
        (kind) => {
          let cancelled = false;
          setState({ status: 'loading' });
          fetch(`${DATA_PATH}?window=${encodeURIComponent(kind)}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
            .then(async (response) => {
              const body = await response.json().catch(() => null);
              if (!response.ok) {
                throw new Error(body?.message ?? `HTTP ${response.status}`);
              }
              return body;
            })
            .then((data) => {
              if (!cancelled) setState({ status: 'ready', data });
            })
            .catch((error) => {
              if (!cancelled) setState({ status: 'error', message: String(error.message ?? error) });
            });
          return () => {
            cancelled = true;
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
        return shell(h('div', { style: { ...T.s, color: C.text3 } }, '正在汇总会话数据…'));
      }

      if (state.status === 'error') {
        return shell([
          h('div', { key: 'title', style: { ...T.s, color: C.error, marginBottom: 8 } }, '取数失败'),
          h('div', { key: 'msg', style: { ...T.xs, color: C.text2, marginBottom: 12 } }, state.message),
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
            '重试',
          ),
        ]);
      }

      const report = state.data?.report;
      if (report === undefined) {
        return shell(h('div', { style: { ...T.s, color: C.text3 } }, 'Host 返回的数据格式不符合预期。'));
      }

      const t = report.totals;
      const cost = report.cost ?? { available: false };

      return shell([
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
          h('div', { style: { ...T.base, fontWeight: 600, flex: '1 1 auto' } }, '会话用量与成本'),
          h(Segmented, {
            value: windowKind,
            onChange: setWindowKind,
            options: [
              { value: '24h', label: '24 小时' },
              { value: '7d', label: '7 天' },
              { value: '30d', label: '30 天' },
              { value: 'all', label: '全部' },
            ],
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => load(windowKind),
              title: '重新汇总',
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
            '刷新',
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
              label: 'Token 总量',
              value: formatTokens(t.tokens.total),
              hint: `${t.sessionsWithUsage}/${t.sessions} 个会话有用量`,
            }),
            h(Stat, {
              key: 'cache',
              label: '缓存命中率',
              value: formatPercent(t.tokens.cacheHitRate),
              hint: `缓存读取 ${formatTokens(t.tokens.cacheReadTokens)}`,
            }),
            h(Stat, {
              key: 'output',
              label: '输出 token',
              value: formatTokens(t.tokens.outputTokens),
              hint: `轮次 ${t.stats.turns} / 步 ${t.stats.steps}`,
            }),
            cost.available
              ? h(Stat, {
                  key: 'cost',
                  label: '估算成本',
                  value: formatMoney(cost.amount, cost.currency),
                  hint: '按你配置的价目表估算，非账单',
                  tone: 'warn',
                })
              : h(Stat, {
                  key: 'cost',
                  label: '估算成本',
                  value: '未配置',
                  hint: '官方不提供价格数据，需在插件 config 里填价目表',
                  tone: 'muted',
                }),
          ],
        ),

        h(SectionTitle, { key: 't1' }, 'Token 构成'),
        h(Card, { key: 'bar' }, h(TokenBar, { tokens: t.tokens })),

        h(
          'div',
          {
            key: 'meta',
            style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, ...T.xxs, color: C.text3 },
          },
          [
            h('span', { key: 'llm' }, `模型耗时 ${formatDuration(t.stats.llmMs)}`),
            h('span', { key: 'tool' }, `工具耗时 ${formatDuration(t.stats.toolMs)}`),
            h('span', { key: 'wall' }, `合计 ${formatDuration(t.stats.wallMs)}`),
            h('span', { key: 'live' }, `进行中会话 ${t.liveSessions}`),
            h('span', { key: 'at' }, `汇总于 ${new Date(report.generatedAt).toLocaleTimeString()}`),
          ],
        ),

        report.byWorkspace.length > 0 ? h(SectionTitle, { key: 't2' }, '按工作区') : null,
        report.byWorkspace.length > 0
          ? h(Table, {
              key: 'ws',
              head: [
                { key: 'label', label: '工作区', width: 'minmax(0,2fr)' },
                { key: 'sessions', label: '会话', width: '64px' },
                { key: 'tokens', label: 'Token', width: '88px' },
                { key: 'cache', label: '命中率', width: '72px' },
                { key: 'cost', label: cost.available ? '估算成本' : '成本', width: '116px' },
              ],
              rows: report.byWorkspace.map((workspace) => ({
                key: workspace.cwd ?? workspace.label,
                cells: [
                  workspace.label,
                  String(workspace.sessions),
                  formatTokens(workspace.tokens.total),
                  formatPercent(workspace.tokens.cacheHitRate),
                  cost.available ? formatMoney(workspace.cost, cost.currency) : '未配置',
                ],
              })),
            })
          : null,

        report.byDay.length > 0 ? h(SectionTitle, { key: 't3' }, '按天（最近 14 天）') : null,
        report.byDay.length > 0
          ? h(Card, { key: 'bars' }, h(DailyBars, { days: report.byDay.slice(-14) }))
          : null,

        report.topSessions.length > 0 ? h(SectionTitle, { key: 't4' }, 'Token 最多的会话') : null,
        report.topSessions.length > 0
          ? h(Table, {
              key: 'top',
              head: [
                { key: 'title', label: '会话', width: 'minmax(0,3fr)' },
                { key: 'workspace', label: '工作区', width: 'minmax(0,1.2fr)' },
                { key: 'date', label: '创建于', width: '96px' },
                { key: 'tokens', label: 'Token', width: '84px' },
              ],
              rows: report.topSessions.map((session) => ({
                key: session.id,
                cells: [
                  session.title,
                  session.workspaceLabel,
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
            h('div', { key: 'a' }, '口径：时间窗按「会话创建时间」筛选，不是最后活动时间；官方投影缓存里没有可靠的最后活动字段。'),
            h('div', { key: 'b' }, '数据源：sessionQuery.listSessions() + sessionProjectionCache.cachedSnapshot()，为零 I/O 读取，数值与官方会话列表一致。'),
            cost.available
              ? h('div', { key: 'c' }, '金额：按你在插件 config 里配置的价目表估算。官方全部 287 个包中不存在货币价格数据，因此这不是账单。')
              : h('div', { key: 'c' }, '金额：未配置价目表，故不显示任何金额——官方不提供价格数据，此处不臆造数字。'),
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
      inject: ['slots'],
      apply(ctx) {
        // 左侧栏图标：侧栏自己负责 selectPanel(id)，这里只画字形。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => '会话用量与成本',
            },
            Icon,
          ),
        );
        // 面板主体：main 是 keyed slot，key 必须与上面的 id 相同。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
        );
      },
    };
  },
});
