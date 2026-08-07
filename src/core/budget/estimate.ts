import type { CouncilConfig, ExecutionMode } from "../../contracts/index.js";
import { assertModeRunnable } from "../orchestrator/execution-modes.js";

/**
 * core/budget/estimate：确定性调用数预估（C4 落地，C5 扩展主持计数，D26/D30/D31）。
 * 纯函数：只读已校验的 CouncilConfig 与 mode；不读 env、无 IO、无时间/随机依赖（同输入恒同输出）。
 *
 * estimate 是启动前的计划值/理论上界；stats.totalCalls 是真实发生值，两者语义不同：
 * - 恒有 totalCalls ≤ maxCalls（预算闸可能提前截断）；
 * - ENV_KEY_MISSING 等预失败成员实际 0 调用，预估期无法识别（不读 env），故 totalCalls 可小于 minCalls；
 * - 运行时成员失败导致的"单有效成员跳过主持"属运行态，不影响预估上界（预估用启用成员数判定）。
 *
 * 计数与 C3 锁定的单目标上限一致：1 + maxRetriesPerCall + maxTransportRetries（加法）；
 * 禁止重新引入乘法嵌套（如 (1+R)×(1+T)）。
 */

/** 预算覆盖三态（A32）：below-min 必然不足（告警态）；covers-min 计划可行但不覆盖重试上界；covers-max 全覆盖。 */
export type BudgetCoverage = "below-min" | "covers-min" | "covers-max";

export interface CallEstimateBreakdown {
  /** 基础成员调用数：每个启用成员首轮 1 次。 */
  baseMemberCalls: number;
  /** JSON 修复理论上限：启用成员数 × maxRetriesPerCall。 */
  maxRepairCalls: number;
  /** 传输重试理论上限：启用成员数 × maxTransportRetries（D27）。 */
  maxTransportRetryCalls: number;
  /**
   * 主持最低计划调用数（C5，D31）：mode==="standard" 且组启用、已配置 moderator、
   * 启用成员数 ≥ max(2, minValidMembers) 的组，每组 1 次；否则 0。quick 恒 0（D25）。
   */
  minModeratorCalls: number;
  /** 主持理论上限：上述组数 × (1 + maxRetriesPerCall + maxTransportRetries)（与成员同一加法公式）。 */
  maxModeratorCalls: number;
}

export interface CallEstimate {
  /** 预估模式（deep 不可预估：estimateCalls 对其抛 CONFIG_INVALID）。 */
  mode: "quick" | "standard";
  /** 计入预估的启用成员数（disabled 组 / disabled 成员不计；insufficient 为运行后判定，不影响预估）。 */
  memberCount: number;
  /** 单成员调用上限 = 1 + maxRetriesPerCall + maxTransportRetries（C3 加法上限，显式暴露供测试锁定）。 */
  perMemberMaxCalls: number;
  /** 最小计划调用数 = memberCount + minModeratorCalls（一切顺利：零修复、零传输重试）。 */
  minCalls: number;
  /** 最大理论调用数 = memberCount × perMemberMaxCalls + maxModeratorCalls。 */
  maxCalls: number;
  /** 回显配置预算（显式全局硬顶，不按模式隐式修改，D26）。 */
  maxTotalCalls: number;
  budgetCoverage: BudgetCoverage;
  breakdown: CallEstimateBreakdown;
}

/**
 * 只读预估（D26）：deep → CoreError CONFIG_INVALID（消息与 orchestrator 一致，D24）。
 * below-min 的告警/不拒绝决策由调用方（orchestrator / CLI）执行，本函数只产出事实。
 *
 * 主持计划计数条件（D31，与运行时确定性跳过规则对齐）——以下全部成立才计 1 个计划单位：
 * mode==="standard" ∧ council enabled ∧ moderator 已配置 ∧ enabledMemberCount ≥ max(2, minValidMembers)。
 */
export function estimateCalls(config: CouncilConfig, mode: ExecutionMode): CallEstimate {
  const runnableMode = assertModeRunnable(mode);
  const { maxTotalCalls, maxRetriesPerCall, maxTransportRetries } = config.budget;

  let memberCount = 0;
  let moderatorUnits = 0;
  for (const council of config.councils) {
    if (!council.enabled) continue; // disabled 组整组不计（与运行时 planned 逻辑一致）
    const enabledMemberCount = council.members.filter((m) => m.enabled).length;
    memberCount += enabledMemberCount;
    if (
      runnableMode === "standard" &&
      council.moderator !== undefined &&
      enabledMemberCount >= Math.max(2, council.minValidMembers)
    ) {
      moderatorUnits += 1;
    }
  }

  const perMemberMaxCalls = 1 + maxRetriesPerCall + maxTransportRetries;
  const breakdown: CallEstimateBreakdown = {
    baseMemberCalls: memberCount,
    maxRepairCalls: memberCount * maxRetriesPerCall,
    maxTransportRetryCalls: memberCount * maxTransportRetries,
    minModeratorCalls: moderatorUnits,
    maxModeratorCalls: moderatorUnits * perMemberMaxCalls
  };
  const minCalls = breakdown.baseMemberCalls + breakdown.minModeratorCalls;
  const maxCalls = memberCount * perMemberMaxCalls + breakdown.maxModeratorCalls;
  const budgetCoverage: BudgetCoverage =
    maxTotalCalls < minCalls ? "below-min" : maxTotalCalls < maxCalls ? "covers-min" : "covers-max";

  return { mode: runnableMode, memberCount, perMemberMaxCalls, minCalls, maxCalls, maxTotalCalls, budgetCoverage, breakdown };
}
