import { z } from "zod";
import { CoreErrorJsonSchema } from "./errors.js";

/**
 * MemberReport 信封与成员输出（data-contracts §5）。
 * 成员输出为模型产出：默认 strip 未知键、数组字段默认 []（§1.5），
 * 先经 zod 校验，失败进入一次修复重试流程（§11）。
 */

const stringList = z.array(z.string()).default([]);

export const VerdictSchema = z.enum(["accept", "revise", "reject"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** §5.3：kind 仅允许 hypothesis / suggestion；canon/fact/confirmed 等取值在 schema 层拒绝（A12）。 */
export const ProposedDeltaSchema = z.object({
  kind: z.enum(["hypothesis", "suggestion"]),
  summary: z.string(),
  rationale: z.string().default("")
});
export type ProposedDelta = z.infer<typeof ProposedDeltaSchema>;

export const WorldMemberOutputSchema = z.object({
  verdict: VerdictSchema,
  validPremises: stringList,
  invalidPremises: stringList,
  blockingConflicts: stringList,
  externalPressures: stringList,
  offscreenEvents: stringList,
  informationFlow: stringList,
  resourceAndInstitutionConstraints: stringList,
  alternativeBeats: stringList,
  proposedWorldDelta: z.array(ProposedDeltaSchema).default([]),
  uncertainties: stringList
});
export type WorldMemberOutput = z.infer<typeof WorldMemberOutputSchema>;

export const CharacterFindingSchema = z.object({
  name: z.string().min(1),
  canonFacts: stringList,
  inferredMotives: stringList,
  hypothesizedHistory: stringList,
  knowledgeBoundary: stringList,
  likelyPerception: stringList,
  likelyActions: stringList,
  unlikelyActions: stringList,
  emotionalProgression: stringList,
  relationshipEffects: stringList,
  conditionsForChange: stringList,
  uncertainties: stringList
});
export type CharacterFinding = z.infer<typeof CharacterFindingSchema>;

export const CharacterMemberOutputSchema = z.object({
  verdict: VerdictSchema,
  characterFindings: z.array(CharacterFindingSchema).default([]),
  interactionConflicts: stringList,
  alternativeBeats: stringList,
  proposedCharacterDelta: z.array(ProposedDeltaSchema).default([])
});
export type CharacterMemberOutput = z.infer<typeof CharacterMemberOutputSchema>;

export const MemberOutputSchema = z.union([WorldMemberOutputSchema, CharacterMemberOutputSchema]);
export type MemberOutput = WorldMemberOutput | CharacterMemberOutput;

export const MemberStatusSchema = z.enum(["ok", "failed", "repaired"]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

export const MemberReportSchema = z.object({
  reportId: z.string().min(1),
  runId: z.string().min(1),
  councilId: z.string().min(1),
  memberId: z.string().min(1),
  status: MemberStatusSchema,
  latencyMs: z.number().int().min(0),
  attempts: z.number().int().min(0),
  error: CoreErrorJsonSchema.nullable().default(null),
  output: z.union([WorldMemberOutputSchema, CharacterMemberOutputSchema]).nullable().default(null)
});
export type MemberReport = z.infer<typeof MemberReportSchema>;

/** 组级结果（内部 + SimulateResult.councilResults；不改 FinalCouncilReport 契约，D22）。 */
export const CouncilResultSchema = z.object({
  councilId: z.string().min(1),
  status: z.enum(["ok", "insufficient"])
});
export type CouncilResult = z.infer<typeof CouncilResultSchema>;
