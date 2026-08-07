# Novel Council 数据契约

> 状态：v0.5（2026-08-06 并入 C5 落地决定 D31）

> 单一来源原则：本文件描述的契约在阶段 1 以 `src/contracts/` 中的 **zod schema** 为唯一实现来源，TS 类型由 zod 推导，`schemas/` 下的 JSON Schema 由构建生成，禁止手写双份。
> 与规划原文的出入以 `decision-log.md` 为准；文末 §12 列出全部契约修正提案。

---

## 0. 版本与兼容性政策

- 所有顶层契约携带 `schemaVersion`（数据）或 `configVersion`（配置），语义化版本。
- 向后兼容变更（新增可选字段）升级 minor；破坏变更升级 major，校验器必须给出清晰错误而非静默忽略。
- 阶段 1/2 全部版本为 `"1.0"`；阶段 2 新增契约字段均为**可选**，旧配置与旧调用无需修改。

## 1. 通用约定

1. **五分类分离**：所有模型输出必须区分 `canonFacts` / `inferences` / `hypotheses` / `creativeSuggestions` / `uncertainties`。
2. **unknown 优于编造**：无法确定的字段留空数组或放入 `openQuestions`，禁止为填满字段发明信息。
3. **配置只存环境变量名**（`apiKeyEnv` / `baseUrlEnv`），永不存密钥值。
4. **体积以字符计**：`maxInputChars` / `maxReportChars`，不依赖特定 tokenizer（D8/D9）。
5. 所有数组字段默认 `[]`；所有模型输出先经 zod 校验，失败进入修复重试流程。

## 2. ScenePacket v1

在规划 §6 字段基础上修正（见 §12）：

```jsonc
{
  "schemaVersion": "1.0",
  "sceneId": "场景标识（必填；主模型可取 chapterId 或 chapterId+场景号）",
  "projectId": "项目标识",
  "chapterId": "章节标识（可选业务标识）",
  "provisional": true,
  "authorRequest": "作者本次明确要求",
  "chapterGoal": "本章希望达成的作用",
  "provisionalPlan": [
    { "id": "beat-1", "summary": "暂定事件节点", "required": false, "reason": "主模型暂时这样安排的原因" }
  ],
  "timeAndPlace": {
    "time": "当前时间", "place": "当前地点", "elapsedSincePreviousScene": "距上一场过去多久"
  },
  "canonFacts": [],
  "worldStateSummary": [],
  "recentEvents": [],
  "characters": [
    {
      "name": "人物名",
      "identity": [], "confirmedHistory": [], "currentKnowledge": [],
      "misunderstandings": [], "currentGoals": [], "currentFears": [],
      "physicalState": [], "relationshipState": [], "knownConstraints": []
    }
  ],
  "authorConstraints": [],
  "forbiddenOutcomes": [],
  "openQuestions": [],
  "sourceReferences": [
    { "path": "正文或设定文件路径", "scope": "相关段落说明" }
  ]
}
```

### 2.1 内容内联政策（D8）

1. 子模型所需的正文/设定摘录**必须内联**进 `canonFacts`、`recentEvents`、`worldStateSummary`、`characters.*` 等字段。
2. `sourceReferences` 中的路径**仅用于来源追溯**；不得假定远程模型能读取本地文件；构建成员输入时不读取这些路径。
3. 不得把整个项目文件或全部聊天记录无选择地放入 packet。
4. **体积校验**：对每个成员计算实际发送的消息内容字符数（角色提示词 + packet 注入）。packet 预检：序列化字符数超过 `maxInputChars`（默认 50000）时，**不发起任何调用**，返回 `PACKET_TOO_LARGE` 错误。禁止静默截断。

## 3. SimulateOptions

```jsonc
{
  "mode": "quick"          // quick | standard | deep，缺省 quick
  // 阶段 3+ 扩展：requestedDiscussion、councils 子集、maxReportChars 覆盖
}
```

- 阶段 2 支持 `quick` 与 `standard`；`deep` 可被 schema 解析（契约前向稳定），但 orchestrator 在阶段 2 一律返回 `CONFIG_INVALID`（消息指明阶段 3 开放成员互评/交叉质询/跨组协调），禁止静默降级或伪装支持（D24）。
- 模式语义（D25/D26）：
  - `quick`：每组全部启用成员独立并发 + 规则化合并；不调用主持（配置了 moderator 也跳过并 warning）。
  - `standard`：第一轮同 quick；之后每组执行 0–1 次组内主持汇总（未配置或主持失败 → 规则回退，`fallbackUsed: true`）。
- **C5 落地（D31）**：组内主持已实现。C4 的 `STANDARD_MODERATOR_PENDING_WARNING` 边界提示已移除——standard 未配置主持走规则回退且**不告警**（A34）；quick 配置了 moderator 的启用组逐组注入一次跳过提示（`moderatorSkippedQuickWarning`，单一定义于 `core/orchestrator/execution-modes.ts`）；deep 在运行前拒绝，不出现。


## 4. CouncilConfig v1（`councils.json`）

```jsonc
{
  "configVersion": "1.0",
  "councils": [
    {
      "id": "world",                 // 阶段 2：world + character（council-kind 注册表，未知 id 拒绝）
      "enabled": true,
      "minValidMembers": 1,
      // 可选：组内主持（D25）。useMember 与内联连接配置二选一；缺省 = 无主持。
      "moderator": {
        "rolePromptPath": "prompts/world-moderator.md",
        "useMember": "world-causality" // 复用同组某启用成员的 provider/model/密钥等连接配置
        // 或内联：provider/model/baseUrlEnv/apiKeyEnv/extraHeadersEnv/temperature/maxTokens/generationParams/timeoutMs
      },
      "members": [
        {
          "id": "world-causality",
          "name": "世界运行评议者",
          "provider": "openai-compatible",   // 或 "mock"（仅测试，D16）
          "model": "模型标识",
          "baseUrlEnv": "WORLD_API_BASE_URL",
          "apiKeyEnv": "WORLD_API_KEY",
          "extraHeadersEnv": { "X-API-Key": "CUSTOM_API_KEY" },  // 可选；Header 名 → 环境变量名（D18）
          "rolePromptPath": "prompts/world-causality.md",        // 相对配置文件所在目录解析（D22）
          "temperature": 0.4,
          "maxTokens": 4000,                   // 可选
          "generationParams": { "top_p": 0.9 },// 可选透传；保留字段禁止（D17）
          "timeoutMs": 120000,
          "enabled": true
        }
      ]
    }
  ],
  "limits": {
    "maxInputChars": 50000,          // D8
    "maxReportChars": 20000          // D9
  },
  "budget": {
    "maxTotalCalls": 4,              // D10；显式全局硬顶，不按模式隐式修改（D26）
    "maxRetriesPerCall": 1,          // 每成员最多一次 JSON 格式修复
    "maxTransportRetries": 1,        // 每成员传输重试上限（D27，阶段 2）
    "concurrency": 2                 // 全局并发池上限（跨组共享）
  }
}
```

- 密钥缺失（env 未设置）→ `checkConfig` 报告 `keyConfigured: false`；`simulate` 时该成员直接标记 `failed(ENV_KEY_MISSING)`，不发起调用。
- 不得调用未启用（`enabled: false`）或未配置的 provider（D12）。
- **多成员（阶段 2）**：每组全部启用成员参与第一轮独立并发推演；单成员失败不影响其他成员；组内有效成员 ≥ `minValidMembers` 方为 `ok`。
- **moderator 校验规则**：`useMember` 必须指向同组已启用成员；`useMember` 与内联连接字段互斥；moderator 的 `generationParams` 同样受 D17 保留字段禁令；`provider: "mock"` 主持允许（测试用途，受 D16 门禁约束）。
- **rolePrompts 键约定（SimulateInput，阶段 2）**：`${councilId}:${memberId}` 为规范键；裸 `memberId` 键仍被接受作为向后兼容兜底。**主持提示词键为 `${councilId}:moderator`**（D31：无裸键兜底，避免跨组串键；主持有自己的 `rolePromptPath`，不复用 useMember 目标成员的提示词）。

- **调用数预估（C4，D26/D30）**：`estimateCalls(config, mode)` 为纯函数（只读已校验配置；**不读 env**、无 IO、无时间依赖），输出 `CallEstimate { mode, memberCount, perMemberMaxCalls, minCalls, maxCalls, maxTotalCalls, budgetCoverage, breakdown }`：
  - 计数：`enabled:false` 的组与成员不计入 `memberCount`；`insufficient` 是运行后判定，不影响预估；密钥缺失（ENV_KEY_MISSING）成员预估期无法识别，计入上界（实际调用只少不多）。
  - `perMemberMaxCalls = 1 + maxRetriesPerCall + maxTransportRetries`（C3 加法上限，禁止乘法嵌套）；`minCalls = memberCount + minModeratorCalls`；`maxCalls = memberCount × perMemberMaxCalls + maxModeratorCalls`。
  - **主持计数（C5，D31）**：breakdown 以 `minModeratorCalls` / `maxModeratorCalls` 双值表示。仅在以下条件**全部成立**时计 1 个主持计划单位：`mode==="standard"` ∧ 组启用 ∧ 已配置 moderator ∧ `enabledMemberCount ≥ max(2, minValidMembers)`；满足时 `minModeratorCalls += 1`、`maxModeratorCalls += 1 + maxRetriesPerCall + maxTransportRetries`（与成员同一加法公式）；否则 0。quick 恒 0/0。运行时成员失败导致的"单有效成员跳过主持"属运行态，不影响预估上界。

  - `budgetCoverage` 三态：`below-min`（maxTotalCalls < minCalls，必然不足 → simulate `warnings` 与 check-config stderr 告警，**不拒绝、不隐式修改预算**，A32）；`covers-min`（min ≤ 预算 < max，计划可行但不覆盖重试上界，不告警）；`covers-max`（预算 ≥ max，全覆盖）。
  - estimate 是启动前的计划值/理论上界；`stats.totalCalls` 是真实发生值（恒 ≤ maxCalls）。

### 4.1 baseUrl 语义（D19）

- `baseUrl`（经 `baseUrlEnv` 指向的环境变量提供）一律为 **API 根地址**，如 `https://api.example.com/v1`。
- adapter 负责追加 `/chat/completions`，并在拼接前规范化末尾斜杠。
- 不允许不同成员混用"根地址"与"完整 endpoint"两种语义；配置与 README 均按根地址语义说明。

### 4.2 generationParams（D17）

- 可选 `generationParams: Record<string, unknown>`，原样并入 Chat Completions 请求体。
- **保留字段禁止**：`model`、`messages`、`stream`、`tools`、`tool_choice`。配置含这些键时，check-config 与 simulate 均返回 `CONFIG_INVALID`，不得静默忽略。
- `model`、`messages`、`temperature`、`maxTokens` 等核心字段由程序控制，不允许被 `generationParams` 覆盖。

### 4.3 extraHeadersEnv（D18）

- 阶段 1 禁止在配置文件中存放明文 header 密钥。
- `extraHeadersEnv` 的 key 是实际 Header 名，value 是环境变量名；运行时解析出的所有 Header 值注册进 redactor，不得出现在日志、报告或错误信息中。
- 所引用的环境变量缺失时，该成员按 `ENV_KEY_MISSING` 处理，不发起调用。

### 4.4 mock provider（D16）

- `provider: "mock"` 仅供开发/测试；成员可附 `mockResponses: string[]` 作为脚本化返回（按调用顺序消费）。
- mock 成员不需要 `baseUrlEnv` / `apiKeyEnv`。
- CLI `simulate` 默认拒绝含启用 mock 成员的配置，必须显式 `--allow-mock`（错误码 `MOCK_NOT_ALLOWED`）；未来 Pi Extension 不得默认开启。
- `examples/councils.mock.example.json` 标注仅供测试；README 警告 Mock 不产生真实推演结果。

## 5. MemberReport（内部契约）

成员报告的**信封**，`SimulateResult.memberReports` 使用；core 不写文件（D7）。

```jsonc
{
  "reportId": "<runId>:<councilId>:<memberId>",
  "runId": "uuid",
  "councilId": "world",
  "memberId": "world-causality",
  "status": "ok | failed | repaired",   // repaired = 修复重试后成功
  "latencyMs": 0,
  "attempts": 1,                         // 实际 provider 调用总数：含 JSON 修复重试与传输重试（D27）
  "error": null,                          // 或 { "code": "...", "message": "（已脱敏）" }
  "output": { /* WorldMemberOutput 或 CharacterMemberOutput，见下 */ }
}
```

### 5.1 WorldMemberOutput（规划 §8.1）

```jsonc
{
  "verdict": "accept | revise | reject",
  "validPremises": [], "invalidPremises": [], "blockingConflicts": [],
  "externalPressures": [], "offscreenEvents": [], "informationFlow": [],
  "resourceAndInstitutionConstraints": [], "alternativeBeats": [],
  "proposedWorldDelta": [], "uncertainties": []
}
```

### 5.2 CharacterMemberOutput（规划 §8.2）

```jsonc
{
  "verdict": "accept | revise | reject",
  "characterFindings": [
    {
      "name": "人物名",
      "canonFacts": [], "inferredMotives": [], "hypothesizedHistory": [],
      "knowledgeBoundary": [], "likelyPerception": [], "likelyActions": [],
      "unlikelyActions": [], "emotionalProgression": [], "relationshipEffects": [],
      "conditionsForChange": [], "uncertainties": []
    }
  ],
  "interactionConflicts": [], "alternativeBeats": [], "proposedCharacterDelta": []
}
```

### 5.3 proposedDelta 项（安全约束，测试 #12 的阶段 1 可执行定义）

```jsonc
{ "kind": "hypothesis | suggestion", "summary": "...", "rationale": "..." }
```

- `kind` 仅允许 `hypothesis` / `suggestion`；出现 `canon` / `fact` / `confirmed` 等取值时校验器**拒绝**（schema 枚举层可测）。
- 阶段 6 之前 core 只透传不消费；无任何写入路径。
- `hypothesizedHistory` 与 `canonFacts` 为不同字段，结构上强制分离。

### 5.4 CouncilReport（组内主持汇总，阶段 2，D25）

```jsonc
{
  "councilId": "world",
  "verdict": "accept | revise | reject",
  "summary": "组内主持的一段总述",
  "consensus": [],
  "disagreements": [],
  "minorityOpinions": [],
  "evidenceStrength": [],
  "questionsForMainModel": [],
  "moderatorMemberId": "实际担任/尝试担任主持的 id（useMember → 被复用成员 id；内联主持 → \"moderator\"；未配置或单有效成员跳过的回退 → \"\"）",
  "fallbackUsed": false,
  "sourceMemberIds": ["参与本组汇总的有效成员 id（按 memberId 升序，确定性）"]
}
```

- 仅 `standard` 模式产生：`SimulateResult.councilReports` 每组（组 ok）一条；`quick` 模式为空数组。组 `insufficient` / disabled / 零启用成员时不产该组条目（不伪造汇总，规划 §13.3）。
- 主持未配置或主持调用失败 → 仍产出该组 CouncilReport，`fallbackUsed: true`，内容由规则化推导（verdict 按 §6.1 规则，其余字段保守/为空）；**原始成员报告始终保留**（A06）。
- **moderatorMemberId 语义（D31 修订 1）**：`fallbackUsed` 只表示规则回退，不抹掉实际尝试过的主持身份——配置了主持但最终失败的回退保留主持 id（useMember → 成员 id；内联 → `"moderator"`）；仅未配置主持与单有效成员跳过的回退为 `""`。
- 单有效成员（≥minValidMembers 但 =1）→ 跳过主持调用、规则回退、不告警（规划 §9.3 单成员省略，D31）；组内 ≥2 有效成员且已配置主持 → 执行 0–1 次主持调用。
- 主持最终失败 → `warnings` 注入一条脱敏诊断（`moderatorFailedWarning`，含错误 code 与回退说明），且 `FinalCouncilReport.degraded = true`；未配置/单成员跳过的回退不告警、不置 degraded（D31）。CouncilReport 不携带 error 字段。
- 主持输入 = packet + 该组有效成员输出全文（按 memberId 升序注入）+ 失败成员 id 列表（不含其内容；缺失结果不计入赞成/反对，规划 §13.3）。输入超 `maxInputChars` → 主持失败回退（PACKET_TOO_LARGE），**不静默截断**（D8）。主持只读本组成员报告，无跨组读取通道。
- 主持调用复用与成员完全一致的 C3 纪律（唯一实现 `core/structured-call`）：预算闸计入 `maxTotalCalls`、JSON 修复 ≤ `maxRetriesPerCall`、传输重试 ≤ `maxTransportRetries`、单组主持调用 ≤ `1 + R + T`（加法上限）。
- CouncilReport 是组内整理视图；`FinalCouncilReport` 始终由规则化 merger 生成，不依赖主持输出。

## 6. FinalCouncilReport v1（返回主模型的压缩报告）

```jsonc
{
  "schemaVersion": "1.0",
  "runId": "uuid",
  "sceneId": "回带 packet.sceneId",
  "generatedAt": "ISO-8601",
  "mode": "quick | standard",       // 阶段 2；deep 见 §3（阶段 3 开放）
  "degraded": false,                    // 任一 worker 失败/无效时为 true
  "overallVerdict": "accept | revise | reject",
  "planStrengths": [],
  "worldFindings":    [ { "topic": "", "detail": "", "severity": "info | warning | blocking", "sourceMemberIds": [] } ],
  "characterFindings":[ { "topic": "", "detail": "", "severity": "info | warning | blocking", "sourceMemberIds": [] } ],
  "alternativePlans": [ { "id": "A", "summary": "", "advantages": [], "risks": [], "requiredChanges": [], "sourceMemberIds": [] } ],
  "uncertainHypotheses": [],
  "proposedDeltas": [],                 // §5.3，透传
  "questionsForMainModel": [],
  "rawRefs": [ { "reportId": "<runId>:<councilId>:<memberId>", "councilId": "", "memberId": "", "status": "ok | failed | repaired" } ],
  "stats": { "totalCalls": 2, "succeeded": 2, "failed": 0, "repaired": 0, "durationMs": 0, "budgetExceeded": false },
  "truncation": { "applied": false, "droppedSections": [] }
}
```

### 6.1 规则化 merger（quick 模式，不调 LLM）

- `overallVerdict` 推导规则：全部有效成员 `accept` → `accept`；任一 `revise` 且无 `reject` → `revise`；任一 `reject` → `reject`；仅单侧有效 → 直通该侧 verdict 且 `degraded: true`。
- findings：从成员输出的关键字段（`invalidPremises`、`blockingConflicts`、`unlikelyActions`、`interactionConflicts` 等）映射，逐项携带 `sourceMemberIds`；merger 不做语义归纳。
- `alternativePlans` 从成员 `alternativeBeats` 映射，id 按 A/B/C 编号。

### 6.2 裁剪规则（maxReportChars 默认 20000，D9）

保留优先级（高 → 低）：

1. 信封字段（`schemaVersion` / `runId` / `sceneId` / `overallVerdict` / `degraded` / `stats` / `rawRefs` / `truncation`）
2. `worldFindings` / `characterFindings`（按 `blocking` → `warning` → `info` 排序，逐项保留或剔除）
3. `alternativePlans`（逐项）
4. `questionsForMainModel`、`uncertainHypotheses`
5. `planStrengths`、`proposedDeltas`

- 裁剪单位为**完整字段或完整数组项**；被裁部分记入 `truncation.droppedSections`。
- **任何情况下不得从字符串中间截断**；输出永远是有效 JSON。

## 7. 错误契约

```jsonc
// CoreError
{ "code": "ERROR_CODE", "message": "（已脱敏）", "memberId": "可选", "councilId": "可选", "httpStatus": "可选整数（仅 PROVIDER_HTTP_ERROR）" }

// SimulateResult 信封：core.simulateScene 的返回，也是 CLI simulate 的 stdout/--output 输出（D20）
{
  "ok": true,
  "report": { /* FinalCouncilReport */ },
  "memberReports": [ /* MemberReport，含失败成员 */ ],
  "councilResults": [ { "councilId": "world", "status": "ok | insufficient" } ],
  "councilReports": [ /* CouncilReport（§5.4）；standard 产生，quick 为空数组（阶段 2 新增字段） */ ],
  "warnings": []
}
{
  "ok": false,
  "error": { "code": "...", "message": "（已脱敏）" },
  "report": null,                   // 两组全失败时不伪造 FinalCouncilReport
  "memberReports": [ /* 已得的成员失败/成功报告仍保留 */ ],
  "councilResults": [],
  "councilReports": [],
  "warnings": []
}
```

- `report.rawRefs[].reportId` 必须能在 `memberReports[].reportId` 中解析（D20）。
- `CoreError` 类与错误码枚举定义于 `src/contracts/errors.ts`（契约层），使 providers 可抛类型化错误而不反向依赖 core；`core/errors` 只放辅助函数。
- 错误码枚举：
`CONFIG_INVALID`、`ENV_KEY_MISSING`、`PACKET_INVALID`、`PACKET_TOO_LARGE`、`PROVIDER_TIMEOUT`、`PROVIDER_HTTP_ERROR`、`PROVIDER_NETWORK_ERROR`、`PROVIDER_BAD_JSON`、`REPAIR_FAILED`、`BUDGET_EXCEEDED`、`INSUFFICIENT_COUNCIL`、`ALL_COUNCILS_FAILED`、`MOCK_NOT_ALLOWED`、`OUTPUT_WRITE_FAILED`、`INTERNAL`。
（`MOCK_NOT_ALLOWED` 由 D16 新增；`PROVIDER_NETWORK_ERROR` 由 D27 新增：传输层故障，与 `PROVIDER_HTTP_ERROR`（HTTP 状态错误，携带可选 `httpStatus` 整数字段）区分，供有界重试分类。）

所有 `message` 输出前必须经 `redaction`（D12）；`extraHeadersEnv` 解析出的值同样注册进 redactor（D18）。

## 8. ProgressEvent（阶段 1 最小集）

```ts
type ProgressEvent =
  | { type: "run-start";    runId: string; memberIds: string[] }
  | { type: "member-retry"; runId: string; councilId: string; memberId: string; attempt: number; code: ErrorCode; httpStatus?: number } // 阶段 2 新增（D27）：传输重试调用实际发起前发射（预算闸通过、attempts 递增后），与 provider 调用一一对应；重试未发起时不发射
  | { type: "member-end";   runId: string; councilId: string; memberId: string; status: "ok" | "failed" | "repaired"; latencyMs: number }
  | { type: "council-end";  runId: string; councilId: string; status: "ok" | "insufficient"; validMemberCount: number }   // 阶段 2 新增
  | { type: "moderator-end"; runId: string; councilId: string; moderatorMemberId: string; status: "ok" | "failed" | "skipped"; latencyMs: number } // 阶段 2 新增
  | { type: "run-end";      runId: string; ok: boolean; stats: RunStats };
// 阶段 3+ 扩展：discussion、coordinate
```

宿主可忽略该事件流；core 不依赖宿主展示能力（Pi 进度能力为阶段 4 待验证项 Q04）。

## 9. CLI 输出形态（D7 / D16 / D20 / D21）

```text
novel-council simulate     --packet <path> --config <path> [--mode <mode>] [--output <path>] [--allow-mock]
novel-council check-config --config <path> [--mode <mode>]
```

- **stdout 只输出最终机器可读 JSON**（D21）：`simulate` 输出完整 SimulateResult 信封（§7），裁剪后仍保证有效 JSON；`check-config` 输出独立检查信封（见下）。
- **stderr** 用于进度（经 ProgressEvent）、警告与人类可读错误；stdout 禁止调试日志、启动文字、进度提示；CLI 测试验证 stdout 可直接 `JSON.parse`。
- `--output <path>`：写入与 stdout 相同的完整信封；失败返回 `OUTPUT_WRITE_FAILED`。
- `--allow-mock`：配置含启用 mock 成员时必需，否则以 `MOCK_NOT_ALLOWED` 拒绝（D16）。
- `--mode <mode>`（C4）：执行模式 `quick`（缺省）/ `standard`；`deep` 显式 `CONFIG_INVALID`（D24）。simulate 经 SimulateOptions 由 core 契约统一校验；check-config 按所选模式输出 `estimate`。
- `simulate` 的 `warnings`（预估不足、standard 边界提示等）同时逐行写 stderr（前缀"警告"），stdout 信封不变（D21）。
- 退出码：`0` 成功（含 degraded）；`1` 配置/packet/输入类错误（含 `MOCK_NOT_ALLOWED`、`PACKET_TOO_LARGE`）；`2` 运行失败（如 `ALL_COUNCILS_FAILED`）。

```jsonc
// check-config 结果信封（D20）
{
  "ok": true,
  "configVersion": "1.0",
  "members": [
    {
      "councilId": "world", "memberId": "world-causality",
      "provider": "openai-compatible", "model": "…",
      "baseUrlConfigured": true, "keyConfigured": true,
      "promptFileReadable": true, "issues": []
    }
  ],
  "issues": [],                      // 含 generationParams 保留字段等（D17）；永不输出密钥值
  // C4（A32/D26）：所选模式的确定性调用数预估；ok:true 时必存在（ok 判别联合）；mode=deep 时缺省且 ok:false
  "estimate": {
    "mode": "quick", "memberCount": 2, "perMemberMaxCalls": 3,
    "minCalls": 2, "maxCalls": 6, "maxTotalCalls": 4,
    "budgetCoverage": "covers-min",  // below-min 时 stderr 告警（不拒绝、退出码不变）
    // C5（D31）：主持计数双值（quick 恒 0/0；standard 按 §4 主持计数条件计入）
    "breakdown": { "baseMemberCalls": 2, "maxRepairCalls": 2, "maxTransportRetryCalls": 2, "minModeratorCalls": 0, "maxModeratorCalls": 0 }

  }
}
```

## 10. 版本演进预留

- 阶段 2（本版落地的契约）：`CouncilReport`（§5.4）、`SimulateOptions.mode` 三值（deep 显式拒绝，D24）、`PROVIDER_NETWORK_ERROR` 与 `httpStatus`、`budget.maxTransportRetries`、`CouncilEntry.moderator`、council-end / moderator-end 事件。
- 移出阶段 2：writingCouncil 的 `WritingMemberOutput`（后续阶段）、报告自动留档目录格式（之后单独设计，D23）。
- 阶段 3：交叉评议的匿名观点结构与协调结论；deep 管线与预算形态。
- 阶段 6：Commit Proposal / canon delta（完整版测试 #12 在此落地）。
- 以上在对应阶段开始时才定义，不提前占字段。

## 11. 校验实现政策

- 唯一来源：`src/contracts/*.ts`（zod）。
- 成员输出解析：从原文提取首个 JSON 块 → zod 校验 → 失败则一次修复重试（原 prompt + 错误回显）→ 再失败标记 `REPAIR_FAILED`。
- `schemas/` 的 JSON Schema 由构建生成，供文档与未来宿主使用；禁止手写维护。

## 12. 对规划契约的修正清单（设计提案，用户可推翻）

| # | 修正 | 理由 |
|---|---|---|
| C1 | packet 增加必填 `sceneId`；report 回带 `sceneId` + 唯一 `runId` | 规划 §11 报告有 `sceneId` 而 §6 packet 没有，需对齐 |
| C2 | report 增加 `rawRefs` / `stats` / `truncation` / `degraded` / `schemaVersion` | 满足"压缩后可追溯"（测试 #14）与降级可见性 |
| C3 | 体积与预算参数以字符计（`maxInputChars` 50000 / `maxReportChars` 20000） | D8/D9；不依赖 tokenizer |
| C4 | `councils.json` 增加 `configVersion`；预算按 D10（quick：maxTotalCalls 4） | 配置演进管理；修正规划 §10.4 与 deep 管线的矛盾（standard/deep 预算阶段 2/3 再定） |
| C5 | 测试 #12 阶段 1 版本：`proposedDelta.kind` 枚举拒绝事实化取值 | 阶段 6 前无正史写入路径，原表述不可附着 |
| C6 | quick 模式 `overallVerdict` 规则化推导（§6.1） | 无主持模型时需要确定性合并规则 |
| C7 | `sourceReferences` 仅追溯，内容必须内联 | D8；子模型无法读本地文件 |
| C8 | 配置允许 `provider:"mock"` + `mockResponses`，CLI 默认拒绝、需 `--allow-mock` | D16；DoD 要求 mock 端到端可运行，同时防止误当真实推演 |
| C9 | `generationParams` 透传 + 保留字段禁令（model/messages/stream/tools/tool_choice） | D17；核心字段必须由程序控制 |
| C10 | `extraHeadersEnv`（Header 名 → 环境变量名），解析值注册 redactor | D18；禁止配置文件明文 header 密钥 |
| C11 | baseUrl 统一为 API 根地址，adapter 追加 `/chat/completions` 并规范化斜杠 | D19；消除混用语义 |
| C12 | CLI 输出完整 SimulateResult 信封；stdout/stderr 分离 | D20/D21；宿主稳定调用与部分失败可追溯 |
| C13 | `CoreError` 与错误码枚举定于 contracts 层 | 使 providers 可抛类型化错误而不反向依赖 core（依赖方向纪律） |
| C14 | 多成员第一轮 + council-kind 注册表（world/character），未知组 id → `CONFIG_INVALID` | D23；消除 `councilId === "world"` 硬编码分支的静默误分类风险 |
| C15 | `SimulateOptions.mode` 接受 quick/standard/deep 三值；deep 在阶段 2 由 orchestrator 显式 `CONFIG_INVALID` | D24；契约前向稳定且不伪装支持 |
| C16 | `CouncilReport`（§5.4）经信封 `councilReports` 交付；`FinalCouncilReport` 始终规则合并 | D25；最终报告保持确定性，主持失败无新增失败面 |
| C17 | `PROVIDER_NETWORK_ERROR` + `httpStatus` + `budget.maxTransportRetries`（默认 1） | D27；通用可重试分类，禁止厂商特判 |
| C18 | `rolePrompts` 规范键 `${councilId}:${memberId}`，裸 memberId 兜底 | 阶段 2 多成员下避免跨组同名成员串提示词 |
