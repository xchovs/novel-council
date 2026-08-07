import { z } from "zod";
import { VerdictSchema } from "./member-report.js";

/**
 * CouncilReport（组内主持汇总，data-contracts §5.4，D25/D31，C5）。
 * - ModeratorOutput 为模型产出：先经 zod 校验，失败进入修复重试流程（与成员同一纪律，§11）；
 * - CouncilReport 为组级信封：仅 standard 模式经 SimulateResult.councilReports 交付（quick 为空数组）；
 * - FinalCouncilReport 始终由规则化 merger 生成，不依赖主持输出（C16）；
 * - 主持失败/未配置/单有效成员跳过 → 规则回退（fallbackUsed: true），原始成员报告始终保留（A06）。
 */

const stringList = z.array(z.string()).default([]);

/** 主持模型输出：只整理不发挥；必须保留核心分歧、少数意见与证据强弱（规划 §9.3）。 */
export const ModeratorOutputSchema = z.object({
  verdict: VerdictSchema,
  summary: z.string().default(""),
  consensus: stringList,
  disagreements: stringList,
  minorityOpinions: stringList,
  evidenceStrength: stringList,
  questionsForMainModel: stringList
});
export type ModeratorOutput = z.infer<typeof ModeratorOutputSchema>;

export const CouncilReportSchema = ModeratorOutputSchema.extend({
  councilId: z.string().min(1),
  /**
   * 实际担任/尝试担任主持的 id（D31）：
   * useMember → 被复用成员 id；内联主持 → "moderator"；
   * 未配置主持或单有效成员跳过的规则回退 → ""（fallbackUsed 只表示规则回退，不抹掉已尝试的主持身份）。
   */
  moderatorMemberId: z.string().default(""),
  fallbackUsed: z.boolean(),
  /** 参与本组汇总的有效成员 id（按 memberId 升序，与完成顺序无关，确定性）。 */
  sourceMemberIds: z.array(z.string()).default([])
});
export type CouncilReport = z.infer<typeof CouncilReportSchema>;
