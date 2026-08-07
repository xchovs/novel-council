# Novel Council 决策日志

> 状态：v0.5（并入 2026-08-06 C5 决定 D31）

> 记录 2026-08-05 用户反馈（十二条决定）与阶段 2 规划确认的全部生效决定。与规划原文出入处，以本日志为准。
> 格式：编号 / 决定 / 来源 / 主要影响文档。

---

## 已生效决定

### D1 架构形态
单仓库、单 package、内部模块化结构（架构 A）。当前不采用 monorepo。仅当未来开始增加 MCP 或第二个正式宿主，**且**单包边界已造成明显维护问题时，才迁移为 workspaces。
来源：用户反馈·确认段。影响：architecture §3、§4。

### D2 平台边界
Pi / PI WEB 是当前第一优先运行入口；Pi 不是核心依赖；Pi Extension 只能作为薄适配层；Cline 和 VS Code 仅用于开发；不得使用 Cline SDK、Agent Teams、VS Code API 作为运行时依赖。
来源：用户反馈·一.1–4。影响：architecture §1。

### D3 目标运行时
当前目标服务器运行环境按 **Node.js 22** 设计。
来源：用户反馈·一.5。影响：architecture §13、implementation-plan §1。

### D4 Pi 调研边界
当前阶段不得连接 VPS，不得检查或修改远程 Pi 安装；可以阅读公开的 Pi 官方 Extension、Skill、示例文档，但只用于架构调研，不得运行远程命令；Pi Extension 的打包方式、工具超时、进度展示能力若无法通过官方文档确定，**标记为阶段 4 待验证事项，不得自行假定**。
来源：用户反馈·一.6–8。影响：architecture §7、open-questions Q01–Q04。

### D5 核心与 Pi 的连接方式
不写死单一部署方式。候选：**A. Pi Extension 直接 import 已构建的核心库（暂定优先）**；B. Pi Extension 调用独立 CLI 子进程。最终决定待阶段 4 阅读实际 Pi 版本文档并做最小验证后确认。**不得设计本地 HTTP 常驻服务作为第一选择。**
来源：用户反馈·二。影响：architecture §7。

### D6 阶段 1 Provider 范围
阶段 1 只支持 OpenAI-compatible API；自动化测试只使用 MockProvider；开发过程中不连接真实模型 API；Anthropic、Gemini 等原生协议适配推迟；不使用任何厂商 LLM SDK（原生 fetch + provider adapter）；不引入 LangChain、AutoGen、CrewAI、Cline SDK 等 Agent 框架。
来源：用户反馈·三。影响：architecture §5、§13；implementation-plan §3。

### D7 阶段 1 报告行为
CLI 默认把 FinalCouncilReport 输出到 **stdout**；可选 `--output <path>` 由用户明确指定时才写文件；**阶段 1 不自动创建 `.story-engine/reports`**；每次运行生成唯一 `runId`；FinalCouncilReport 必须包含可追溯成员报告的 `rawRefs`/`reportIds`；不实现 canon、checkpoint 或正式状态提交。
来源：用户反馈·四。影响：architecture §11；data-contracts §6、§9。

### D8 Scene Packet 内容策略
子模型所需正文/设定摘录**必须内联**进 Scene Packet；`sourceReferences` 路径仅用于来源追溯，不得假定远程模型能读本地文件；不得无选择地发送整个项目文件或全部聊天记录；阶段 1 使用可配置的 `maxInputChars`（字符，非 token），**默认 50000**；超限必须明确报错，**禁止静默截断**；按模型上下文窗口计量 token 的能力属于后续阶段。
来源：用户反馈·五。影响：data-contracts §2.1；architecture §10。

### D9 报告体积
阶段 1 使用 `maxReportChars`（非 token），**默认 20000**；裁剪必须按完整字段、完整数组项或优先级进行；**任何情况下不得从字符串中间截断导致无效 JSON**；原始成员结果保留为内部 MemberReport，FinalCouncilReport 只返回压缩结论与引用。
来源：用户反馈·六。影响：data-contracts §5、§6.2。

### D10 阶段 1 调用预算
阶段 1 只有 quick 模式：world 1 成员 + character 1 成员；并发上限 2；正常调用 2 次；每个 worker 最多 1 次格式修复调用；`maxTotalCalls` **4**；不进行主持人调用、交叉评议、跨组模型协调调用。standard / deep 的预算在阶段 2、3 再定义。
来源：用户反馈·七。影响：architecture §8。

### D11 依赖审批
**批准**：typescript（类型检查/编译）、vitest（自动化测试）、zod（运行时校验与契约单一来源）、tsx（本地开发/CLI 调试）。构建优先使用 tsc。
**不批准**：tsup/tsdown 等 bundler、Pi SDK、Cline SDK、LLM 厂商 SDK、Agent 框架、数据库。阶段 4 接入 Pi 时，再根据真实扩展格式决定是否需要 bundler。
来源：用户反馈·八。影响：architecture §13。

### D12 隐私与外部 API
用户知情并接受：运行时被选中的小说摘录会发送给用户明确配置的第三方模型 API。系统约束：README 和配置文档明确提醒；只向实际启用的成员发送必要内容；不允许隐藏调用未配置或未启用的 provider；API Key 不进入源码、日志、报告或错误信息；不进行后台自动上传；阶段 1 不实现复杂的隐私确认 UI。
来源：用户反馈·九。影响：architecture §12；implementation-plan T11。

### D13 Pi 触发方式
第一版：用户手动输入 `/scene-sim`，或主模型按 Pi Skill 明确调用 `simulate_scene`。不得自动拦截每次正文生成；不得在用户不知情时自动运行评议。
来源：用户反馈·十。影响：architecture §14。

### D14 暂缓决定
以下事项当前不阻塞阶段 0/1，推迟：standard/deep 成员数量；作家视角成员；主持模型；多轮讨论；Markdown 可读报告；Pi 项目级/全局安装；MCP；WebUI；canon 和状态提交。
来源：用户反馈·十一。影响：open-questions（按阶段登记）。

### D15 阶段 0 范围限制
阶段 0 只允许创建 `docs/` 及六份文档（architecture、data-contracts、implementation-plan、risk-register、decision-log、open-questions）；不创建 package.json、src、tests、prompts、schemas、examples；不安装依赖；不编写业务代码；不修改原始规划文档和 .clinerules；完成六份文档后立即停止，不自动进入阶段 1。
来源：用户反馈·十二。影响：本次交付范围。

### D16 Mock Provider 门禁
配置 schema 允许 `provider: "mock"`；普通 CLI `simulate` 默认拒绝 mock 配置，必须显式传入 `--allow-mock` 才允许执行；`examples/councils.mock.example.json` 明确标注仅供测试；README 警告 Mock Provider 不产生真实模型推演结果；自动化测试与本地 mock 端到端测试可使用该参数；未来 Pi Extension 不得默认开启 allowMock。
来源：2026-08-05 阶段 1 批准反馈·一。影响：data-contracts §4/§9；implementation-plan T08、矩阵 A。

### D17 generationParams 保留字段禁令
成员可配 `generationParams` 透传生成参数，但禁止保留字段 `model`、`messages`、`stream`、`tools`、`tool_choice`；出现时 check-config 与 simulate 均返回 `CONFIG_INVALID`，不得静默忽略；核心必要字段由程序控制，不允许被 generationParams 覆盖。
来源：2026-08-05 阶段 1 批准反馈·二。影响：data-contracts §4。

### D18 extraHeadersEnv
阶段 1 不允许配置文件存放明文 header 密钥；使用 `extraHeadersEnv: Record<string, string>`，key 为实际 Header 名、value 为环境变量名；解析到的所有 Header 值必须注册进 redactor，不得出现在日志、报告或错误信息中。
来源：2026-08-05 阶段 1 批准反馈·三。影响：data-contracts §4/§7。

### D19 baseUrl 语义
`baseUrl` 一律为 API 根地址（如 `https://api.example.com/v1`）；adapter 负责追加 `/chat/completions` 并规范化末尾斜杠；不允许不同成员混用根地址与完整 endpoint 语义；该约定写入配置说明与 README。
来源：2026-08-05 阶段 1 批准反馈·四。影响：data-contracts §4；README。

### D20 CLI 输出信封
CLI `simulate` 输出完整 SimulateResult 信封 `{ ok, report, memberReports, councilResults }`：`report.rawRefs` 可经 `reportId` 在 `memberReports` 中解析；部分失败仍返回已有 `memberReports`；两组全部失败时 `ok:false` + `ALL_COUNCILS_FAILED` + 保留成员失败报告 + 不伪造 FinalCouncilReport；`--output` 写入同一完整信封；`check-config` 使用独立的检查结果信封。
来源：2026-08-05 阶段 1 批准反馈·五。影响：data-contracts §7/§9。

### D21 stdout 与 stderr 分离
stdout 只输出最终机器可读 JSON；stderr 用于进度、警告与人类可读错误；stdout 禁止调试日志、启动文字与进度提示；CLI 测试必须验证 stdout 可直接 `JSON.parse`。
来源：2026-08-05 阶段 1 批准反馈·六。影响：data-contracts §9；implementation-plan 矩阵 A。

### D22 阶段 1 计划细节批准
对阶段 1 实施计划所列 Q-A~Q-F 全部批准，含：`@types/node`（纯类型 dev 依赖，无运行时代码）加入批准清单；`schemas/` JSON Schema 仅在所装 zod 版本原生支持导出时生成，否则阶段 1 放弃（DoD 不要求）；`rolePromptPath` 由 CLI 读文件后内联传给 core（core 保持零文件 IO），相对路径按配置文件所在目录解析；组级 `insufficient` 经 `SimulateResult.councilResults` 暴露，不改 FinalCouncilReport 契约。
来源：2026-08-05 阶段 1 批准反馈。影响：data-contracts §4/§11；implementation-plan。

### D23 阶段 2 范围与边界
阶段 2 交付：每组多成员独立第一轮推演（全局并发池限流）、council-kind 注册表（仅 world/character，未知组 id 显式拒绝）、quick/standard 两种模式、组内主持汇总（CouncilReport）、传输错误分类与有界重试、预算调用量预估。阶段 2 **不做**：deep 管线、成员互评/交叉质询/跨组协调/定向重跑（阶段 3）、writingCouncil、报告自动留档（之后单独设计）、Pi Extension/Pi Skill（阶段 4）、MCP、canon/状态提交（阶段 6）。
来源：2026-08-05 阶段 2 规划确认。影响：architecture §8/§15；implementation-plan §5。

### D24 deep 在阶段 2 显式拒绝
`SimulateOptions.mode` schema 接受 `quick | standard | deep` 三值（契约前向稳定）；阶段 2 orchestrator 对 `deep` 一律返回 `CONFIG_INVALID`，消息指明阶段 3 开放成员互评/交叉质询/跨组协调；禁止静默降级为 standard 或伪装支持。`FinalCouncilReport.mode` 阶段 2 仅 `quick | standard`。
来源：2026-08-05 阶段 2 规划确认·D2 修订。影响：data-contracts §3/§6。

### D25 组内主持（moderator）形态
`CouncilEntry.moderator` 可选：`useMember` 复用同组某启用成员的连接配置，或内联独立连接配置，二者互斥；默认不配置。quick 模式不调用主持（配置了则跳过并 warning）；standard 模式每组 0–1 个主持，未配置或失败 → 规则化回退（`fallbackUsed: true`），原始成员报告始终保留。主持输入仅含有效成员输出与失败成员 id 列表（缺失结果不计入赞成/反对）。**`FinalCouncilReport` 始终由规则化 merger 生成**；主持结论经 `SimulateResult.councilReports` 交付；quick 模式该数组为空。
来源：2026-08-05 阶段 2 规划确认·D1。影响：data-contracts §4/§5.4/§7；architecture §8/§11。

### D26 预算纪律（阶段 2）
`maxTotalCalls` 保持显式全局硬顶，不按运行模式隐式修改默认值；`estimateCalls(config, mode)` 只读预估接入 check-config 输出与 simulate warnings（预估最小值超过 `maxTotalCalls` 时明确告警）；`budget.maxTransportRetries`（默认 1）与 `maxRetriesPerCall` 独立计数；首轮/修复/传输重试/主持调用统一计入 `maxTotalCalls`。
来源：2026-08-05 阶段 2 规划确认·D5。影响：data-contracts §4；architecture §8。

### D27 传输错误分类与有界重试
背景：真实 API 偶发 `fetch failed` 判定为瞬时网络错误（其后 concurrency=2 连续 3 次完整成功）；多成员后单次运行调用数上升，瞬时故障概率随之上升。设计：分类在 provider（传输异常 → `PROVIDER_NETWORK_ERROR`；HTTP 状态错误 → `PROVIDER_HTTP_ERROR` + 可选 `httpStatus`），策略在 council-runner（可重试 = 网络错误 / 429 / 5xx；超时、其余 4xx、`PROVIDER_BAD_JSON` 不重试），orchestrator 不参与；每成员传输重试 ≤ `maxTransportRetries`；**禁止任何厂商/网关特判**。
来源：2026-08-05 阶段 2 规划确认。影响：data-contracts §7；architecture §9。

### D28 并发测试方法
涉及并发上限的自动化测试禁止依赖墙钟耗时阈值（Windows/CI 环境脆弱）；使用可控 deferred Promise / mock provider 记录 `active`/`maxActive`，直接断言 `maxActive ≤ concurrency` 且全部任务完成。
来源：2026-08-05 阶段 2 规划确认·第 7 条。影响：implementation-plan 矩阵 A（A27）。

### D29 阶段 2 验收门槛
真实 API 双组（world/character）成功调用视为阶段 2 工程入口条件已满足；阶段 2 宣布完成前，必须再以一段真实小说材料进行质量评估（B10，用户手动执行，开发方不代跑）。
来源：2026-08-05 阶段 2 规划确认·第 6 条。影响：implementation-plan §4/§5、阶段 2 DoD。

### D30 C4 执行模式与预算预估落地边界
C4（T14）计划评审七项决策全部按推荐方案确认（1a/2a/3a/4a/5a/6a/7a）：

1. **standard 本阶段可运行** = 第一轮 + 规则化合并（quick 管线），`report.mode="standard"`，**主持调用数为 0**；每次 standard 运行向 `warnings` 注入一次边界提示（`STANDARD_MODERATOR_PENDING_WARNING`，常量单一定义于 `core/orchestrator/execution-modes.ts`；quick 不出现；deep 在运行前 CONFIG_INVALID，不出现）；**C5 将增量加入主持**（moderator 配置、moderator-runner、`councilReports`），届时移除该提示。
2. deep 维持 D24：契约可解析，orchestrator 显式 `CONFIG_INVALID`，不静默降级。
3. `estimateCalls(config, mode)` 为纯函数，**不读取 env**；min/max 采用 C3 单成员加法上限 `1 + maxRetriesPerCall + maxTransportRetries`，禁止乘法嵌套；disabled 组/成员不计入，insufficient 为运行后判定不影响预估。
4. `budgetCoverage` 三态：`below-min`（maxTotalCalls < minCalls）/ `covers-min` / `covers-max`。
5. **below-min 只告警、不拒绝**、不隐式改预算（A32）；运行时硬顶仍由既有 BUDGET_EXCEEDED 闸执行。
6. `SimulateResult` 不加 estimate 字段；预估出口 = check-config 信封（ok 判别联合：ok:true 必有 estimate）+ simulate warnings。
7. CLI warnings 逐行写 stderr，stdout 信封不变；README 的 --mode 说明留 C6。

来源：2026-08-06 C4 计划评审确认。影响：data-contracts §3/§4/§9；architecture §4/§5/§8。

### D31 C5 组内主持落地边界
C5（T15）计划评审确认的 12 项决策与 3 项修订：

1. **主持配置**（D25 落地）：`CouncilEntry.moderator` 可选；`rolePromptPath` 必填；`useMember` 复用同组已启用成员的连接与生成配置（provider/model/baseUrlEnv/apiKeyEnv/extraHeadersEnv/temperature/maxTokens/generationParams/timeoutMs/mockResponses），**不复用 rolePromptPath/id/name/enabled**；useMember 与内联连接字段互斥（timeoutMs 因默认值不可区分不参与互斥判定）；mock 主持受 `--allow-mock` 门禁。
2. **主持提示词键**：`rolePrompts["${councilId}:moderator"]`，无裸键兜底（避免跨组串键）。
3. **moderatorMemberId 取值（修订 1）**：内联主持 → `"moderator"`；useMember → 被复用成员 id；未配置主持或单有效成员跳过的规则回退 → `""`；**已尝试主持的失败回退保留主持身份**（fallbackUsed 只表示规则回退，不抹掉身份）。
4. **执行条件矩阵**：council disabled / 零启用成员 / insufficient → 不产 CouncilReport、不调主持；恰好 1 个有效成员 → 跳过主持调用、规则回退、不告警（规划 §9.3 单成员省略）；≥2 有效成员 + 未配置 → 规则回退不告警（A34）；≥2 有效成员 + 已配置 → 0–1 次主持调用。
5. **estimateCalls 主持计数（修订 2）**：`minModeratorCalls`/`maxModeratorCalls` 双值替换 C4 的 `moderatorCalls`；计数充要条件 = standard ∧ 组启用 ∧ 已配置 moderator ∧ 启用成员数 ≥ max(2, minValidMembers)；满足时 min+1、max+(1+R+T)；quick 恒 0/0；纯函数不读 env。
6. **重试纪律复用（修订 3）**：抽取中立模块 `core/structured-call/execute-structured-call.ts`（预算闸/独立超时/JSON 修复 ≤R/传输重试 ≤T 双独立计数/加法上限/重试回调与真实调用一一对应/永不 reject）；council-runner 与 moderator-runner 均依赖它；moderator-runner 不横向依赖 council-runner；全系统只有一套重试实现。
7. **事件面**：仅落地契约已冻结的 council-end（组级判定后、主持前逐组，含 disabled/insufficient）与 moderator-end（ok/failed/skipped；未配置/insufficient/disabled 不发射）；不新增 moderator-start/moderator-retry；主持传输重试不发事件。
8. **失败处理**：主持最终失败 → 规则化 fallback（verdict 按 §6.1 复用 deriveVerdict，其余保守/为空；输入按 memberId 升序，与完成顺序无关）+ warnings 一条脱敏诊断（`moderatorFailedWarning`）+ degraded=true；CouncilReport 不加 error 字段；原始成员报告始终保留（A06）；未配置/单成员跳过的回退不告警、不置 degraded。
9. **主持输入**：packet + 本组有效成员输出全文（按 memberId 升序）+ 失败成员 id 列表；超 maxInputChars → PACKET_TOO_LARGE 回退，不静默截断（D8）；只读本组成员报告，无跨组通道。
10. **FinalCouncilReport 始终规则 merger 生成**（C16 不变）；主持结果经 `SimulateResult.councilReports` 交付（quick 恒空数组）。
11. **C4 边界提示移除**：`STANDARD_MODERATOR_PENDING_WARNING` 常量与注入点删除；quick 配置跳过提示经 `moderatorSkippedQuickWarning`（每组一条）。
12. **useMember + mock**：复用目标成员 mockResponses，新建 MockProvider 实例从头消费（确定性，不共享实例）。

来源：2026-08-06 C5 计划评审确认（12 决策 + 3 修订）。影响：data-contracts §3/§4/§5.4/§9；architecture §4/§5/§8/§9。

---

## 设计提案（用户未否决，可在 review 时推翻）


| 编号 | 提案 | 位置 |
|---|---|---|
| C1 | ScenePacket 增加必填 `sceneId`；报告回带 `sceneId` + 唯一 `runId` | data-contracts §2 |
| C2 | FinalCouncilReport 增加 `rawRefs`/`stats`/`truncation`/`degraded`/`schemaVersion` | data-contracts §6 |
| C3 | `councils.json` 增加 `configVersion`；`limits`/`budget` 结构 | data-contracts §4 |
| C4 | 测试 #12 阶段 1 版：`proposedDelta.kind` 枚举拒绝事实化取值 | data-contracts §5.3 |
| C5 | quick 模式 `overallVerdict` 规则化推导（全 accept→accept；有 revise 无 reject→revise；有 reject→reject；单侧直通+degraded） | data-contracts §6.1 |
| C6 | 裁剪优先级表（信封 > findings > alternatives > questions > 其余） | data-contracts §6.2 |
| C7 | 错误码枚举与 CLI 退出码（0/1/2） | data-contracts §7、§9 |
| C8 | ProgressEvent 阶段 1 最小集（run-start/member-end/run-end） | data-contracts §8 |
