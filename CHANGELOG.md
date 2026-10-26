# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-27

### Fixed

#### usage-insights
- 面板首屏不再用硬编码 `7d` 覆盖 Host 的 `config.window`；显式选择仍覆盖默认值
- 连续刷新会取消旧请求，旧响应不能覆盖较新的报告
- 负数 `topN` 回退默认值，不再从数组末尾反向截断
- CSV 文件大小按真实 UTF-8 字节数报告
- 真实缓存测试覆盖 30 个创建日截断契约，默认测试不再读取个人 `~/.dsh`

#### session-search
- 摘要定位与官方空白灵活的字面量匹配保持一致，并限制超长查询的摘要长度
- `filterEvents` 与标题回填期间的取消不再被吞掉或延迟到后续会话才生效
- 截断说明使用实际 `maxHitsPerSession`，不再固定写成 5 或承诺可看全部结果
- 工具描述与输出明确历史片段是不可信数据，不是指令

#### devkit
- `docs` / `source` 默认刷新变化内容，并清理解包范围内已经删除的生成文件
- 文档搜索只遍历当前 `INDEX.txt` 中的包，避免返回旧版已删除包的缓存
- 脚手架按 JSON、JavaScript、YAML 上下文转义标题和描述；模板自身提供双语注册并达到零警告
- 客户端禁用模块检查覆盖 `require`、静态/动态 `import` 和 re-export
- 工厂 id 校验读取真实模块 id，不再被文件中其他同名字符串误导

### Added

- GitHub Actions：Node 22.15 与 24 上运行默认测试和插件静态检查
- `npm run test:real`：显式启用本机真实缓存的 Host 交叉验证
- MIT LICENSE 与各包 license 元数据
- 共 163 个测试用例；默认运行 161 个，另 2 个真实缓存用例按需启用

### Changed

- DSH 0.2.1+ 推荐优先使用官方 **Session search**；本插件转为维护模式，保留给需要无索引子串扫描的场景
- 安全文档明确敏感元数据、跨工作区读取、模型提供商传输和不可信历史内容边界

## [0.1.0] - 2026-10-05

### Added

#### usage-insights
- **跨会话token聚合**：支持24h/7d/30d/all时间窗，零I/O读取投影缓存
- **成本估算**：用户可配置价目表（每100万token计费），支持多币种
- **导出系统**：
  - JSON格式（契约化，`schemaVersion: 1`，键集冻结）
  - CSV格式（4个表：summary/workspace/daily/sessions，带UTF-8 BOM + RFC 4180转义 + 公式注入防护）
- **双语界面**：zh/en完整支持，locale注册与官方集成
- **HTTP API**：`/api/usage-insights` 路由，支持格式协商和时间窗参数
- **CLI工具**：无需安装插件即可生成报告（`test/report-real.mjs`）
- **测试覆盖**：81个用例（核心聚合25 + Host集成23 + Client契约14 + 导出契约19）
- **变异测试**：注入23个真实缺陷，全部被测试捕获

#### session-search
- **历史会话检索工具**：模型可调用 `search_past_sessions`，字面量匹配（大小写不敏感）
- **候选保护**：默认最多扫40个会话（可配置），防止全库扫描导致卡顿
- **智能摘要**：按码点截取（不切碎emoji/代理对），带上下文的片段提取
- **透明截断**：`notes` 字段明确说明 `scannedSessions`、`totalHits`、`truncated` 状态
- **参数校验**：Schema严格使用官方支持的子集（避免 `minimum`/`maxLength` 等导致加载失败）
- **测试覆盖**：49个用例（纯逻辑26 + 工具注册与执行23）
- **变异测试**：注入8个缺陷（去掉候选上限、按UTF-16切割、忽略取消信号等），全部被捕获

#### devkit
- **文档提取**：从 `app.asar` 提取287个官方包的README（38,657行）
- **源码提取**：读取已构建的 `lib/` 源码，用于API核对
- **静态校验**：16条规则（语法检查、locale完整性、manifest验证、patch lint等）
- **脚手架生成**：`scaffold` 命令生成插件模板
- **安装指引**：打印GUI操作步骤和绝对路径
- **测试覆盖**：16个用例（14个坏包全部被正确检出）

### Known Limitations

#### usage-insights
- **按单条费率折算**：投影缓存无模型/路由维度，无法按模型分别计价
- **时间窗按创建时间**：筛选依据是会话创建时间，不是最后活动时间（投影缓存无可靠字段）
- **checkpoint延迟**：数据与最后一次checkpoint一样旧（官方write-behind是200事件/5秒）
- **无归因**：无法回答"哪个skill/subagent/MCP server花了多少钱"（需读日志，放弃零I/O）

#### session-search
- **未在真实环境验证**：多帧zstd解析、真实日志性能、GUI集成均未经端到端测试（v0.1.0）
- **字面量匹配**：不支持正则、模糊搜索、语义相似度
- **性能依赖会话数**：默认扫40个会话，若历史庞大或日志巨大可能超时（可调低 `maxCandidateSessions`）

#### devkit
- **非完整YAML解析器**：patch lint是面向Loader补丁子集的结构化检查，不解析全部YAML语法
- **不执行插件代码**：`node --check` 仅验证语法，不解析import，不运行插件逻辑

### Architecture Highlights

- **纯逻辑核心**：`lib/core.js`、`lib/search.js` 无DSH依赖、无I/O，可独立测试
- **契约化导出**：JSON/CSV共用同一份 `lib/report.js`，面板与导出永不漂移
- **变异测试验证**：31处真实缺陷全部被捕获，证明测试不是摆设
- **从源码核对API**：所有官方API调用从已构建 `lib/index.js` 逐个验证，不是照README猜

## [Unreleased]

### Roadmap

#### Phase 2 (3-6个月)
- **多平台成本聚合**：支持Claude Desktop、Cursor、OpenAI API（统一报告）
- **成本预算告警**：macOS系统通知 + 预测性告警（"按当前速度3天后超预算"）
- **模型切换建议**：分析历史会话，识别低效模式（overprovision/underprovision）
- **按模型计费**：读会话日志获取路由信息（代价：放弃零I/O）

#### Phase 3 (6-12个月)
- **独立Tauri桌面应用**：脱离DSH，支持多平台AI工具（<100MB，<1秒启动）
- **行业标准规范**：Local AI Cost Tracking Specification v1.0
- **企业版**：多租户、审计日志、SSO、JIRA集成

### Technical Debt

- **TD-1**: 多帧zstd解析未在真实日志验证（P0，session-search依赖）
- **TD-2**: 前端无构建步骤，无法用TypeScript（P2，技术债不影响功能）

## Version History

- **0.1.0** (2026-10-05): Initial release - devkit + usage-insights + session-search

---

## How to Upgrade

### From 0.x to future 1.0
When `schemaVersion` changes (e.g., from 1 to 2), the export format will have breaking changes:
- JSON keys may be renamed or removed
- CSV columns may change
- External tools consuming exports should check `schemaVersion` field

We will maintain backward compatibility within the same major version (e.g., 0.1.x → 0.2.x).

## Contributing

Found a bug or want a feature? Please open an issue:
https://github.com/shidesheng0218/dsh-desktop-lab/issues

Pull requests are welcome! Please ensure:
- Tests pass: `npm test`
- Static checks pass: `npm run check`
- New features include test coverage
