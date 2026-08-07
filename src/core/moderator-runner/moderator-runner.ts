import {
  CoreError,
  ModeratorOutputSchema,
  type CoreErrorJson,
  type CouncilEntry,
  type CouncilReport,
  type MemberOutput,
  type MemberReport,
  type ModeratorOutput,
  type ScenePacket,
  type Verdict
} from "../../contracts/index.js";
import type { ProviderAdapter } from "../../providers/types.js";
import type { CallBudget } from "../budget/budget.js";
import type { Redactor } from "../redaction/redact.js";
import { deriveVerdict } from "../report-merger/merge.js";
import { executeStructuredCall } from "../structured-call/execute-structured-call.js";
import { buildModeratorMessages, measureInputChars } from "../orchestrator/prompt-build.js";

/**
 * core/moderator-runner：组内主持汇总（standard 模式，D25/D31，C5）。
 * - 输入隔离：只读取本组有效成员报告（按 memberId 升序）、packet 与主持提示词；
 *   不存在任何读取其他评议组成员报告的通道（无跨组信息泄漏）。
 * - 重试纪律：调用循环唯一实现为 core/structured-call（与成员同一套，禁止第二套）；
 *   主持传输重试不发射事件（事件面最小化，D31），预算闸与计数与成员完全一致。
 * - 失败不丢成员结果：任何最终失败（网络/HTTP/超时/坏 JSON/schema/预算/体积预检）
 *   都回退 fallbackCouncilReport 规则化推导，错误以脱敏后的 CoreErrorJson 返回（供 warnings）；
 *   CouncilReport 不携带 error 字段（§5.4 冻结字段）。
 * - runModerator 永不 reject。
 */

/**
 * 主持连接配置的解析结果（useMember 复用或内联，D25）。
 * 复用成员时仅复制连接与生成配置；不复用 rolePromptPath（主持有自己的 rolePromptPath）。
 */
export interface ResolvedModeratorConfig {
  /** useMember → 被复用成员 id；内联主持 → "moderator"。 */
  moderatorMemberId: string;
  provider: "openai-compatible" | "mock";
  model: string;
  baseUrlEnv?: string;
  apiKeyEnv?: string;
  extraHeadersEnv: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  generationParams: Record<string, unknown>;
  timeoutMs: number;
  mockResponses?: string[];
}

/**
 * 解析组内主持的有效连接配置（纯函数，不读 env）。
 * schema 层已保证 useMember 指向同组已启用成员、内联形态必填字段齐全（CouncilConfigSchema）；
 * 此处仍做防御性兜底，解析失败返回 undefined（调用方按无主持处理）。
 */
export function resolveModeratorConfig(council: CouncilEntry): ResolvedModeratorConfig | undefined {
  const mod = council.moderator;
  if (mod === undefined) return undefined;
  if (mod.useMember !== undefined) {
    const target = council.members.find((m) => m.id === mod.useMember);
    if (target === undefined || !target.enabled) return undefined; // 防御：schema 已拒绝此形态
    return {
      moderatorMemberId: target.id,
      provider: target.provider,
      model: target.model,
      ...(target.baseUrlEnv !== undefined ? { baseUrlEnv: target.baseUrlEnv } : {}),
      ...(target.apiKeyEnv !== undefined ? { apiKeyEnv: target.apiKeyEnv } : {}),
      extraHeadersEnv: target.extraHeadersEnv,
      ...(target.temperature !== undefined ? { temperature: target.temperature } : {}),
      ...(target.maxTokens !== undefined ? { maxTokens: target.maxTokens } : {}),
      generationParams: target.generationParams,
      timeoutMs: target.timeoutMs,
      ...(target.mockResponses !== undefined ? { mockResponses: target.mockResponses } : {})
    };
  }
  if (mod.provider === undefined) return undefined; // 防御：schema 已拒绝此形态
  return {
    moderatorMemberId: "moderator",
    provider: mod.provider,
    model: mod.model,
    ...(mod.baseUrlEnv !== undefined ? { baseUrlEnv: mod.baseUrlEnv } : {}),
    ...(mod.apiKeyEnv !== undefined ? { apiKeyEnv: mod.apiKeyEnv } : {}),
    extraHeadersEnv: mod.extraHeadersEnv,
    ...(mod.temperature !== undefined ? { temperature: mod.temperature } : {}),
    ...(mod.maxTokens !== undefined ? { maxTokens: mod.maxTokens } : {}),
    generationParams: mod.generationParams,
    timeoutMs: mod.timeoutMs,
    ...(mod.mockResponses !== undefined ? { mockResponses: mod.mockResponses } : {})
  };
}

/** 按 memberId 升序排序（确定性：与异步完成顺序无关，D31）。 */
function sortByMemberId(reports: MemberReport[]): MemberReport[] {
  return [...reports].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/**
 * 规则化 CouncilReport 推导（fallback，§5.4/D25）：
 * verdict 按 §6.1 规则（复用 merger 的 deriveVerdict），其余字段保守/为空。
 * 纯函数：输入按 memberId 排序后处理，输出与完成顺序无关。
 * moderatorMemberId 由调用方给出（D31：已尝试主持的失败回退保留主持身份；
 * 未配置主持/单有效成员跳过传 ""）。
 */
export function fallbackCouncilReport(args: {
  councilId: string;
  /** 本组有效成员报告（status ok|repaired 且 output 非空）。 */
  validReports: MemberReport[];
  moderatorMemberId: string;
}): CouncilReport {
  const sorted = sortByMemberId(args.validReports);
  const verdicts = sorted.map((r) => (r.output as { verdict: Verdict }).verdict);
  return {
    councilId: args.councilId,
    verdict: deriveVerdict(verdicts),
    summary: "",
    consensus: [],
    disagreements: [],
    minorityOpinions: [],
    evidenceStrength: [],
    questionsForMainModel: [],
    moderatorMemberId: args.moderatorMemberId,
    fallbackUsed: true,
    sourceMemberIds: sorted.map((r) => r.memberId)
  };
}

export interface RunModeratorArgs {
  councilId: string;

  moderator: ResolvedModeratorConfig;
  provider: ProviderAdapter;
  packet: ScenePacket;
  /** 主持角色提示词（CLI 以 `${councilId}:moderator` 键内联传入，D-A/D31）。 */
  rolePrompt: string;
  /** 本组有效成员报告（函数内按 memberId 排序，与传入顺序无关）。 */
  validReports: MemberReport[];
  /** 本组失败成员 id（仅 id 注入，不含其内容）。 */
  failedMemberIds: string[];
  maxInputChars: number;
  maxRetries: number;
  maxTransportRetries: number;
  budget: CallBudget;
  redact: Redactor;
  now: () => Date;
}

export interface ModeratorOutcome {
  /** 成功或规则回退均有报告（A06：任何失败都不丢成员结果）。 */
  report: CouncilReport;
  /** 主持最终错误（已脱敏；null ⟺ 主持成功），供 orchestrator 注入 warnings。 */
  error: CoreErrorJson | null;
  latencyMs: number;
}

export async function runModerator(args: RunModeratorArgs): Promise<ModeratorOutcome> {
  const { councilId, moderator } = args;

  const started = args.now();
  const sorted = sortByMemberId(args.validReports);
  const elapsed = (): number => Math.max(0, args.now().getTime() - started.getTime());

  const fail = (error: CoreError): ModeratorOutcome => ({
    // 已尝试主持的失败回退保留主持身份（D31）
    report: fallbackCouncilReport({
      councilId,
      validReports: sorted,
      moderatorMemberId: moderator.moderatorMemberId
    }),
    error: { ...error.toJSON(), message: args.redact(error.message) },
    latencyMs: elapsed()
  });

  // 1. 输入体积预检：超限不发起任何调用（D8，禁止静默截断）
  const baseMessages = buildModeratorMessages({
    rolePrompt: args.rolePrompt,
    packet: args.packet,
    validReports: sorted.map((r) => ({ memberId: r.memberId, output: r.output as MemberOutput })),
    failedMemberIds: args.failedMemberIds
  });
  const inputChars = measureInputChars(baseMessages);
  if (inputChars > args.maxInputChars) {
    return fail(
      new CoreError(
        "PACKET_TOO_LARGE",
        `评议组 ${councilId} 主持输入 ${inputChars} 字符，超过 maxInputChars=${args.maxInputChars}`,
        { councilId }
      )
    );
  }

  // 2. 通用结构化调用循环（与成员同一实现；主持不发射传输重试事件，D31）
  const outcome = await executeStructuredCall<ModeratorOutput>({
    baseMessages,
    schema: ModeratorOutputSchema,
    invoke: (messages) =>
      args.provider.chat(
        {
          model: moderator.model,
          messages,
          ...(moderator.temperature !== undefined ? { temperature: moderator.temperature } : {}),
          ...(moderator.maxTokens !== undefined ? { maxTokens: moderator.maxTokens } : {}),
          extraParams: moderator.generationParams
        },
        { signal: AbortSignal.timeout(moderator.timeoutMs) }
      ),
    maxRetries: args.maxRetries,
    maxTransportRetries: args.maxTransportRetries,
    budget: args.budget,
    redact: args.redact,
    errorContext: { councilId }
  });

  if (!outcome.ok) return fail(outcome.error);
  return {
    report: {
      councilId,
      ...outcome.output,
      moderatorMemberId: moderator.moderatorMemberId,
      fallbackUsed: false,
      sourceMemberIds: sorted.map((r) => r.memberId)
    },
    error: null,
    latencyMs: elapsed()
  };
}
