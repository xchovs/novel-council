import { CoreError, type ErrorCode, type ExecutionMode } from "../../contracts/index.js";

/**
 * core/orchestrator/execution-modes：执行模式策略文案的唯一定义点（C4/C5）。
 * 以下常量与文案构造函数在本文件集中定义，禁止在其他文件重复硬编码相同文案；
 * 测试经 import 引用，不复制字面量。
 */

/**
 * D24：deep 在阶段 2 显式拒绝（orchestrator / estimateCalls / checkConfig 共用同一消息）。
 * 消息指明阶段 3 开放成员互评/交叉质询/跨组协调；禁止静默降级为 standard 或伪装支持。
 */
export const DEEP_MODE_UNSUPPORTED_MESSAGE =
  "mode=deep 在阶段 2 不支持：成员互评、交叉质询与跨组协调管线将于阶段 3 开放（D24），不会静默降级为 standard";

/**
 * D25/D31：quick 不调用主持；配置了 moderator 的启用组逐组注入一次跳过提示。
 * standard 未配置主持的规则回退不告警（A34）；deep 在运行前 CONFIG_INVALID，不出现本提示。
 */
export function moderatorSkippedQuickWarning(councilId: string): string {
  return `quick 模式不调用主持：评议组 ${councilId} 已配置 moderator，本次跳过主持汇总，结果由规则化合并产生（D25）`;
}

/**
 * D31：主持最终失败 → 规则回退（fallbackUsed=true）。诊断经 warnings 暴露（detail 须已脱敏），
 * CouncilReport 不携带 error 字段；原始成员报告完整保留（A06）。
 */
export function moderatorFailedWarning(councilId: string, code: ErrorCode, detail: string): string {
  return `评议组 ${councilId} 主持调用失败（${code}）：${detail}；已回退规则化汇总（fallbackUsed=true），原始成员报告完整保留（A06）`;
}

/** 模式运行门禁：deep → CONFIG_INVALID（D24）；quick/standard 原样返回。 */
export function assertModeRunnable(mode: ExecutionMode): "quick" | "standard" {
  if (mode === "deep") {
    throw new CoreError("CONFIG_INVALID", DEEP_MODE_UNSUPPORTED_MESSAGE);
  }
  return mode;
}
