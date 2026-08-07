# Novel Council（阶段 2：多成员评议 quick / standard）

多模型小说世界与人物推演系统的宿主无关核心 + CLI。主模型在写正文前，把结构化 `ScenePacket` 交给本系统；系统并发调用**世界评议组**与**人物评议组**的多个独立模型成员，产出结构化 `FinalCouncilReport`（规则化合并）与逐组 `CouncilReport`（standard 模式的组内主持汇总），供主模型重新规划。

- 当前阶段：**阶段 2（多成员评议）**——world 与 character 两组必须存在，每组可配置**多个启用成员**；支持 `quick` / `standard` 两种运行模式；standard 可选组内主持；传输错误分类重试；确定性调用数预估。
- 本仓库**不是** Pi 插件；Pi Extension / Pi Skill 属于阶段 4。核心不依赖任何宿主（D2）。
- 目标运行时：**Node.js 22**（ESM，TypeScript strict，tsc 构建）。

---

## ⚠️ 数据发送警示（D12）

运行时，**你配置的小说摘录（ScenePacket 内容）会被发送给你明确配置的第三方模型 API**。使用本工具即表示你知情并接受这一点。系统约束：

- 只向**实际启用**的成员（及 standard 模式下实际执行的主持）发送必要内容；绝不调用未配置或未启用的 provider；
- 不进行后台自动上传；评议只在你显式运行时发生；
- API Key 只从环境变量读取，永不进入源码、日志、报告或错误信息。

## ⚠️ Mock Provider 警示（D16）

`provider: "mock"` **仅供开发与自动化测试**，它返回配置中预先写好的脚本化文本，**不产生任何真实模型推演结果**。普通 `simulate` 默认拒绝含启用 mock 成员（或 mock 主持）的配置，必须显式传入 `--allow-mock`。`examples/councils.mock.example.json` 与 `examples/councils.standard-mock.example.json` 仅供测试。未来 Pi Extension 不会默认开启 allowMock。

---

## 安装与构建

```bash
npm install
npm run build      # tsc → dist/（含 .d.ts 类型产物）
npm test           # vitest（全部使用 MockProvider / mock fetch，不连真实 API）
npm run typecheck
npm run gen:schemas  # 由 contracts 重新生成 schemas/（7 份，幂等，勿手写）
```

## CLI 用法

```bash
# 构建后
node dist/cli/bin.js simulate     --packet <path> --config <path> [--mode <mode>] [--output <path>] [--allow-mock]
node dist/cli/bin.js check-config --config <path> [--mode <mode>]

# 开发期（tsx）
npm run dev -- simulate --packet examples/scene-packet.example.json --config examples/councils.mock.example.json --allow-mock
```

- **stdout 只输出机器可读 JSON**（完整 SimulateResult 信封）；进度（ProgressEvent）、警告与人类可读错误走 **stderr**（D21）。`warnings` 数组内容同时逐行写 stderr（前缀"警告"），stdout 信封不变。
- `simulate` 信封（D20）：`{ ok, report, memberReports, councilResults, councilReports, warnings, error? }`；`report.rawRefs[].reportId` 可在 `memberReports[].reportId` 中解析；两组全失败时 `ok:false` + `ALL_COUNCILS_FAILED`，保留成员失败报告，不伪造报告。
- `councilReports`：standard 模式每组（组 ok）一条 `CouncilReport`；**quick 模式恒为空数组**。
- `--mode <mode>`：`quick`（缺省）/ `standard`；`deep` 显式拒绝（见下"运行模式"）。
- `--output <path>`：把同一信封写入文件；失败返回 `OUTPUT_WRITE_FAILED`。
- `--allow-mock`：配置含启用 mock 成员或 mock 主持时必需，否则 `MOCK_NOT_ALLOWED`。
- `check-config`：输出独立检查信封 `{ ok, configVersion, members, issues, estimate? }`——只含 `provider`/`model`/`keyConfigured` 等状态，**永不输出密钥值**；`estimate` 为所选模式的确定性调用数预估（见"调用预算与预估"）。
- 退出码：`0` 成功（含 degraded）；`1` 配置/packet/输入类错误（含 `MOCK_NOT_ALLOWED`、`PACKET_TOO_LARGE`、`deep` 的 `CONFIG_INVALID`）；`2` 运行失败（如 `ALL_COUNCILS_FAILED`）。

### 快速自验（无需真实 API）

```bash
# ① quick，单成员 × 2 组（阶段 1 兼容形态）
node dist/cli/bin.js simulate --packet examples/scene-packet.example.json --config examples/councils.mock.example.json --allow-mock

# ② quick，多成员（world 2 + character 1）；配置中的主持被跳过并 warning
node dist/cli/bin.js simulate --packet examples/scene-packet.example.json --config examples/councils.standard-mock.example.json --allow-mock

# ③ standard，world 组内主持成功（councilReports 中 fallbackUsed=false）
node dist/cli/bin.js simulate --packet examples/scene-packet.example.json --config examples/councils.standard-mock.example.json --allow-mock --mode standard

# ④ deep：退出码 1，信封 ok:false + CONFIG_INVALID（零调用）
node dist/cli/bin.js simulate --packet examples/scene-packet.example.json --config examples/councils.standard-mock.example.json --allow-mock --mode deep

# ⑤ check-config：输出所选模式的 estimate（mock 配置不需要 --allow-mock）
node dist/cli/bin.js check-config --config examples/councils.standard-mock.example.json --mode standard
```

## 运行模式（D24/D25/D31）

| 模式 | 第一轮成员 | 组内主持 | `councilReports` | 最终报告 |
|---|---|---|---|---|
| `quick`（缺省） | 每组全部启用成员，独立并发（全局并发池上限 `budget.concurrency`） | **不调用**；配置了 moderator 的启用组逐组注入一条跳过 warning（结果仍由规则化合并产生） | 恒 `[]` | 规则化 merger |
| `standard` | 同 quick | 每组 0–1 次：组 `ok` ∧ 有效成员 ≥ 2 ∧ 已配置 moderator 才调用；未配置 / 单有效成员 / 主持失败 → 规则回退（`fallbackUsed:true`） | 每组 ok 一条 | 规则化 merger（不变，主持不介入） |
| `deep` | — | — | — | 阶段 2 **显式不支持**：在任何调用与预估之前返回 `CONFIG_INVALID`（零调用，消息指明阶段 3 开放成员互评/交叉质询/跨组协调）；不静默降级为 standard |

主持执行条件矩阵（standard）：

| 场景 | 行为 | warning | degraded |
|---|---|---|---|
| 组 `enabled:false` / 零启用成员 / `insufficient` | 不产 CouncilReport，不调主持 | 组级 insufficient 说明（见"结果语义"） | 视其余组结果 |
| 恰好 1 个有效成员 | 跳过主持，规则回退（`fallbackUsed:true`，`moderatorMemberId:""`） | 无 | 不因此置位 |
| ≥2 有效成员，未配置主持 | 规则回退（`fallbackUsed:true`，`moderatorMemberId:""`） | 无 | 不因此置位 |
| ≥2 有效成员，主持成功 | `fallbackUsed:false`，`moderatorMemberId` = 被复用成员 id（useMember）或 `"moderator"`（内联） | 无 | 否 |
| ≥2 有效成员，主持最终失败 | 规则回退但**保留已尝试的主持身份**；原始成员报告完整保留 | 一条脱敏诊断 | **是** |

## 配置说明（councils.json）

完整示例见下文"示例索引"。`world` 与 `character` 两组**必须同时存在**；未知组 id 会被 `CONFIG_INVALID` 拒绝；每组可配置**多个启用成员**。

**memberId 是稳定席位身份**：`id` 标识评议席位，出现在 `reportId`（`<runId>:<councilId>:<memberId>`）、`rawRefs`、`sourceMemberIds` 与提示词路由键中；该席位使用哪个 provider/模型/密钥是挂在席位上的连接配置，更换模型不需要更换 memberId。组内 memberId 不得重复；跨组允许同名 memberId（提示词按键隔离，见下）。

成员字段：

| 字段 | 语义 |
|---|---|
| `provider` | `openai-compatible` 或 `mock`（仅测试） |
| `baseUrlEnv` | 环境变量名；其值为 **API 根地址**（如 `https://api.example.com/v1`）。adapter 自动追加 `/chat/completions` 并规范化末尾斜杠（D19）。**不要**填完整 endpoint |
| `apiKeyEnv` | 环境变量名；密钥只走环境变量 |
| `extraHeadersEnv` | 可选；`{ "Header名": "环境变量名" }`（D18）。配置文件中**禁止**明文 header 密钥；解析值全部进入脱敏器 |
| `rolePromptPath` | 角色提示词文件，相对**配置文件所在目录**解析（与 cwd 无关；CLI 读文件后内联传给 core，core 零文件 IO） |
| `temperature` / `maxTokens` | 可选生成参数 |
| `generationParams` | 可选透传其余生成参数；**禁止** `model`、`messages`、`stream`、`tools`、`tool_choice`（出现即 `CONFIG_INVALID`，D17） |
| `timeoutMs` | 成员级超时，默认 120000 |
| `enabled` | 默认 true；`false` 的成员不被调用、不计入预估 |
| `mockResponses` | 仅 mock 成员：按调用顺序消费的脚本化返回 |

组级字段：

| 字段 | 语义 |
|---|---|
| `enabled` | 默认 true；`false` 的组整体不运行（成员与主持均不调用），按 `insufficient` 处理并给一条 warning |
| `minValidMembers` | 默认 1；有效成员数低于此值 → 该组 `insufficient` |
| `moderator` | 可选；缺省 = 无主持（standard 下规则回退）。`rolePromptPath` 必填（相对配置文件目录解析）；**`useMember` 与内联连接配置二选一，互斥** |
| `moderator.useMember` | 复用同组某**已启用成员**的 provider/model/密钥等全部连接与生成配置（**不**复用其 rolePromptPath/id/name）；主持有自己独立的 `rolePromptPath` |
| `moderator` 内联 | `provider`/`model`/`baseUrlEnv`/`apiKeyEnv`/`extraHeadersEnv`/`temperature`/`maxTokens`/`generationParams`/`timeoutMs`/`mockResponses`，语义同成员字段 |

> mock 备注：`useMember` 指向 mock 成员时，主持会新建独立 MockProvider 从该成员 `mockResponses` 头部重新消费（D31）；内联 mock 主持使用自己的 `mockResponses`（见 `councils.standard-mock.example.json`）。

**rolePrompts 复合键**（库调用时的 `SimulateInput.rolePrompts`；CLI 自动按键构造）：

- 成员：`"${councilId}:${memberId}"`（规范键）；裸 `memberId` 键仍被接受作为向后兼容兜底；
- 主持：`"${councilId}:moderator"`（**无裸键兜底**，避免跨组串键）。

其余配置：

| 字段 | 语义 |
|---|---|
| `limits.maxInputChars` | 输入字符上限，默认 50000；超限明确报错 `PACKET_TOO_LARGE`，**不静默截断**（D8）。成员与主持输入同受此限 |
| `limits.maxReportChars` | 报告字符上限，默认 20000；按完整字段/数组项裁剪，输出恒为有效 JSON（D9） |
| `budget.maxTotalCalls` | **显式全局硬顶**，默认 4，不按模式隐式修改（D26）。首轮 / JSON 修复 / 传输重试 / 主持调用统一计入 |
| `budget.maxRetriesPerCall` | 每次结构化调用（成员或主持）的 JSON 修复重试上限，默认 1 |
| `budget.maxTransportRetries` | 每次调用的传输重试上限，默认 1（0–3）；仅网络错误与 HTTP 429/5xx 可重试，与 JSON 修复**独立计数**（D27） |
| `budget.concurrency` | 全局并发池上限（跨组共享），默认 2 |

**传输重试与 JSON 修复是两种独立机制**：传输重试针对网络错误（`PROVIDER_NETWORK_ERROR`）与 HTTP 429/500/502/503/504，每调用 ≤ `maxTransportRetries` 次；JSON 修复针对模型返回的无法解析/校验失败的输出，每调用 ≤ `maxRetriesPerCall` 次。两者各自独立计数、都计入 `maxTotalCalls`；超时、其余 4xx、响应信封坏（`PROVIDER_BAD_JSON`）不触发传输重试。

环境变量示例（不要提交 `.env`；真实配置建议放在已 gitignore 的 `local/` 等路径）：

```bash
WORLD_API_BASE_URL=https://api.example.com/v1
WORLD_API_KEY=sk-...
WORLD2_API_BASE_URL=https://api.example.org/v1
WORLD2_API_KEY=sk-...
CHARACTER_API_BASE_URL=https://api.example.net/v1
CHARACTER_API_KEY=sk-...
MODERATOR_API_BASE_URL=https://api.example.com/v1
MODERATOR_API_KEY=sk-...
```

## 调用预算与预估（D26/D30/D31）

`estimateCalls(config, mode)` 是**纯函数**（不读 env、无 IO、无时间依赖），给出启动前的确定性计划值：

- 单目标加法上限：`perMemberMaxCalls = 1 + maxRetriesPerCall + maxTransportRetries`（成员与主持同一公式，禁止乘法嵌套）；
- `minCalls = memberCount + minModeratorCalls`（一切顺利：零修复、零传输重试）；
- `maxCalls = memberCount × perMemberMaxCalls + maxModeratorCalls`（理论上界）；
- 主持计数条件（缺一不计）：`mode==="standard"` ∧ 组启用 ∧ 已配置 moderator ∧ 启用成员数 ≥ `max(2, minValidMembers)`；满足时 `minModeratorCalls += 1`、`maxModeratorCalls += (1 + R + T)`。quick 恒 0；
- `enabled:false` 的组与成员不计入 `memberCount`；`insufficient` 是运行后判定，不影响预估；密钥缺失成员预估期无法识别（不读 env），计入上界（实际调用只少不多）。

`budgetCoverage` 三态：

| 状态 | 条件 | 行为 |
|---|---|---|
| `below-min` | `maxTotalCalls < minCalls`（必然不足） | check-config stderr 告警 + simulate `warnings` 注入；**不拒绝、不隐式修改预算**；运行时既有预算闸可能提前截断（`BUDGET_EXCEEDED`） |
| `covers-min` | `minCalls ≤ maxTotalCalls < maxCalls` | 计划可行但不覆盖重试上界；不告警 |
| `covers-max` | `maxTotalCalls ≥ maxCalls` | 全覆盖 |

预估出口：`check-config` 信封的 `estimate` 字段（含 `breakdown`：`baseMemberCalls` / `maxRepairCalls` / `maxTransportRetryCalls` / `minModeratorCalls` / `maxModeratorCalls`）与 simulate `warnings`。`estimate` 是计划值/上界；`report.stats.totalCalls` 是**真实发生值**（含主持调用，恒 ≤ `maxCalls`）。

## 结果语义

- `report.degraded`：任一成员失败/无效，或 standard 主持最终失败时为 `true`；
- `councilReports[].fallbackUsed`：该组主持汇总是否走了规则回退（未配置/单有效成员跳过/主持失败）。`fallbackUsed` 只表示规则回退，不抹掉已尝试的主持身份（`moderatorMemberId`）；
- `warnings`：预算预估不足（below-min）、quick 下配置主持被跳过、主持最终失败诊断（脱敏）、组未启用/无启用成员说明；同时逐行写 stderr；
- `councilResults[].status`：组级判定 `ok | insufficient`；有效成员 < `minValidMembers` → `insufficient`；两组均 insufficient → `ok:false` + `ALL_COUNCILS_FAILED`（退出码 2），不伪造汇总；
- `enabled:false` 的组：不调用其成员与主持，按 insufficient 登记并给一条 warning；仅另一侧有效时报告 `degraded:true` 且 verdict 直通该侧。

## 失败语义

- 单成员失败/超时：其余成员结果保留，报告 `degraded:true`，失败成员在 `rawRefs` 中标记；
- 成员输出 JSON 无效：最多 `maxRetriesPerCall` 次格式修复重试（计入预算），再失败标记 `REPAIR_FAILED`；
- 网络错误（`PROVIDER_NETWORK_ERROR`）/ HTTP 429、500、502、503、504：每次调用最多 `maxTransportRetries` 次传输重试（默认 1，计入预算与 `attempts`）；超时、其余 4xx、响应信封坏（`PROVIDER_BAD_JSON`）不重试；
- 主持失败：规则回退 + warning + `degraded:true`，**原始成员报告始终保留**；
- 两组均无有效结果：`ok:false` + `ALL_COUNCILS_FAILED`，不伪造汇总；
- 密钥未配置：该成员 `ENV_KEY_MISSING`，不发起调用。

## 示例索引（examples/）

| 文件 | 用途 | 关键字段 | quick 预估 | standard 预估 |
|---|---|---|---|---|
| `scene-packet.example.json` | 示例 ScenePacket | — | — | — |
| `councils.example.json` | **单成员兼容配置**（阶段 1 形态，未使用任何新字段） | 单成员 × 2 组 | min 2 / max 6 / 预算 4（covers-min） | 同 quick（未配置主持） |
| `councils.mock.example.json` | quick 冒烟（仅测试） | mock 单成员 × 2 组 | min 2 / max 6 / 预算 4 | — |
| `councils.multi-quick.example.json` | **多成员 quick** + 传输重试/预算显式配置 | world 2 成员 + character 1 成员；`maxTransportRetries` | min 3 / max 9 / 预算 9（covers-max） | 同 quick |
| `councils.standard-usemember.example.json` | **standard + useMember 主持** | world `moderator.useMember` 复用成员连接；主持 `rolePromptPath` | min 3 / max 9（quick 不计主持） | min 4 / max 12 / 预算 12（covers-max；主持 1/3） |
| `councils.standard-inline-moderator.example.json` | **standard + 独立内联主持** | world `moderator` 内联 provider/model/env | min 3 / max 9 | min 4 / max 12 / 预算 12（covers-max；主持 1/3） |
| `councils.disabled-council.example.json` | **某组 `enabled:false`** | character 组停用；其成员与主持不被调用 | min 1 / max 3 / 预算 4（covers-max） | 同 quick |
| `councils.standard-mock.example.json` | standard 主持 mock 冒烟（仅测试） | 内联 mock 主持 `mockResponses`（ModeratorOutput JSON） | min 3 / max 9 | min 4 / max 12 / 预算 12（covers-max；主持 1/3） |

预估列对应 `check-config --mode <mode>` 的 `estimate`（`minCalls`/`maxCalls`/`budgetCoverage`；主持列为 `breakdown.minModeratorCalls/maxModeratorCalls`），由 `tests/examples.test.ts` 锁定。

> 示例中的 `baseUrlEnv`/`apiKeyEnv` 只有环境变量**名**；值为占位符，复制后填入你自己的模型标识与环境变量名即可。openai-compatible 示例在未设置 env 时 `check-config` 报告 `keyConfigured:false`，不会发起任何调用。

## 提示词（prompts/）

| 文件 | 用途 |
|---|---|
| `world-causality.md` | world 组成员角色提示词（世界运行评议者） |
| `character-psychology.md` | character 组成员角色提示词（人物心理评议者） |
| `world-moderator.md` | world 组主持提示词（组内汇总） |
| `character-moderator.md` | character 组主持提示词（组内汇总） |

- 提示词是**运行时必需的内容输入**，但文件位置由配置中的 `rolePromptPath` 决定——`prompts/` 是默认示例，可复制后自行改写；
- 主持提示词约束输出严格对齐主持输出 schema：`verdict` / `summary` / `consensus` / `disagreements` / `minorityOpinions` / `evidenceStrength` / `questionsForMainModel`，不要求任何其他字段；
- CLI 按 `${councilId}:${memberId}` 与 `${councilId}:moderator` 键把提示词内容传给 core（core 零文件 IO）。

## JSON Schema（schemas/）

7 份，全部由 `npm run gen:schemas` 从 `src/contracts/`（zod 单一来源）生成，**禁止手写双份**：

`scene-packet` / `council-config` / `world-member-output` / `character-member-output` / `member-report` / `council-report` / `final-council-report`。

## 目录结构

```text
src/
  contracts/    # 唯一契约来源（zod schema + 推导类型）
  providers/    # ProviderAdapter：openai-compatible / mock
  core/         # orchestrator / council-kinds / council-runner / structured-call /
                # moderator-runner / report-merger / budget / validation / redaction / events / errors
  cli/          # bin 入口：simulate / check-config
prompts/        # 角色提示词（world / character 成员与主持；默认示例，可替换）
examples/       # 示例 packet 与配置（mock 配置仅供测试）
schemas/        # 由 contracts 生成的 7 份 JSON Schema（npm run gen:schemas，勿手写）
tests/          # Vitest + MockProvider + 夹具
docs/           # 架构与契约文档
```

依赖方向：`contracts ← providers ← core ← cli`；core 不做任何文件 IO（纯计算），文件读写只在 CLI 层。

## 作为库使用

`src/index.ts` 是当前公共导出入口（构建产物 `dist/index.js` + `dist/index.d.ts` 已随 `npm run build` 生成并经验证可导入）：

```ts
import { simulateScene, checkConfig, estimateCalls } from "./dist/index.js";
```

- core 为纯计算：`rolePrompts`（复合键见上）、`env`、`onProgress` 等均由调用方传入；stdout/写文件由 CLI 层负责；
- 本包当前为 `private`，未声明 `exports`；正式 package exports 与宿主集成形态留待阶段 4（Pi 集成）确定。

## 依赖政策（D11/D22）

- 运行时依赖：仅 `zod`（契约单一来源与运行时校验）。
- 开发依赖：`typescript`（构建）、`vitest`（测试）、`tsx`（开发调试）、`@types/node`（纯类型）。
- HTTP 使用 Node 22 原生 `fetch`；无 bundler、无厂商 SDK、无 Agent 框架。

## 阶段 2 范围外（未实现，勿误用）

Pi Extension / Pi Skill、MCP、WebUI、数据库、canon、checkpoint、正式状态提交、**deep 模式**（显式 `CONFIG_INVALID`）、成员互评/交叉质询/跨组协调（阶段 3）、writingCouncil、报告自动留档、Anthropic/Gemini 原生协议。子模型输出的 `proposedDelta` 只是假设/建议，**不会**被写入任何正式设定。
