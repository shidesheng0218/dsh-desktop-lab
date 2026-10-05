# DSH 桌面版官方能力缺口审计

审计对象：`@deepseek-ai/dsh-desktop` **0.2.0-rc.2**
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`

方法：全量提取并阅读 287 个官方包的 README（共 38,657 行）→ 逐条挖出
1,038 条 `## Known Limitations and Deferred Work` 条目 → 对关键结论回到
`lib/index.js` 已构建源码与 Electron 主进程代码做二次核对。

判据：桌面版 = Electron 外壳 + Cordis 插件树。**能补的只有 Cordis 层**
（Host 插件 / UI 插件的 slot / MCP / 技能）；Electron 主进程的东西插件补不了。

复现方式：

```bash
dsh-devkit docs                    # 抽出全部官方 README 到 .cache/dsh-official
dsh-devkit search "关键词"          # 在抽取结果里检索
dsh-devkit source <包名>            # 读某个包的已构建源码
```

---

## A. 官方没有、插件能补

| # | 缺口 | 证据 | 补的扩展点 |
|---|---|---|---|
| 1 | **跨会话用量聚合** | `dsh-token-meter` 的 `tokenUsage` 是"the complete durable log's"单个会话；官方界面只有单轮 + 单会话 | `ctx.sessionQuery` + `ctx.sessionProjectionCache` |
| 2 | **货币计费概念** | 287 个包无价目表、无成本字段；`dsh-token-meter` 的 pricing 仅图片 token 定价，且自称 "Occupancy is a reference figure, **not a billing record**" | 插件自带价目表 |
| 3 | **桌面系统通知** | 无通知相关包；`dsh-schedule` 只把提醒写成 "follow-up messages in their original Session"；`dsh-user-approval` "No built-in answerer"，headless 直接 fail closed | 客户端 `Notification` + `shell.overlay` |
| 4 | **会话全文检索** | `dsh-base/cordis.patch.yml` 注释原文："the Web sidebar search **matches titles and workspace names only**"；`openAt: never` 默认关；FTS 是 token 非子串、同步阻塞、无鉴权；GUI 上限 20 条且跳不到命中事件 | 替换 `sessionQuery` 后端 |
| 5 | **命令面板 / 全局搜索** | 62 个客户端包里零提及 | `main` keyed slot + `sidebar.panellist` + `ctx.shortcuts` |
| 6 | **长期 / 语义记忆** | 无 memory / RAG / vector / embedding 任何一个包；`dsh-tool-ralph`："The workspace is the long-term memory across rounds" | `ctx.tools.register` + `ctx.skills` |
| 7 | **MCP 服务端模式** | 只有 `dsh-mcp-client` + `dsh-mcp-resources`，无法把 DSH 工具暴露给别的 MCP 客户端 | `ctx.tools.schemas` + 自建传输 |
| 8 | **模型侧上下文管理** | `dsh-compaction`："**Human command, not a model tool** — no model-facing compaction tool is registered"；`dsh-agent-loop` "**No built-in turn budget**" | `ctx.tools.register` + `ctx.compaction` |
| 9 | **保留策略** | "**No Session deletion** — sessions can be archived but never deleted"（`dsh-client-ui-workspace`）；"**Attachments are never deleted**"（`dsh-attachment`）；"**No deletion or retention API**"（`dsh-session-persistence`） | 无 seam API，只能带外清理 |
| 10 | **界面细节** | 文件树 "**Listing only.** No search, artifact filter, drag-and-drop, rename, context menu"；文档预览 "**Preview, not editing.**"；目录选择器 "**No search, no multi-select, and no rename or delete**" | `ctx.sidebarRightTabs.register` / `ctx.documentPreviews.register` |
| 11 | **第三种语言** | 只有 zh / en；`ctx.locale.register(ns, {zh, en})` 强制两种 | locale 语言包 |
| 12 | **Git 集成** | 无 git / vcs 包；`dsh-workspace-changes` 的 diff 只活在本进程，"earlier turns … have no card and no comparison" | 侧栏页签 + storage domain |
| 13 | **用量/统计导出** | 无 CSV/JSON/仓库导出路径；最近的 telemetry seam 默认 `FEEDBACK_ONLY` 且 "Best-effort delivery"、"no durable outbox" | 自建路由或 CLI |
| 14 | **模型可用的历史检索工具** | `dsh-session-query` 的 Dev Note 指向 `../tool-session-query/`，该包**不在发行集中** | `ctx.tools.register` |

## B. 官方没有、插件补不了（需改核心）

| 缺口 | 证据 |
|---|---|
| **macOS 托盘 / 菜单栏常驻** | `lib/main.js` 里 `DesktopTray` 仅在 `if (process.platform === "win32")` 分支创建 |
| **全局快捷键、开机自启** | 主进程里 `globalShortcut`、`setLoginItemSettings` 各 **0 次**引用 |
| **手机 / 异地访问** | `dsh-client-connection`："`dsh web --host 0.0.0.0` remains unsupported" |
| **跨设备同步** | `dsh-client-store`："Persistence is browser-local … provides no cross-device synchronization" |
| **消息编辑 / 重新生成 / 回退** | 62 个客户端包里零提及 |
| **审批只支持一次性授权** | `dsh-user-approval`："Only one-shot grants exist … no `allow-always`, remembered rule, revocation, or grant store" |
| **参数重写** | `dsh-tools`："`tools/pre-execute` deliberately cannot rewrite `exec.arguments`" |

## C. 官方自身的发行瑕疵（顺带发现）

- **`dsh-tool-terminal` 被引用却没有随包发布** —— `dsh-terminal` 的文档写明模型侧工具由它提供，
  但 287 个包里没有这个包。持久终端服务因此没有模型入口。
- 同样缺席：`dsh-subagent-acp`、`dsh-sdk-client`、`dsh-web-search-exa`、`dsh-session-title-all-prompts-llm`。
- **`libreoffice-kit` 的 README 是 13,189 个 NUL 字节**，内容不可读。
- 发行版**不含任何 `.d.ts`**，而 `cordis-plugin-development` 技能文档称
  "installed packages ship `lib/index.js` and `lib/types/**/*.d.ts`" —— 该说法在 Desktop 上不成立。

## D. 一个反直觉的实测量化

"存储只涨不减"看着像好项目，但实测本机 `~/.dsh` 共 591 MB：

| 目录 | 占用 |
|---|---|
| `dsh-runtimes` | 359 MB |
| `speech-to-text` | 230 MB |
| `sessions` | 1.6 MB |
| `storages` | 124 KB |
| `profiles` | 16 KB |

98% 是运行时与模型，会话数据可以忽略。**所以现在做存储清理并不划算** —— 这也是本项目
没有选它的原因。

---

## 参考：本项目用到的官方 API（均从已构建源码核对）

| API | 出处 | 签名要点 |
|---|---|---|
| `ctx.sessionQuery.listSessions(signal)` | `dsh-session-query/lib/index.js` | 返回 `[{header, live, persisted}]`，最新在前，不读日志 |
| `ctx.sessionProjectionCache.cachedSnapshot(meta, keys)` | `dsh-session-projection-cache/lib/index.js` | **同步、零 I/O**；返回 `{asOfSeq, values}` 或 `undefined`；`values` 是**解包后**的值 |
| `ctx.connection.fetch.register({path, methods, requestBody, fetch})` | `dsh-client-connection/lib/index.js` | 路径必须在 `/api/` 之下，否则 `assertFetchRoute` 抛错 |
| `ctx.slots.register({name, id, order, label}, Icon)` | `dsh-client-ui-sidebar/lib/client.js` | `sidebar.panellist`；侧栏自己调 `selectPanel(id)`；图标 props 为 `{size, active}` |
| `ctx.slots.register({name, key}, Page)` | `dsh-client-ui-schedule/lib/client.js` | `main` 是 keyed slot，`key` 必须等于 panellist 的 `id` |
| `window.__ModuleLoader__.load({id, factory})` | 官方 UI 插件模板 | `id` 必须等于包名；React 从浏览器模块表里 `require('react')` |
| 主题令牌 `--dsw-alias-label-*` / `--dsw-font-*` / `--dsw-radius-*` | `dsh-client-ui-theme/lib/client.js` | 共 403 个；字体是 `13px/20px var(--dsw-font-family)` 形式的简写值 |

## 部署形态速查

| 项 | 值 |
|---|---|
| profile 目录 | `~/.dsh/profiles/desktop/` |
| 已选 bundles | `dsh-base`、`dsh-web-app`、`dsh-experimental-agent-team-profile`、`dsh-experimental-auto-review`、`dsh-experimental-schedule-bundle`、`dsh-experimental-voice-input-bundle` |
| 会话日志 | `~/.dsh/sessions/<编码后项目路径>/<sessionId>/session.v4.jsonl.zstd` |
| 会话日志格式 | **多帧拼接 zstd**：首帧只有 header，之后每次 durable append 一帧。Node 的 `zstdDecompressSync` 只解第一帧（实测 308 KB/194 帧只解出 214 字节），必须自己按帧扫描 |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`，`per-record` 布局 |
| 技能扫描根 | `<项目根>/.dsh/skills`、`<项目根>/.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`，带 watch 热更新 |
