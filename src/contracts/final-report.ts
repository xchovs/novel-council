import { z } from "zod";
import { VerdictSchema, MemberStatusSchema, ProposedDeltaSchema } from "./member-report.js";

/**
 * FinalCouncilReport v1（data-contracts §6）。
 * 压缩报告：只含结论与 rawRefs；原始成员报告经 SimulateResult.memberReports 返回。
 */

export const SeveritySchema = z.enum(["info", "warning", "blocking"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  topic: z.string(),
  detail: z.string(),
  severity: SeveritySchema,
  sourceMemberIds: z.array(z.string()).default([])
});
export type Finding = z.infer<typeof FindingSchema>;

export const AlternativePlanSchema = z.object({
  id: z.string().min(1),
  summary: z.string(),
  advantages: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  requiredChanges: z.array(z.string()).default([]),
  sourceMemberIds: z.array(z.string()).default([])
});
export type AlternativePlan = z.infer<typeof AlternativePlanSchema>;

export const RawRefSchema = z.object({
  reportId: z.string().min(1),
  councilId: z.string().min(1),
  memberId: z.string().min(1),
  status: MemberStatusSchema
});
export type RawRef = z.infer<typeof RawRefSchema>;

export const RunStatsSchema = z.object({
  totalCalls: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  repaired: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  budgetExceeded: z.boolean()
});
export type RunStats = z.infer<typeof RunStatsSchema>;

export const TruncationSchema = z.object({
  applied: z.boolean(),
  droppedSections: z.array(z.string()).default([])
});
export type Truncation = z.infer<typeof TruncationSchema>;

export const FinalCouncilReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  sceneId: z.string().min(1),
  generatedAt: z.string().min(1),
  /** 阶段 2 仅 quick|standard（D24）；deep 在 orchestrator 被拒绝，不产生报告。 */
  mode: z.enum(["quick", "standard"]),
  degraded: z.boolean(),
  overallVerdict: VerdictSchema,
  planStrengths: z.array(z.string()).default([]),
  worldFindings: z.array(FindingSchema).default([]),
  characterFindings: z.array(FindingSchema).default([]),
  alternativePlans: z.array(AlternativePlanSchema).default([]),
  uncertainHypotheses: z.array(z.string()).default([]),
  proposedDeltas: z.array(ProposedDeltaSchema).default([]),
  questionsForMainModel: z.array(z.string()).default([]),
  rawRefs: z.array(RawRefSchema).default([]),
  stats: RunStatsSchema,
  truncation: TruncationSchema
});
export type FinalCouncilReport = z.infer<typeof FinalCouncilReportSchema>;
