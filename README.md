# DSH Desktop Lab

为 **DeepSeek Harness 桌面版**（`@deepseek-ai/dsh-desktop` 0.2.0-rc.2）开发插件的项目。

包含两件东西：

| 包 | 作用 |
|---|---|
| [`packages/devkit`](packages/devkit) | 工具链：抽取 `app.asar` 里的官方文档与源码、生成插件骨架、装机前静态校验 |
| [`packages/usage-insights`](packages/usage-insights) | 插件本体：**跨会话用量与成本面板**，挂在桌面版左侧栏 |

---

## 为什么做这个

官方发行版有 287 个包，但有一批用户能感知的能力是明确缺失的。完整的审计证据见
[`docs/official-gaps.md`](docs/official-gaps.md)，这里只列与本项目直接相关的四条：

1. **没有跨会话用量聚合。** `dsh-token-meter` 只折叠单个会话，官方界面只有单轮与单会话用量。
   官方自己在 README 里写着 `Occupancy is a reference figure, not a billing record`。
2. **官方没有任何货币计费概念。** 287 个包里没有价目表、没有成本字段——`dsh-token-meter`
   里唯一的 pricing 是图片 token 定价。所以金额只能由使用者自己填价目表。
3. **桌面版把文档锁在 `app.asar` 里。** `app.asar/dsh/node_modules/...` 在真实文件系统上
   不存在，shell、ripgrep、甚至 `node` 的 fs 都读不到；而且发行版**一个 `.d.ts` 都没有**
   （官方技能文档里"installed packages ship `lib/types/**/*.d.ts`"这句在 Desktop 上不成立）。
4. **插件工具链是断的。** `plugin_manager` 工具行在 base bundle 里是 `disabled: true`，
   agent 默认无法自助安装插件；manifest、patch、client bundle 的硬性约定散落在多篇文档里，
   违反了要等到 pnpm 装完、Loader 组合时才发现。

这个项目就是把这四条接上：devkit 解决 3 和 4，usage-insights 解决 1 和 2。

---

## 快速开始

前置：macOS 上安装了 DeepSeek Harness 桌面版；Node ≥ 22.15（用系统 Node 即可，无需 pnpm）。

### 1. 装插件（在 GUI 里，约 1 分钟）

```bash
# 先确认包是干净的
node packages/devkit/bin/dsh-devkit.mjs check packages/usage-insights

# 打印带绝对路径的安装指引
node packages/devkit/bin/dsh-devkit.mjs install packages/usage-insights
```

然后按提示操作：

1. 桌面版左侧栏最下方找到 **Plugins**（插件）
2. 点 **Add plugin**（添加插件）
3. 粘贴 `packages/usage-insights` 的**绝对路径**
4. **Install** → 完成后选 **Enable now**
5. 左侧栏出现柱状图图标，点开即是面板

### 2. 不想装插件也能看数

```bash
npm run real                                   # 用本机真实数据直接出报告
node packages/usage-insights/test/report-real.mjs --window 30d --top 10
node packages/usage-insights/test/report-real.mjs \
  --pricing '{"default":{"input":2,"output":8,"cacheRead":0.2,"cacheWrite":2}}' --currency CNY
```

### 3. 配置价目表

官方不提供任何价格数据，所以金额默认显示「未配置」。要看到估算金额，在安装后于
Plugins 页面找到本插件、编辑它的 config 行：

```yaml
- id: usage-insights
  name: '@local/dsh-usage-insights'
  config:
    window: 7d          # 24h | 7d | 30d | all
    currency: CNY
    topN: 10
    pricing:
      default:
        input: 2        # 每 100 万 token，未缓存输入
        output: 8
        cacheRead: 0.2
        cacheWrite: 2
```

**面板上的金额是估算，不是账单。** 官方投影缓存里没有路由/模型维度，
所以全部 token 按同一条价目表折算；这个口径同时写在面板页脚和 `lib/pricing.js` 的注释里。

---

## devkit 用法

```
dsh-devkit where              打印解析到的安装位置与发行版本
dsh-devkit docs               抽取全部官方包 README 到 .cache/dsh-official/
dsh-devkit source <pkg...>    抽取官方包已构建的 lib/ 源码（读真实 API 用）
dsh-devkit search <关键词>    在已抽取文档里检索
dsh-devkit scaffold <目录> --name @local/my-panel
dsh-devkit check <目录>       装机前静态校验
dsh-devkit install <目录>     打印 GUI 安装指引
```

`source` 命令是本项目所有 API 结论的来源。例如 Host 半边的取数链路：

```bash
dsh-devkit source dsh-session-query dsh-session-projection-cache dsh-client-ui-theme
# 然后读 .cache/dsh-official/dsh-session-projection-cache/lib/index.js
```

`check` 覆盖的规则（每条都有对应的失败用例，见 [`packages/devkit/test`](packages/devkit/test)）：
缺 `dsh.bundle.patch`、patch 顶层不是数组、补丁行缺 `name`、YAML 用制表符缩进、
`exports["./client"]` 缺失、client bundle 没调 `__ModuleLoader__`、工厂 id 与包名不一致、
client bundle `require` 了 `@deepseek-ai/dsh-client-*`（官方明令禁止）、JS 语法错误、
locale 键不一致、图标越界或缺失、声明了运行时依赖、
**client bundle 有中文文案却没注册 locale**（启发式，见下）。

最后一条是本项目自己踩过的坑：界面文案一度硬编码中文，英文界面下会整片显示中文。
现在这条规则会提前报警 —— 把 `locale.register` 从 client bundle 里删掉，
`check` 立刻报出「51 处含中文的字符串字面量，但没有调用 locale.register()」。

---

## 架构

```
packages/usage-insights/
├── index.js            Host 半边：注入官方服务取数 + 注册 /api 路由
├── lib/core.js         纯逻辑：规范化 + 折叠成报告（无 DSH 依赖，可单测）
├── lib/pricing.js      价目表与成本估算
├── client.js           Client 半边：左侧栏图标 + 面板（React，无构建步骤，zh/en 双语）
└── test/               55 个用例
```

取数链路（每一处 API 都从官方**已构建源码**核对，不是照 README 猜的）：

```
ctx.sessionQuery.listSessions()                    // [{header, live, persisted}]，不读日志
  └─ ctx.sessionProjectionCache.cachedSnapshot(header, keys)   // 同步、零 I/O
       └─ lib/core.js aggregate()                 // 纯函数
            └─ GET /api/usage-insights            // 连接层 exact Fetch 路由
                 └─ client.js fetch() → 面板
```

挂载点沿用官方 shipped 代码验证过的两段式（对照 `dsh-client-ui-schedule`）：

```js
ctx.slots.register({ name: 'sidebar.panellist', id: 'usage-insights', order: 40, label }, Icon)
ctx.slots.register({ name: 'main', key: 'usage-insights' }, Panel)   // key 必须等于上面的 id
```

侧栏自己负责 `selectPanel(id)`，图标组件只画字形。

---

## 验证状态（请按这个来判断可信度）

**已验证：**

- `packages/devkit/test` 16 个用例，含 14 个刻意构造的坏包/坏 bundle，全部被正确报出
- `packages/usage-insights/test` 55 个用例：聚合核心 25 个、Host 集成 16 个、Client 契约 14 个
- **变异测试**：先后注入 10 个真实缺陷（按天重复累加、命中率分母用错、面板 key 不一致、
  字面颜色、成本退化 0 元、金额措辞丢失、时间窗只筛不标注、en 词典缺键、
  en 值写成中文、绕开 `t()` 硬编码、词典注册脱离 `ctx.effect`），
  全部被测试抓住 —— 证明测试能失败，不是摆设。
  其中前两轮各有漏网（断言被页脚文案意外满足、只查了错误态），补强后才收敛。
- **真实数据交叉验证**：Host 链路跑在本机真实投影缓存上，与独立重算的结果逐位一致
- Client 半边在模拟浏览器环境里真正执行过，加载态/成功态/失败态都渲染出内容
- **locale 接线完整性**：英文渲染下断言「结果里不得出现任何中日韩字符」，
  另加两种语言键集一致、缺 locale 服务时不显示原始键名三条互相独立
- **挂载链路**：从官方 `ui-sidebar` / `ui-layout` / `ui-slots` 已构建源码逐环核对
  （面板列表来源、`selectPanel` 的 `hasMainPanel` 校验、`resolveSlotLabel` 支持函数）
- `dsh-devkit check` 对本插件零错误零警告

**未验证（能力所限，如实说明）：**

- **插件尚未安装进 GUI。** 本会话没有 `plugin_manager` 工具（该行默认 `disabled: true`），
  profile 写入在沙箱工作区之外。所以：Loader 是否真的挂起这个包、路由是否真的被服务、
  面板在真实 React 下的外观——都还没有被观察过，需要你装一次确认。
- 界面用到的主题令牌名取自官方 `dsh-client-ui-theme` 的令牌表（403 个），
  但每个都带兜底值，没有在真实渲染里逐一核对。
- 面板未做视觉验证（无浏览器控制）。

安装后如果出问题，可对照的排查点：面板空白 → 看 DevTools console 有没有
`slot entry crashed in '<slot>'`；面板显示取数失败 → 面板会直接显示 Host 返回的原因。

---

## 已知限制

- **时间窗按「会话创建时间」筛选**，不是最后活动时间。官方投影缓存里没有可靠的最后活动字段。
- **金额按单条价目表折算**，无法按模型分别计价——投影缓存的 `tokenUsage` 只有四个 token 桶，不含路由/模型。
- **数据与最后一次 checkpoint 一样旧**（官方 write-behind 是 200 事件 / 5 秒一次），但永不会错。
- **界面文案只有 zh / en 两种**。官方的 locale 回退链必须终止于 `en`，所以新增第三种语言要另外提供
  一份词典并声明回退链；当前词典写在 `client.js` 里（无构建步骤，不能 import JSON），
  `locale/*.json` 另有用处 —— 它们是宿主机读取的**插件卡片展示元数据**，与界面文案是两回事。
- 重新安装同一个包需要重启 DSH 才会加载新的 JS 模块代（官方行为）。
- Node 版本需 ≥ 22.15：`zstd` 与新的 `node --test` glob 行为都依赖它。

## 路线图

- 按模型分别计价：读会话日志里的 `request/header` 拿路由，代价是放弃零 I/O
- 成本预算告警：接 `shell.quota-notice` chain
- 历史趋势与导出（CSV / JSON）

## 开发

```bash
npm test        # 68 个用例
npm run check   # 插件包静态校验
npm run docs    # 重建官方文档缓存
npm run real    # 真实数据报告
```
