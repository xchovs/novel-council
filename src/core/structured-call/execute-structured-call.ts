import { z } from "zod";
import { CoreError, type ErrorCode } from "../../contracts/index.js";
import type { ChatMessage } from "../../providers/types.js";
import type { CallBudget } from "../budget/budget.js";
import type { Redactor } from "../redaction/redact.js";
import { toCoreError } from "../errors/core-error.js";
import { extractJson } from "../validation/json-extract.js";
import { summarizeIssues } from "../validation/validate.js";
import { buildRepairMessages } from "../orchestrator/prompt-build.js";

/**
 * core/structured-call：结构化输出的通用有界调用循环（C3 纪律的中立抽取，D31）。
 * council-runner（成员）与 moderator-runner（组内主持）共用本模块——
 * 全系统只有这一套重试实现，禁止复制出第二套不一致的循环。
 *
 * 纪律（与 C3 完全一致）：
 * - 每次真实调用前过预算闸（BUDGET_EXCEEDED 计入 exceeded，重试不发起）；
 * - JSON 修复 ≤ maxRetries、传输重试 ≤ maxTransportRetries，双独立计数器互不消费额度；
 * - 单目标调用总数 ≤ 1 + maxRetries + maxTransportRetries（加法上限，无嵌套乘法）；
 * - 传输重试事件仅在重试调用实际发起前经 onTransportRetry 回调（预算闸住则不回调）；
 * - 本函数永不 reject：终态以 StructuredCallOutcome 判别联合返回。
 */

/** 传输重试事件载荷（预算已通过、调用即将发起，attempt ≥ 2）。 */
export interface StructuredCallRetryEvent {
  attempt: number;
  code: ErrorCode;
  httpStatus?: number;
}

export interface ExecuteStructuredCallArgs<T> {
  /** 首轮消息（修复重试在其上追加回显，不修改原数组）。 */
  baseMessages: ChatMessage[];
  /** 输出 zod schema（成员输出 / 主持输出）。 */
  schema: z.ZodType<T>;
  /** 单次 provider 调用封装（含独立 AbortSignal.timeout 与生成参数）。 */
  invoke: (messages: ChatMessage[]) => Promise<string>;
  maxRetries: number;
  /** 传输重试总次数上限（D27；0 = 关闭传输重试）。 */
  maxTransportRetries: number;
  budget: CallBudget;
  redact: Redactor;
  /** 失败错误的关联上下文（memberId/councilId）。 */
  errorContext?: { memberId?: string; councilId?: string };
  /** 传输重试回调（可选；预算通过后、重试调用发起前触发，与真实调用一一对应）。 */
  onTransportRetry?: (event: StructuredCallRetryEvent) => void;
}

export type StructuredCallOutcome<T> =
  | { ok: true; output: T; attempts: number; repaired: boolean }
  | { ok: false; error: CoreError; attempts: number };

export async function executeStructuredCall<T>(
  args: ExecuteStructuredCallArgs<T>
): Promise<StructuredCallOutcome<T>> {
  let attempts = 0;
  let repairs = 0;
  let transportRetries = 0;
  let messages = args.baseMessages;
  let lastIssues = "";
  // 上一次调用判定为可重试传输错误时记录其原因；下一轮预算闸通过、attempts++ 后、
  // 实际调用发起前据此回调（回调与真实发起的 provider 调用一一对应）。
  let pendingRetry: CoreError | null = null;

  for (;;) {
    // 预算闸（A10）：每次真实调用前消费；闸住则重试不发起，且不触发重试回调
    try {
      args.budget.consume();
    } catch (e) {
      return { ok: false, error: toCoreError(e, "BUDGET_EXCEEDED", args.errorContext), attempts };
    }
    attempts += 1;

    // 传输重试回调：预算已通过、调用即将发起，回调与调用一一对应
    if (pendingRetry !== null) {
      args.onTransportRetry?.({
        attempt: attempts,
        code: pendingRetry.code,
        ...(pendingRetry.httpStatus !== undefined ? { httpStatus: pendingRetry.httpStatus } : {})
      });
      pendingRetry = null;
    }

    // 调用：超时由 invoke 封装（每次尝试独立计时）
    let raw: string;
    try {
      raw = await args.invoke(messages);
    } catch (e) {
      const err = toCoreError(e, "INTERNAL", args.errorContext);
      // 传输重试（D27）：白名单内且额度未耗尽 → messages 不变，回到循环直接重调
      if (isRetryableTransport(err) && transportRetries < args.maxTransportRetries) {
        transportRetries += 1;
        pendingRetry = err;
        continue;
      }
      // 超时、其余 4xx、PROVIDER_BAD_JSON、额度耗尽：最终失败原因即该错误
      return { ok: false, error: err, attempts };
    }

    // JSON 提取 + zod 校验
    const extracted = extractJson(raw);
    if (extracted !== null) {
      const parsed = args.schema.safeParse(extracted.data);
      if (parsed.success) {
        // repaired ⟺ 经过 JSON 修复；仅传输重试后成功仍为 ok
        return { ok: true, output: parsed.data, attempts, repaired: repairs > 0 };
      }
      lastIssues = summarizeIssues(parsed.error);
    } else {
      lastIssues = "输出中未找到可解析的 JSON 对象";
    }

    // 格式修复重试（§11）：额度独立于传输重试；超过次数标记 REPAIR_FAILED
    if (repairs >= args.maxRetries) {
      return {
        ok: false,
        error: new CoreError("REPAIR_FAILED", `JSON 校验失败且修复未成功：${lastIssues}`, args.errorContext),
        attempts
      };
    }
    repairs += 1;
    messages = buildRepairMessages(args.baseMessages, raw, args.redact(lastIssues));
  }
}

/** 可重试 HTTP 状态白名单（D27：仅依据状态码判定，禁止厂商/网关特判）。 */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * 传输错误重试判定（architecture §9.4：分类在 provider，策略在本模块）：
 * 仅 PROVIDER_NETWORK_ERROR 与白名单 HTTP 状态可重试；
 * PROVIDER_TIMEOUT（已等满整个超时）、其余 4xx、无 httpStatus 的 HTTP 错误、
 * PROVIDER_BAD_JSON 及一切非传输错误均不重试。
 */
export function isRetryableTransport(e: CoreError): boolean {
  if (e.code === "PROVIDER_NETWORK_ERROR") return true;
  if (e.code === "PROVIDER_HTTP_ERROR") {
    return e.httpStatus !== undefined && RETRYABLE_HTTP_STATUSES.has(e.httpStatus);
  }
  return false;
}
