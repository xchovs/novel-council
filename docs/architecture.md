# Novel Council 架构设计

> 状态：v0.4（2026-08-06 并入 C5 落地决定 D31）

> 依据：`小说多模型推演与写作评议系统规划_v2.md`、`.clinerules/`、2026-08-05 架构审查、2026-08-05 用户十二条决定、2026-08-05 阶段 2 决定 D23–D29（见 `decision-log.md`）。
> 本文档取代规划 §14 的目录草图（该草图含 `mcp-server`、`state-store`、`canon` 等跨阶段预埋内容，仅作远期参考）。
> 与规划原文存在出入之处，均以 `decision-log.md` 中已确认的决定为准。

---

## 1. 设计目标与硬边界

1. **Pi / PI WEB 是第一优先运行入口**，日常入口在 Pi；核心可被 CLI 独立测试。
2. **Pi 不是核心依赖**：`core` 不 import 任何宿主 API；Pi Extension 只能是薄适配层。
3. **Cline / VS Code 仅用于开发**：运行时依赖中永不出现 Cline SDK、Agent Teams、VS Code API。
4. **目标服务器运行环境按 Node.js 22 设计**（D3）。
5. **子模型只读**：只产出 `proposedDelta`；阶段 6 之前系统中不存在正史存储与提交路径。
6. **单侧失败不拖垮全局**；密钥只走环境变量；每次运行有唯一 `runId`。
7. **当前阶段不连接 VPS，不检查或修改远程 Pi 安装**（D4）；Pi 官方文档仅用于架构调研。

## 2. 系统上下文与数据流

```text
用户
  ↓ 写作任务
Pi / PI WEB（主模型 + Pi Skill 工作流）
  ↓ simulate_scene 工具调用（ScenePacket + SimulateOptions）
Pi Extension（薄适配层，连接方式见 §7）
  ↓ simulateScene()
独立核心 core ──→ Provider APIs（world / character 成员，并发）
  ↓ FinalCouncilReport（压缩，含 rawRefs）
Pi 主模型：显式裁决 → 重新规划 → 写正文

CLI（开发与测试入口）──→ 同一个 core.simulateScene()
```

## 3. 架构决策：单仓库单包模块化（方案 A，已确认 D1）

- 单仓库、单 package、内部模块化。**当前不采用 monorepo**。
- 迁移为 npm workspaces 的条件（须同时满足）：未来开始增加 MCP 或第二个正式宿主，**且**单包边界已经造成明显维护问题。
- 宿主无关性由依赖方向纪律保证（§4），不依赖 workspace 机制。

## 4. 目标目录结构与依赖方向

> 以下为阶段 1–4 的目标结构。**阶段 0 只创建 `docs/`**；其余目录在对应阶段开始时才创建。

```text
novel-council/
├── docs/                      # 阶段 0 交付物（本目录）
├── src/
│   ├── contracts/             # 唯一契约来源：zod schemas + TS 类型（见 data-contracts.md）
│   ├── core/                  # 宿主无关业务逻辑
│   │   ├── orchestrator/      # simulateScene 全流程编排、预算闸、模式分发
│   │   ├── council-kinds/     # councilId → 输出 schema/提示词形状/报告桶 注册表（阶段 2）
│   │   ├── council-runner/    # 成员生命周期：预检、超时封装、成员报告收集
│   │   ├── structured-call/   # 结构化输出通用有界调用循环（C3 纪律唯一实现；成员与主持共用，D31）
│   │   ├── moderator-runner/  # 组内主持汇总（standard，阶段 2，C5 落地）
│   │   ├── report-merger/     # 规则化合并（FinalCouncilReport 唯一生产者）

│   │   ├── discussion-runner/ # 匿名交叉评议（阶段 3）
│   │   ├── conflict-coordinator/ # 跨组前提冲突（阶段 3；此前不存在）
│   │   ├── budget/            # 调用次数与字符上限计数；estimateCalls 确定性预估（C4）
│   │   ├── validation/        # zod 校验、JSON 提取、一次修复重试
│   │   ├── redaction/         # 密钥/认证头脱敏
│   │   ├── events/            # ProgressEvent 发射
│   │   └── errors/            # CoreError 与错误码
│   ├── providers/             # ProviderAdapter 接口、openai-compatible、mock
│   ├── cli/                   # bin 入口：simulate / check-config
│   └── hosts/
│       └── pi/                # 阶段 4 新增：Pi Extension 薄适配层
├── prompts/                   # 角色提示词（阶段 1：world、character 各一）
├── schemas/                   # 由 contracts 构建生成的 JSON Schema（不手写）
├── examples/                  # 示例 packet / config
├── tests/                     # Vitest + MockProvider + 夹具
└── .story-engine/             # 运行时产物目录；阶段 1 不自动创建（D7）
```

**依赖方向规则**：

```text
contracts ← providers ← core ← cli
hosts/* → core
core ✗→ hosts/*；core ✗→ cli；providers ✗→ core；任何模块 ✗→ 宿主 API
```

反向 import 视为架构违规。阶段 1 由 code review 与测试保证；如需 lint 边界插件，届时另行申请依赖。

## 5. 模块职责

| 模块 | 职责 | 阶段 |
|---|---|---|
| `contracts` | 全部数据契约的 zod 定义；JSON Schema 生成源 | 1 |
| `providers/ProviderAdapter` | 统一接口 `chat(req) → string`；构造注入 `fetchImpl`、`AbortSignal`；**不内建重试** | 1 |
| `providers/openai-compatible` | OpenAI-compatible Chat Completions 端点；原生 `fetch` 实现 | 1 |
| `providers/mock` | 测试用：脚本化响应 / 延迟 / 故障注入 / 夹具 | 1 |
| `core/orchestrator` | 组建 → 并发 → 汇总 → 总报告；预算闸；体积预检 | 1（quick） |
| `core/council-runner` | 成员生命周期封装：council-kind 解析、输入预检、成员报告信封 | 1 |
| `core/structured-call` | 结构化输出通用有界调用循环：预算闸、独立超时、JSON 修复 ≤R 与传输重试 ≤T 双独立计数、加法上限；C3 纪律唯一实现（成员与主持共用，禁止第二套，D31） | 2 |
| `core/report-merger` | 纯规则化拼装 FinalCouncilReport（不调 LLM）；全部模式的最终报告唯一生产者 | 1 |

| `core/budget` | `maxTotalCalls` / `maxInputChars` / `maxReportChars` 计数；`estimateCalls(config, mode)` 纯函数预估（min/max 双值 + `budgetCoverage` 三态，不读 env，D26/D30） | 1（预估随 C4） |
| `core/validation` | zod 校验；从原文提取首个 JSON 块；一次修复重试 | 1 |
| `core/redaction` | 密钥/认证头脱敏，作用于日志、错误、报告 | 1 |
| `core/events` | `onProgress` 回调发射 ProgressEvent；宿主可用可不用 | 1 |
| `cli` | `simulate`（默认 stdout，可选 `--output`）、`check-config` | 1 |
| `core/council-kinds` | councilId → 输出 schema / 提示词形状 / 报告 findings 桶 的显式注册表；未知组 id → `CONFIG_INVALID`（阶段 2 仅 world/character，D23） | 2 |
| `core/moderator-runner` | 组内主持调用与 CouncilReport 生成；未配置或失败时 `fallbackUsed` 规则回退（D25） | 2 |
| `core/discussion-runner` | 匿名交叉评议一轮 | 3 |
| `core/conflict-coordinator` | 跨组前提冲突检查、定向重跑（上限一次） | 3 |
| `hosts/pi` | 注册 `simulate_scene` 工具、`/scene-sim` 等命令 | 4 |

> 规划 §14 的 `state-store` 属于阶段 6，不预留空模块。Anthropic / Gemini 等原生协议 adapter 推迟到后续阶段（D6）。

## 6. 核心 API

```ts
// contracts 为唯一类型来源；以下为签名示意
export function simulateScene(input: SimulateInput): Promise<SimulateResult>;
export function validateScenePacket(data: unknown): ValidationOutcome;
export function checkConfig(config: CouncilConfig, env: Record<string, string | undefined>): ConfigCheckResult;

export interface SimulateInput {
  packet: ScenePacket;
  options?: SimulateOptions;            // 阶段 1 仅支持 { mode: "quick" }，可省略
  config: CouncilConfig;
  onProgress?: (e: ProgressEvent) => void;
  fetchImpl?: typeof fetch;             // 测试注入点（阶段 1 唯一调用方式 = MockProvider）
  now?: () => Date;                     // 测试注入点
  runId?: string;                       // 默认 crypto.randomUUID()
}

export interface SimulateResult {
  report: FinalCouncilReport;           // 压缩报告（含 rawRefs / stats / truncation）
  memberReports: MemberReport[];        // 原始成员报告（内存返回；core 不写文件）
  stats: RunStats;
}
```

- **core 阶段 1 为纯计算**：不做任何文件 IO；stdout 打印与 `--output` 写文件由 CLI 层负责（D7）。
- `checkConfig` 只输出 `{ provider, model, keyConfigured: boolean }`，永不输出密钥值。

## 7. Pi ↔ Core 连接方式（D5：暂定 A，阶段 4 终定）

| | A. Extension 直接 import 已构建核心库（**暂定优先**） | B. Extension 调用独立 CLI 子进程 |
|---|---|---|
| 形态 | core 经 `tsc` 构建为普通库，随 Pi Extension 一起部署 | Extension spawn `node dist/cli/...`，经 stdout/退出码交换 |
| 优点 | 无额外进程；调用直接；进度经回调传递 | 进程隔离；core 崩溃不波及宿主；Node 版本要求落在子进程侧 |
| 缺点 | 与 Extension 同进程，受宿主 Node 环境与依赖约束 | 多一层进程管理；进度需经事件行协议传递 |
| 适用 | Pi 扩展支持携带普通 JS 库时 | 打包格式受限或需要隔离时 |

- **最终决定待阶段 4**：阅读当时实际 Pi 版本的官方文档并做最小验证后确认。
- **不设计本地 HTTP 常驻服务作为第一选择**（D5）。
- 以下事实当前无法确定，**全部标记为阶段 4 待验证**（见 `open-questions.md` Q01–Q04），本文档不做假定：
  Pi Extension 打包/安装格式、工具注册签名、工具调用超时上限、PI WEB 进度展示能力。

## 8. 运行模式与调用预算（D10 / D23–D26）

阶段 1 实际运行形态：quick、world 1 成员 + character 1 成员、并发 2、`maxTotalCalls` 4、每成员最多 1 次格式修复、无主持（D10）。

阶段 2 起支持 **quick / standard** 两种模式；`deep` 在契约层可被解析，但阶段 2 由 orchestrator 显式拒绝（`CONFIG_INVALID`，消息指明阶段 3 开放成员互评/交叉质询/跨组协调），**禁止静默降级或伪装支持**（D24）：

| 模式 | 第一轮成员 | 组内主持 | 最终报告 |
|---|---|---|---|
| `quick` | 每组全部启用成员，独立并发 | 不调用（配置了也跳过并 warning） | 规则化 merger |
| `standard` | 同 quick | 每组 0–1 个；未配置或失败 → `fallbackUsed` 规则回退 | 规则化 merger（不变） |
| `deep` | — | — | 阶段 2：`CONFIG_INVALID`；阶段 3 开放 |

预算纪律（D26）：

- `maxTotalCalls` 保持**显式全局硬顶**，不按模式隐式修改默认值；
- `estimateCalls(config, mode)` 只读预估最小/最大调用量，接入 `check-config` 输出与 `simulate` warnings（预估最小值超过 `maxTotalCalls` 时明确告警）；
- `budget.maxTransportRetries`（默认 1）为每成员传输重试上限（见 §9），与 JSON 修复次数独立计数；
- 所有真实 provider 调用（首轮 / 修复 / 传输重试 / 主持）统一计入 `maxTotalCalls`。

C5 落地形态（D31，取代 C4 边界）：

- 模式分发在 orchestrator：`deep` 在预估与任何调用之前显式拒绝（零调用，CONFIG_INVALID）；`standard` 执行第一轮 + 每组 0–1 次主持汇总（条件矩阵见 data-contracts §5.4：组 ok ∧ ≥2 有效成员 ∧ 已配置 moderator 才调用；未配置/单有效成员规则回退不告警；quick 配置了则跳过并逐组 warning）；C4 的 `STANDARD_MODERATOR_PENDING_WARNING` 边界提示已移除；
- 重试纪律唯一实现为 `core/structured-call`（C3 抽取）：预算闸、独立超时、JSON 修复 ≤R 与传输重试 ≤T 双独立计数、加法上限 `1 + R + T`；council-runner 与 moderator-runner 均依赖它，moderator-runner 不横向依赖 council-runner，禁止第二套重试实现；
- `estimateCalls`（`core/budget/estimate.ts`）为纯函数，不读 env：`perMemberMaxCalls = 1 + maxRetriesPerCall + maxTransportRetries`（C3 加法上限，禁止乘法嵌套）；`minCalls = memberCount + minModeratorCalls`，`maxCalls = memberCount × perMemberMaxCalls + maxModeratorCalls`；主持计数条件 = standard ∧ 组启用 ∧ 已配置 moderator ∧ 启用成员数 ≥ max(2, minValidMembers)；
- `budgetCoverage` 三态：`below-min`（必然不足 → simulate warnings + check-config stderr 告警，不拒绝、不隐式改预算）/ `covers-min`（计划可行但不覆盖重试上界，不告警）/ `covers-max`（全覆盖）；仅 `below-min` 告警；
- estimate 是启动前的确定性计划值/上界；`stats.totalCalls` 是真实发生值（主持调用统一计入）。

deep 的预算与成员数形态随阶段 3 管线落地时再定（D14）。


## 9. 并发、失败与重试语义

1. 成员并发：`Promise.allSettled` 语义的全局限流并发池（`budget.concurrency`，默认 2）；阶段 2 起每组**全部启用成员**进入同一并发池；单成员失败不取消其他成员。
2. 超时：每成员独立 `AbortSignal.timeout`，到期取消对应请求。
3. JSON 修复重试（不变）：成员输出 JSON 无效时，对**该成员**做至多 `maxRetriesPerCall` 次格式修复调用（计入 `maxTotalCalls`），再失败标记 `REPAIR_FAILED`。
4. 传输重试（阶段 2，D27）：**分类在 provider，策略在 core/structured-call（C5 起自 council-runner 抽取，成员与主持共用同一实现，D31），orchestrator 不参与**。

   - provider 把传输层异常归为 `PROVIDER_NETWORK_ERROR`；HTTP 状态错误归为 `PROVIDER_HTTP_ERROR` 并携带 `httpStatus`；
   - 可重试：`PROVIDER_NETWORK_ERROR`、`httpStatus === 429`、`httpStatus >= 500`；不可重试：`PROVIDER_TIMEOUT`（已等满整个超时）、其余 4xx、`PROVIDER_BAD_JSON`；
   - 每成员传输重试总次数 ≤ `budget.maxTransportRetries`（默认 1），与 JSON 修复独立计数，每次重试照常计入 `maxTotalCalls`；
   - 分类只依据错误类型与状态码，**禁止任何厂商/网关特判**。
5. 有效成员 < `council.minValidMembers`（默认 1）→ 该组 `status: "insufficient"`；所有组均 insufficient → 返回 `ok:false, code: ALL_COUNCILS_FAILED` 及已得部分数据，不伪造汇总。
6. 部分失败：按有效结果生成降级报告，`degraded: true`，失败成员在报告中明确标记。
7. 组内主持（standard，C5 落地 D31）：主持输入 = packet + 本组**有效成员输出**（按 memberId 升序）+ 失败成员 id 列表（缺失结果不计入赞成/反对，规划 §13.3），只读本组成员报告（无跨组通道）；执行条件矩阵与 moderatorMemberId 语义见 data-contracts §5.4（组 insufficient 不产报告；单有效成员跳过；未配置或失败 → 规则化回退 `fallbackUsed: true`，失败回退保留已尝试的主持身份）；主持最终失败置 `degraded: true` 并告警，未配置/跳过的回退不告警不置位。


## 10. 输入与报告体积（D8 / D9）

| 参数 | 默认 | 语义 |
|---|---|---|
| `maxInputChars` | **50000**（可配置） | 字符数，不依赖特定 tokenizer；按成员实际发送的消息内容计 |
| `maxReportChars` | **20000**（可配置） | 压缩后 FinalCouncilReport 的字符上限 |

- 输入超限：**明确报错**（`PACKET_TOO_LARGE`），**禁止静默截断**；按模型上下文窗口计算 token 的能力属于后续阶段。
- 报告裁剪：按**完整字段、完整数组项、预定义优先级**进行；任何情况下不得从字符串中间截断；输出永远是有效 JSON；被裁部分记录于 `truncation.droppedSections`。
- 原始成员结果保留为内部 `MemberReport`（内存返回）；`FinalCouncilReport` 只含压缩结论与 `rawRefs`。

## 11. 报告输出与留档（D7）

1. CLI 默认把完整 `SimulateResult` 信封以 JSON 输出到 **stdout**。
2. 可选参数 `--output <path>`：仅在用户明确指定时写入文件。
3. **不自动创建 `.story-engine/reports`**；报告自动留档已移出阶段 2 范围，之后单独设计（D23）。
4. 每次运行生成唯一 `runId`（默认 `crypto.randomUUID()`）。
5. `FinalCouncilReport.rawRefs` 必须可追溯到成员报告（`reportId = <runId>:<councilId>:<memberId>`，对应 `SimulateResult.memberReports`）。
6. 不实现 canon、checkpoint 或正式状态提交。
7. 阶段 2：`FinalCouncilReport` 始终由规则化 merger 生成（确定性，主持不介入最终报告）；组内主持结论经信封 `SimulateResult.councilReports`（`CouncilReport[]`）交付，quick 模式为空数组（D25）。

## 12. 密钥与隐私（D12）

用户已知情并接受：运行时被选中的小说摘录会发送给用户明确配置的第三方模型 API。系统约束：

1. README 与配置文档明确提醒数据会发送到第三方。
2. 只向**实际启用**的成员发送必要内容；不允许隐藏调用未配置或未启用的 provider。
3. 不进行后台自动上传；评议只在用户手动 `/scene-sim` 或主模型按 Skill 显式调用时运行（D13）。
4. API Key 只从环境变量读取，不进入源码、日志、报告或错误信息；`redaction` 过滤标准与自定义认证头及已加载密钥字面量。
5. 阶段 1 不实现复杂的隐私确认 UI。

## 13. 技术基线与依赖政策（D3 / D11）

- 开发机实测：Node v26.4.0 / npm 11.17.0 / git 2.54.0（2026-08-05）。
- 目标运行时：**Node.js 22**；ESM；TypeScript `strict`；构建优先使用 **tsc**。
- **已批准依赖**：

| 依赖 | 类型 | 用途 |
|---|---|---|
| `typescript` | dev | 类型检查与编译 |
| `vitest` | dev | 自动化测试 |
| `zod` | runtime | 运行时校验与契约单一来源 |
| `tsx` | dev | 本地开发与 CLI 调试 |

- **当前不批准**：tsup/tsdown 等 bundler、Pi SDK、Cline SDK、LLM 厂商 SDK、LangChain/AutoGen/CrewAI 等 Agent 框架、数据库。
- 阶段 4 接入 Pi 时，再根据真实扩展格式决定是否需要 bundler。
- HTTP 一律走原生 `fetch`（可注入 mock）；JSON Schema 由 contracts 构建生成，禁止手写双份。

## 14. 触发方式（D13）

- 用户手动输入 `/scene-sim`；或主模型按照 Pi Skill 明确调用 `simulate_scene`。
- 不得自动拦截每次正文生成；不得在用户不知情时自动运行评议。

## 15. 阶段演进映射

| 阶段 | 新增模块/产物 | 出口标准（测试矩阵见 implementation-plan.md） |
|---|---|---|
| 1 最小原型 | contracts、providers（openai-compatible + mock）、orchestrator(quick)、规则化 merger、CLI | 自动化测试矩阵阶段 1 子集全绿；人工质量评估流程就绪 |
| 2 多成员评议 | 多成员第一轮、council-kinds 注册表、standard 模式与组内主持（CouncilReport）、传输重试分类、预算预估；**不含** deep 管线 / writingCouncil / 报告留档（D23/D24） | 阶段 2 自动化用例全绿 + B10 真实材料质量评估（D29） |
| 3 交叉评议与协调 | discussion-runner、conflict-coordinator、deep 模式与预算 | 阶段 3 自动化用例 |
| 4 Pi 集成 | hosts/pi、Pi Skill；**连接方式 A/B 终定；打包/超时/进度验证；bundler 决策** | PI WEB 实测（人工） |
| 5 MCP/多宿主 | 视维护成本触发 workspaces 迁移（D1） | — |
| 6 状态管理 | state-store、commit 流程、canon | 阶段 6 用例 |
| 7 可视化 | Web 面板 | — |

## 16. 明确不做（阶段 1–4）

WebUI、数据库、MCP、正式状态提交系统、自动拦截正文生成、无限轮辩论、本地 HTTP 常驻服务（作为第一选择）、fork/修改 Pi 与 PI WEB 内核、连接 VPS 或远程 Pi 安装、任何 Cline/VS Code 运行时依赖、任何 Agent 框架与 LLM 厂商 SDK。
