# Novel Council 实施计划

> 状态：v0.4（2026-08-05 并入阶段 2 决定 D23–D29）
> 范围纪律：严格按阶段执行，未经用户确认不跨阶段（.clinerules）。阶段 1 开发过程不连接真实模型 API，自动化测试只使用 MockProvider（D6）。
> 本文档将测试明确区分为 **A. 自动化测试** 与 **B. 人工质量评估** 两类（用户要求十二.8）。

---

## 1. 环境基线

| 项 | 值 |
|---|---|
| 开发机（实测 2026-08-05） | Node v26.4.0 / npm 11.17.0 / git 2.54.0 / Windows 11 |
| 目标运行时 | Node.js 22（D3）；只使用 Node 22 可用 API |
| 语言/构建 | TypeScript strict，ESM，tsc 构建（D11） |
| 已批准依赖 | typescript、vitest、zod、tsx（无其他） |

## 2. 阶段 1 任务分解

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| T01 | 工程初始化 | `package.json`（ESM）、`tsconfig.json`（strict、Node 22、NodeNext）、目录骨架（`src/`、`tests/`、`examples/`、`prompts/`）；安装四个已批准依赖 | 无 |
| T02 | contracts | `src/contracts/`：ScenePacket、SimulateOptions、CouncilConfig、MemberReport、World/CharacterMemberOutput、FinalCouncilReport、错误与事件的 zod schema | T01 |
| T03 | errors + redaction | 错误码枚举、CoreError、脱敏器（认证头模式 + 已加载密钥字面量） | T02 |
| T04 | ProviderAdapter + MockProvider | 接口定义；Mock：脚本化响应/延迟/故障注入，记录请求供断言；`provider:"mock"` 入配置 schema，CLI 默认拒绝、需 `--allow-mock`（D16） | T02 |
| T05 | openai-compatible adapter | 原生 fetch（`fetchImpl` 注入）；请求构造/响应解析/超时；**无真实调用** | T03、T04 |
| T06 | orchestrator（quick） | packet 预检（PACKET_TOO_LARGE）、并发上限 2、超时取消、修复重试 ≤1、预算计数（maxTotalCalls 4）、insufficient 判定、degraded 标记 | T04、T05 |
| T07 | report-merger（规则化） | verdict 推导、findings/alternativePlans 映射、rawRefs、maxReportChars 裁剪（字段/数组项粒度，输出恒为有效 JSON） | T02 |
| T08 | CLI | `simulate --packet <f> --config <f> [--output <path>] [--allow-mock]`、`check-config`；stdout 仅输出完整 SimulateResult 信封 JSON（D20），进度/警告走 stderr（D21）；退出码 0/1/2 | T06、T07 |
| T09 | examples + prompts | 示例 packet、示例 config（仅占位 env 名，无密钥）、world/character 角色提示词各一 | T02 |
| T10 | 自动化测试 | 矩阵 A 中阶段 1 子集全部用例 | T02–T08 |
| T11 | README | 用法、配置说明、**第三方 API 数据发送警示**（D12）、阶段 1 自验清单 | 全部 |

## 3. 测试矩阵 A：自动化测试（Vitest + MockProvider，CI 无密钥环境）

| 编号 | 用例 | 来源 | 阶段 |
|---|---|---|---|
| A01 | 两成员并发成功，报告含两侧 findings | 规划 §19.1 | 1 |
| A02 | 一成员超时 → 该侧 failed、另侧正常、`degraded: true` | §19.2 | 1 |
| A03 | 一成员返回无效 JSON → 触发一次修复重试 | §19.3 | 1 |
| A04 | 修复重试成功（`repaired`）与再失败（`REPAIR_FAILED`） | §19.4 | 1 |
| A05 | 组内无有效结果 → `insufficient`；双组皆然 → `ALL_COUNCILS_FAILED`，不伪造汇总 | §19.5 | 1 |
| A06 | 主持模型失败时仍保留原始成员报告 | §19.6 | 2 |
| A07 | 两成员 verdict 冲突 → 规则化合并（任一 reject → reject 等） | §19.7 | 1 |
| A08 | 世界/人物报告前提冲突检测（夹具，流程级） | §19.8 | 3 |
| A09 | 单成员组跳过讨论 | §19.9 | 3 |
| A10 | 修复重试使调用数达 `maxTotalCalls=4` 上限 → 中止并标记 `budgetExceeded` | §19.10 + D10 | 1 |
| A11 | 注入假密钥字面量，断言不出现在日志/异常/报告 | §19.11 + D12 | 1 |
| A12 | `proposedDelta.kind` 取 `canon`/`fact`/`confirmed` → 校验拒绝（测试 #12 阶段 1 版） | §19.12 | 1 |
| A13 | 同一 packet 重跑 → 不同 `runId` | §19.13 | 1 |
| A14 | 压缩报告 `rawRefs` 与 `memberReports` 一一对应、可追溯 | §19.14 + D7 | 1 |
| A15 | packet 超 `maxInputChars` → `PACKET_TOO_LARGE`，且 Mock fetch 断言**零调用** | D8 | 1 |
| A16 | 超 `maxReportChars` → 按字段/数组项裁剪，输出仍为有效 JSON，`droppedSections` 有记录 | D9 | 1 |
| A17 | `--output` 写文件成功/失败（`OUTPUT_WRITE_FAILED`） | D7 | 1 |
| A18 | 密钥未配置成员：`ENV_KEY_MISSING`，不发起调用 | D12 | 1 |
| A19 | `enabled: false` 成员不被调用 | D12 | 1 |
| A20 | 单组 `minValidMembers` 未满足时的降级路径 | §13.3 | 1 |
| A21 | mock 配置无 `--allow-mock` → 拒绝（MOCK_NOT_ALLOWED）；带参 → 端到端成功 | D16 | 1 |
| A22 | `generationParams` 含 `model`/`messages`/`stream`/`tools`/`tool_choice` → check-config 与 simulate 均 `CONFIG_INVALID` | D17 | 1 |
| A23 | `extraHeadersEnv` 解析值注册 redactor；header 密钥不出现在错误/报告/stderr | D18 | 1 |
| A24 | CLI stdout 可直接 `JSON.parse`；进度与警告只出现在 stderr | D21 | 1 |
| A25 | 多成员第一轮：world 2 成员 + character 1 成员全成功，3 份 memberReports，findings 含多成员来源，`totalCalls=3` | 阶段 2 目标 #1 | 2 |
| A26 | 组内部分失败：2 选 1 失败该组仍 ok + `degraded`；`minValidMembers=2` 仅 1 有效 → 该组 insufficient | 阶段 2 目标 #4/#5 | 2 |
| A27 | 全局并发上限：deferred Promise + `active`/`maxActive` 计数断言 `maxActive ≤ concurrency` 且全部任务完成（禁墙钟阈值，D28） | 阶段 2 目标 #3 | 2 |
| A28 | `rolePrompts` 以 `${councilId}:${memberId}` 路由；跨组同名 memberId 不串提示词；裸 memberId 键兜底兼容 | C18 | 2 |
| A29 | 未知 council id（如 writing）→ `CONFIG_INVALID` 且消息含该 id | C14/D23 | 2 |
| A30 | 传输重试：网络错误/429/5xx 重试成功与耗尽；4xx/超时/`PROVIDER_BAD_JSON` 不重试；重试计入 `maxTotalCalls` | D27 | 2 |
| A31 | 模式解析：缺省 quick；standard 生效；`deep` → `CONFIG_INVALID`（不静默降级） | D24 | 2 |
| A32 | 预算预估：check-config 输出调用量估算；预估最小值 > `maxTotalCalls` 时 simulate 产生 warning，且不隐式改预算 | D26 | 2 |
| A33 | 主持成功：CouncilReport 含 consensus/disagreements/minorityOpinions；少数意见保留；主持调用计入预算 | 阶段 2 目标 #6 | 2 |
| A34 | quick 配置 moderator → 不调用主持并 warning；standard 未配置 moderator → 规则回退不告警 | D25 | 2 |

## 4. 测试矩阵 B：人工质量评估（不进自动化）

| 编号 | 项目 | 执行方式 | 阶段 |
|---|---|---|---|
| B01 | 推演发现主模型初版未注意的世界/人物问题 | 用户自选真实 API 配置，CLI 手动运行真实章节（开发方不代跑） | 1 后 |
| B02 | 问题解释可信性评估 | 同上 | 1 后 |
| B03 | 替代方案可执行性（≥1 个） | 同上 | 1 后 |
| B04 | 主模型读报告后确实修改原方案 | PI WEB 实测 | 4 |
| B05 | 修改后正文的人物差异性与连续性改善 | 对照阅读 | 4 |
| B06 | 推测未被自动写成正式设定 | 流程走查 | 持续 |
| B07 | 成本与等待时间可接受 | 实测记录 | 4 |
| B08 | 部分 API 失败时写作流程仍可继续 | PI WEB 故障注入 | 4 |
| B09 | Pi Extension 在 PI WEB 会话中端到端可用（§19.15） | PI WEB 实测 | 4 |
| B10 | 阶段 2 质量评估：一段真实小说材料走 quick 与 standard（含主持），评估多成员意见差异价值与主持汇总质量 | 用户手动执行（D29） | 2 |

### 4.1 对照实验协议（规划 §20 建议落地）

同一真实场景四组对照：① 主模型直接写；② 单模型推演后写；③ standard 模式后写（阶段 2 起）；④ deep 模式后写（阶段 3 起）。评分维度：人物真实性、世界运行感、剧情自然度、语言质量；逐次记录成本与耗时。**价值门槛**：B01–B03 未达成时，不得进入阶段 2 的状态留档与更复杂机制（呼应规划"先验证再扩展"）。

## 5. 阶段 2–7 概要

| 阶段 | 入口条件 | 内容 | 出口 |
|---|---|---|---|
| 2 多成员评议 | 阶段 1 DoD 达成；真实 API 双组调用成功（工程入口，D29） | 多成员第一轮、council-kinds 注册表、quick/standard、组内主持（CouncilReport）、传输重试分类、预算预估；**不含** deep/writingCouncil/报告留档（D23/D24） | A06、A25–A34 全绿 + B10 |
| 3 交叉评议与协调 | 阶段 2 稳定 | discussion-runner、conflict-coordinator、deep 模式与预算 | A08、A09 |
| 4 Pi 集成 | 用户确认推演价值 | 验证 Q01–Q04；连接方式 A/B 终定；bundler 决策；hosts/pi；Pi Skill | B04–B09 |
| 5 MCP/多宿主 | 阶段 4 完成且单包边界出现明显维护问题（D1） | workspaces 迁移、MCP Server | — |
| 6 状态管理 | 推演价值已被长期验证 | state-store、Commit Proposal、canon、checkpoint | 测试 #12 完整版 |
| 7 可视化 | 阶段 6 后 | PI WEB 面板或独立 Web | — |

### 5.1 阶段 2 任务分解（D23；每步独立 Git 提交，一次只做一步）

| # | 任务 | 产出 | 测试 |
|---|---|---|---|
| T12（C2） | 多成员第一轮 | council-kinds 注册表（`core/council-kinds`）；orchestrator 放开多成员并替换三处 councilId 硬编码；`rolePrompts` 新键约定；check-config/CLI 适配 | A25–A29 + 阶段 1 全部用例回归 |
| T13（C3） | 传输错误分类与有界重试 | `PROVIDER_NETWORK_ERROR`、`httpStatus`、`maxTransportRetries`；runner 重试策略 | A30 |
| T14（C4） | quick/standard 模式与预算预估 | `SimulateOptions.mode` 三值 + deep 显式拒绝；CLI `--mode`；`estimateCalls` 接入 check-config 与 warnings | A31、A32 |
| T15（C5） | 组内主持与 CouncilReport | moderator 配置校验、`core/structured-call`（C3 纪律唯一实现抽取）、`core/moderator-runner`、CouncilReport、`councilReports` 信封字段、council-end/moderator-end 事件（D31，已于 2026-08-06 落地） | A06、A33、A34 |

| T16（C6） | examples/README/schemas 收尾 | 多成员与主持示例配置、README 阶段 2 说明、`npm run gen:schemas` | mock 端到端冒烟 |

### 5.2 阶段 2 完成定义（DoD）

1. 矩阵 A 阶段 2 子集（A06、A25–A34）全绿；阶段 1 全部用例**零修改通过**（向后兼容）。
2. `npm run typecheck`、`npm test`、`npm run build` 全部通过；多成员 mock 配置端到端可运行。
3. 单成员旧配置行为与阶段 1 一致；`deep` 显式 `CONFIG_INVALID`。
4. B10 真实小说材料质量评估由用户完成并确认有价值（D29）。
5. 未创建任何阶段 3+ 产物（discussion-runner、conflict-coordinator、writingCouncil、报告留档、hosts/pi）。

## 6. 阶段 1 完成定义（DoD）

1. 矩阵 A 阶段 1 子集（A01–A05、A07、A10–A24）全绿。
2. `npm run typecheck`、`npm test`、`npm run build` 全部通过；CLI 以 `--allow-mock` + mock 配置端到端可运行，且 stdout 可直接 `JSON.parse`（D20/D21）。
3. README 含第三方 API 数据发送警示（D12）、Mock Provider 不产生真实推演的警告（D16）、baseUrl 根地址语义（D19）。
4. 依赖仅为已批准项（zod / typescript / vitest / tsx / @types/node）；无任何真实 API 调用记录。
5. 未创建任何阶段 2+ 产物（主持、留档目录、standard/deep、hosts/pi）。
6. 六项修正（D16–D21）全部落实并有对应自动化用例。
