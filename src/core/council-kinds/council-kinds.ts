import {
  CharacterMemberOutputSchema,
  WorldMemberOutputSchema,
  type MemberOutput
} from "../../contracts/index.js";
import type { z } from "zod";

/**
 * core/council-kinds：councilId → 评议组种类 的显式注册表（D23 / C14）。
 * 阶段 2 仅注册 world / character；未知 council id 由调用方显式拒绝
 * （CONFIG_INVALID），禁止静默按 character 处理。
 * 注册表只组装 contracts 中已有的 schema 与类型，不重复定义契约。
 */

/** FinalCouncilReport 中该组 findings 的归属桶。 */
export type CouncilReportBucket = "worldFindings" | "characterFindings";

export interface CouncilKind {
  /** 成员输出 zod schema（council-runner 校验用）。 */
  outputSchema: z.ZodType<MemberOutput>;
  /** 成员提示词中的输出结构说明（prompt-build 用）。 */
  outputShape: string;
  /** FinalCouncilReport 的 findings 归属桶（report-merger 用）。 */
  reportBucket: CouncilReportBucket;
}

const WORLD_OUTPUT_SHAPE = `输出 JSON 结构（所有数组字段可空）：
{
  "verdict": "accept | revise | reject",
  "validPremises": [], "invalidPremises": [], "blockingConflicts": [],
  "externalPressures": [], "offscreenEvents": [], "informationFlow": [],
  "resourceAndInstitutionConstraints": [], "alternativeBeats": [],
  "proposedWorldDelta": [{ "kind": "hypothesis | suggestion", "summary": "...", "rationale": "..." }],
  "uncertainties": []
}`;

const CHARACTER_OUTPUT_SHAPE = `输出 JSON 结构（所有数组字段可空）：
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
  "interactionConflicts": [], "alternativeBeats": [],
  "proposedCharacterDelta": [{ "kind": "hypothesis | suggestion", "summary": "...", "rationale": "..." }]
}`;

const KINDS: Readonly<Record<string, CouncilKind>> = {
  world: {
    outputSchema: WorldMemberOutputSchema,
    outputShape: WORLD_OUTPUT_SHAPE,
    reportBucket: "worldFindings"
  },
  character: {
    outputSchema: CharacterMemberOutputSchema,
    outputShape: CHARACTER_OUTPUT_SHAPE,
    reportBucket: "characterFindings"
  }
};

/** 已注册的 council id 列表（阶段 2：world / character）。 */
export function knownCouncilIds(): string[] {
  return Object.keys(KINDS);
}

/** 按 councilId 解析评议组种类；未注册返回 undefined（调用方负责显式报错）。 */
export function getCouncilKind(councilId: string): CouncilKind | undefined {
  return Object.hasOwn(KINDS, councilId) ? KINDS[councilId] : undefined;
}
