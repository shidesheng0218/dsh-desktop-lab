/**
 * Client 半边：在浏览器里运行，只负责渲染。
 *
 * 这个文件是「不打包」的写法——直接交给浏览器，不需要构建步骤。
 * React 从浏览器模块表里取（基线模块，不需要自带副本）。
 *
 * 挂载点沿用官方 shipped 代码验证过的两段式（对照 dsh-client-ui-schedule）：
 *   sidebar.panellist  左侧栏的图标按钮；侧栏自己调用 selectPanel(id)，
 *                      图标组件只负责画字形，props 是 { size, active }。
 *   main               面板主体，keyed 注册，key 必须等于 panellist 的 id。
 */
window.__ModuleLoader__.load({
  id: '__PACKAGE_NAME__',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = '__PANEL_ID__';
    const DATA_PATH = '/api/__PANEL_ID__';

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
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 19V5' }),
        h('path', { d: 'M4 19h16' }),
        h('path', { d: 'M8 16V9' }),
        h('path', { d: 'M13 16v-4' }),
        h('path', { d: 'M18 16V7' }),
      );
    }

    function Page() {
      const [state, setState] = React.useState({ status: 'loading' });

      React.useEffect(() => {
        let cancelled = false;
        fetch(DATA_PATH, { credentials: 'same-origin' })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
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
      }, []);

      const themes = {
        color: 'var(--dsw-alias-text-primary, inherit)',
        background: 'var(--dsw-alias-background-primary, transparent)',
      };

      if (state.status === 'loading') {
        return h('div', { style: { padding: 16, fontSize: 13, ...themes } }, '加载中…');
      }
      if (state.status === 'error') {
        return h(
          'div',
          { style: { padding: 16, fontSize: 13, ...themes } },
          `取数失败：${state.message}`,
        );
      }
      return h(
        'div',
        { style: { padding: 16, fontSize: 13, ...themes } },
        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '__TITLE__'),
        h('pre', { style: { whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 } },
          JSON.stringify(state.data, null, 2)),
      );
    }

    return {
      // inject 声明本半边依赖 slots 服务；缺它就保持未激活。
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => '__TITLE__',
            },
            Icon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Page),
        );
      },
    };
  },
});
