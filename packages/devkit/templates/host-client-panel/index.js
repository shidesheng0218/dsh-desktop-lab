/**
 * Host 半边。
 *
 * 它跑在 DSH 主进程里，能注入 Cordis 服务、访问文件系统、注册 HTTP 路由。
 * 浏览器半边（client.js）拿不到这些能力，所以两者分工是：
 *   Host 负责取数与计算，Client 只负责渲染。
 *
 * 对外供数的正道是连接层的 exact Fetch 路由（官方 dsh-session-log-export
 * 的 ZIP 下载走的就是这条路）：路径必须落在 /api/ 下，浏览器侧用同源
 * fetch 带上会话 cookie 取回。
 */

/** 路由必须位于 /api/ 之下，否则连接层在注册时就会抛错。 */
const DATA_PATH = '/api/__PANEL_ID__';

/**
 * 服务可用性用 ctx.inject 声明：缺少任一服务时本插件保持未激活，
 * 而不是抛异常拖垮整个 profile。
 */
export const inject = ['connection'];

/**
 * @param {import('cordis').Context} ctx
 * @param {object} config 来自补丁行 config 的取值
 */
export function apply(ctx, config = {}) {
  const payload = async () => ({
    generatedAt: new Date().toISOString(),
    note: '把这里替换成真实数据。',
    config,
  });

  // connection.fetch.register 内部已经用 owner.effect 管理生命周期，
  // 与官方 session-log-export 的写法一致。
  Reflect.get(ctx, 'connection').fetch.register({
    path: DATA_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = JSON.stringify(await payload());
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
      if (request.method === 'GET') return response;
      // HEAD 要求没有响应体。
      await response.body?.cancel();
      return new Response(null, { status: 200, headers: response.headers });
    },
  });
}
