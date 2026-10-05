# 用量报告导出契约

**`schemaVersion: 1`**

这份文档是 `@local/dsh-usage-insights` 对外数据的**稳定契约**。目标是让外部工具
（脚本、看板、数仓、agent）可以安全地消费它，而不必读插件源码。

**稳定性承诺**：`schemaVersion` 不变时，字段**只增不改不删**。任何删除、重命名或
语义变更都必须递增 `schemaVersion`。这条承诺由
[`packages/usage-insights/test/contract.test.mjs`](../packages/usage-insights/test/contract.test.mjs)
冻结键集来强制——无意的改动会让测试红。

---

## 一、为什么需要这份契约

插件面板显示的数字与导出的数字**出自同一份 `lib/report.js`**。这不是实现细节，而是
契约的一部分：如果两条路径各算一遍，它们会以最难排查的方式漂移（同一份数据、两个数字）。

---

## 二、两个入口

### 1. HTTP（Host 半边）

```
GET /api/usage-insights?window=<24h|7d|30d|all>&format=<json|csv>&table=<表名>
```

| 参数 | 默认 | 取值 | 说明 |
|---|---|---|---|
| `window` | 插件 config 的 `window`（默认 `7d`） | `24h` `7d` `30d` `all` | 非法值**回退**到 config 默认值 |
| `format` | `json` | `json` `csv` | 非法值**返回 400**（不静默回退） |
| `table` | `summary` | `summary` `workspace` `daily` `sessions` | 仅 `format=csv` 有效；非法值返回 400 |

`HEAD` 与 `GET` 同状态码同响应头，但无响应体。

**响应头**

| format | content-type | 额外 |
|---|---|---|
| `json` | `application/json; charset=utf-8` | — |
| `csv` | `text/csv; charset=utf-8` | `content-disposition: attachment; filename="usage-insights-<table>-<window>-<YYYY-MM-DD>.csv"` |

两种格式都带 `cache-control: no-store`。

**错误**：统一返回 JSON `{ ok: false, message }`。`400` = 参数非法；`500` = 取数失败（`message` 里有原因）。

### 2. CLI

```bash
node packages/usage-insights/test/report-real.mjs \
  [--window 24h|7d|30d|all] [--top 10] \
  [--pricing '<JSON>'] [--currency CNY] \
  [--format text|json|csv] [--table <表名>] [--out <文件>]

# --json 是 --format json 的别名，保留历史用法
```

CLI 直接读 `<DSH_HOME>/storages/session_projcache/sessions/*.json`，**不需要装插件**。
它的 JSON 外层多三个字段：`home`、`dir`、`skipped`，`report` 内部与 HTTP 完全一致。

---

## 三、JSON 报告

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": 1791183802786,     // 毫秒时间戳
  "window": { "kind": "7d" },
  "currency": "CNY",
  "totals":   { /* 见下 */ },
  "cost":     { /* 见下 */ },
  "byWorkspace": [ /* 工作区表 */ ],
  "byDay":       [ /* 按天表，最多 30 天 */ ],
  "topSessions": [ /* Token 最多的 N 个会话，N = config.topN，默认 10 */ ],
  "coverage": { "listed": 6, "inWindow": 6, "withoutCacheRecord": 0 },
  "sessions": [ /* 仅当 includeSessions 时出现；见「不静默截断」 */ ]
}
```

### `totals`

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessions` | int | 窗内会话数 |
| `sessionsWithUsage` | int | 其中有 token 记录的 |
| `liveSessions` | int | 当前仍活跃的 |
| `openSteps` | int | 有未闭合 step 的会话数 |
| `tokens` | object | 见下 |
| `stats` | object | 见下 |

`tokens`：`uncachedInputTokens` `cacheReadTokens` `cacheWriteTokens` `outputTokens`
`billableInput`（= 前三者之和）`total`（= `billableInput` + `outputTokens`）
`cacheHitRate`（= `cacheReadTokens / (cacheReadTokens + uncachedInputTokens)`，
**分母不含 cacheWrite**；无可缓存输入时为 `null`）

`stats`：`turns` `steps` `llmMs` `toolMs` `wallMs` `decodeMs` `decodeTokens`

### `cost`

未配置价目表：`{ "available": false, "currency": "CNY", "reason": "no-price-table" }`

已配置：`{ "available": true, "currency", "amount", "basis": "aggregate-single-rate", "price": {...} }`

> **这不是账单。** 官方 287 个包里不存在任何货币价格数据，金额完全来自使用者配置的价目表。
> 投影缓存不含路由/模型维度，因此**全部 token 按同一条费率折算**（`basis` 字段即此含义）。

### `coverage`

| 字段 | 说明 |
|---|---|
| `listed` | 列出的会话总数 |
| `inWindow` | 落在时间窗内的 |
| `withoutCacheRecord` | 没有投影缓存记录的（只出现在 Host 路径；CLI 用 `skipped` 表示损坏文件数） |

---

## 四、CSV

### 四个表

| 表 | 一行代表 | 需要的调用方式 |
|---|---|---|
| `summary` | 整个报告 | 默认 |
| `workspace` | 一个工作区 | — |
| `daily` | 一个本地日期 | — |
| `sessions` | **一个会话**（最细粒度） | 必须 `includeSessions` / `--table sessions` |

列名见 `lib/report.js` 的 `TABLES`——那是 JSON 与 CSV 共用的唯一列定义。

### 三条必须知道的行为

**1. 输出带 UTF-8 BOM（`EF BB BF`）。**
Excel 不带 BOM 打开 UTF-8 CSV 会中文乱码。程序化消费方需要自行剥掉前三个字节。
注意 `Response.text()` 按 WHATWG 规范会**自动**剥掉 BOM，所以用 `arrayBuffer()` 才能看到它。

**2. 公式注入防护。**
以 `=` `+` `@` 或制表符/回车开头的单元格会被加上前导单引号 `'` 降级为文本——
否则 Excel / Numbers 会把它当公式执行。`-` 开头**仅在不构成合法数字时**才加引号，
所以 `-42` 和 `-1.5e3` 保持原样，不会被误伤成文本。

**3. 遵循 RFC 4180 转义**：含 `"` `,` `\n` `\r` 的值整体加双引号，内部的 `"` 双写。

### 不静默截断

`sessions` 表**只在真正拿到全量明细时才生成**。如果报告没有携带明细，
`toCsv(report, 'sessions')` 会**抛错**，而不是退化成用 `topSessions`（默认只有 10 条）冒充全量。
这是刻意的：一份看起来完整、实际被截断的导出，比一次明确的失败危险得多。

---

## 五、明确的已知限制（属于契约的一部分）

- **时间窗按「会话创建时间」筛选**，不是最后活动时间。官方投影缓存没有可靠的最后活动字段。
- **金额按单条费率折算**，无法按模型分别计价。
- **数据与最后一次 checkpoint 一样旧**（官方 write-behind 是 200 事件 / 5 秒一次），但永不会错。
- **没有归因**：无法回答「哪个 skill / subagent / MCP server 花了多少钱」。
  投影缓存不含该维度；补上它需要读会话日志并放弃零 I/O。
- `byDay` 最多保留最近 30 天（报告层面），CSV 与 JSON 一致。

---

## 六、消费示例

```bash
# 导出全部会话明细为 CSV，直接给表格软件
node packages/usage-insights/test/report-real.mjs --window 30d --format csv --table sessions --out usage.csv

# 程序化消费：剥 BOM 后按列名取值
node packages/usage-insights/test/report-real.mjs --format json | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const {report}=JSON.parse(s);
  console.log(report.schemaVersion, report.totals.tokens.total);
});"
```
