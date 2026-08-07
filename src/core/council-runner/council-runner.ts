import {
  CoreError,
  type CoreErrorJson,
  type MemberConfig,
  type MemberOutput,
  type MemberReport,
  type MemberStatus,
  type ScenePacket
} from "../../contracts/index.js";
import type { ProviderAdapter } from "../../providers/types.js";
import type { CallBudget } from "../budget/budget.js";
import { getCouncilKind, knownCouncilIds } from "../council-kinds/council-kinds.js";
import { safeEmit, type ProgressHandler } from "../events/emit.js";
import type { Redactor } from "../redaction/redact.js";
import { executeStructuredCall } from "../structured-call/execute-structured-call.js";
import { buildMemberMessages, measureInputChars } from "../orchestrator/prompt-build.js";

/**
 * core/council-runner：单成员完整生命周期（architecture §9）。
 * council-kind 解析（未知组显式失败，零调用）→ 预检（PACKET_TOO_LARGE，零调用）
 * → 通用结构化调用循环（core/structured-call，C3 纪律的唯一实现，D31）：
 * 预算闸 → 调用（独立 AbortSignal.timeout）→ JSON 提取 + zod 校验
 * → 修复重试 ≤ maxRetries 与传输重试 ≤ maxTransportRetries（双独立计数，
 * 每成员调用总数 ≤ 1 + maxRetries + maxTransportRetries，加法上限）。
 * member-retry 事件仅在传输重试调用实际发起前发射（预算闸住、重试未发起时不发射）。
 * 本函数永不 reject。
 */

export interface RunMemberArgs {
  runId: string;
  councilId: string;
  member: MemberConfig;
  provider: ProviderAdapter;
  packet: ScenePacket;
  rolePrompt: string;
  maxInputChars: number;
  maxRetries: number;
  /** 每成员传输重试总次数上限（D27；0 = 关闭传输重试）。 */
  maxTransportRetries: number;
  budget: CallBudget;
  redact: Redactor;
  now: () => Date;
  /** 传输重试事件出口（可选；由 orchestrator 透传宿主回调）。 */
  onProgress?: ProgressHandler;
}

export async function runMember(args: RunMemberArgs): Promise<MemberReport> {
  const { runId, councilId, member } = args;
  const started = args.now();
  const envelope = {
    reportId: `${runId}:${councilId}:${member.id}`,
    runId,
    councilId,
    memberId: member.id
  };

  const finish = (
    status: MemberStatus,
    attempts: number,
    error: CoreErrorJson | null,
    output: MemberOutput | null
  ): MemberReport => ({
    ...envelope,
    status,
    attempts,
    error,
    output,
    latencyMs: Math.max(0, args.now().getTime() - started.getTime())
  });

  const fail = (error: CoreError, attempts: number): MemberReport =>
    finish("failed", attempts, { ...error.toJSON(), message: args.redact(error.message) }, null);

  // 0. 评议组种类解析（C14）：未知组显式失败、零调用；orchestrator 已先行校验，此为防御性兜底
  const kind = getCouncilKind(councilId);
  if (kind === undefined) {
    return fail(
      new CoreError(
        "CONFIG_INVALID",
        `未知评议组 "${councilId}"（仅支持 ${knownCouncilIds().join("/")}）`,
        { memberId: member.id, councilId }
      ),
      0
    );
  }

  // 1. 输入体积预检：超限不发起任何调用（D8，禁止静默截断）
  const baseMessages = buildMemberMessages({
    outputShape: kind.outputShape,
    rolePrompt: args.rolePrompt,
    packet: args.packet
  });
  const inputChars = measureInputChars(baseMessages);
  if (inputChars > args.maxInputChars) {
    return fail(
      new CoreError(
        "PACKET_TOO_LARGE",
        `成员 ${member.id} 输入 ${inputChars} 字符，超过 maxInputChars=${args.maxInputChars}`,
        { memberId: member.id, councilId }
      ),
      0
    );
  }

  // 2. 通用结构化调用循环（与主持共用同一实现，禁止第二套重试逻辑）
  const outcome = await executeStructuredCall<MemberOutput>({
    baseMessages,
    schema: kind.outputSchema,
    invoke: (messages) =>
      args.provider.chat(
        {
          model: member.model,
          messages,
          ...(member.temperature !== undefined ? { temperature: member.temperature } : {}),
          ...(member.maxTokens !== undefined ? { maxTokens: member.maxTokens } : {}),
          extraParams: member.generationParams
        },
        { signal: AbortSignal.timeout(member.timeoutMs) }
      ),
    maxRetries: args.maxRetries,
    maxTransportRetries: args.maxTransportRetries,
    budget: args.budget,
    redact: args.redact,
    errorContext: { memberId: member.id, councilId },
    onTransportRetry: ({ attempt, code, httpStatus }) =>
      safeEmit(args.onProgress, {
        type: "member-retry",
        runId,
        councilId,
        memberId: member.id,
        attempt,
        code,
        ...(httpStatus !== undefined ? { httpStatus } : {})
      })
  });

  return outcome.ok
    ? finish(outcome.repaired ? "repaired" : "ok", outcome.attempts, null, outcome.output)
    : fail(outcome.error, outcome.attempts);
}
