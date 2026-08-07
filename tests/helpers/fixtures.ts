import type {
  CharacterMemberOutput,
  CouncilConfig,
  ScenePacket,
  WorldMemberOutput
} from "../../src/contracts/index.js";

/** 测试夹具：全部自动化测试只使用 MockProvider / mock fetchImpl（D6），不连真实 API。 */

export function validPacket(overrides?: Partial<ScenePacket>): ScenePacket {
  return {
    schemaVersion: "1.0",
    sceneId: "ch01-scene01",
    projectId: "demo-project",
    chapterId: "ch01",
    provisional: true,
    authorRequest: "写出主角与旧友在码头重逢的场景",
    chapterGoal: "重建两人关系并埋下债务线索",
    provisionalPlan: [
      { id: "beat-1", summary: "主角在码头偶遇旧友", required: true, reason: "作者要求重逢场景" },
      { id: "beat-2", summary: "旧友直接说出债务真相", required: false, reason: "快速推进线索" }
    ],
    timeAndPlace: { time: "傍晚", place: "南城码头", elapsedSincePreviousScene: "两天" },
    canonFacts: ["主角三年前离开南城", "旧友仍在码头帮工"],
    worldStateSummary: ["码头近期被商会管控"],
    recentEvents: ["主角回到南城一天"],
    characters: [
      {
        name: "旧友",
        identity: ["码头帮工"],
        confirmedHistory: ["曾与主角同窗"],
        currentKnowledge: ["知道主角离开"],
        misunderstandings: ["以为主角当年不辞而别是怨恨自己"],
        currentGoals: ["还清债务"],
        currentFears: ["被商会辞退"],
        physicalState: ["右手有旧伤"],
        relationshipState: ["与主角疏远"],
        knownConstraints: ["不能离开码头太久"]
      }
    ],
    authorConstraints: ["本章不出现打斗"],
    forbiddenOutcomes: ["旧友死亡"],
    openQuestions: ["债务具体数额未定"],
    sourceReferences: [{ path: "chapters/ch01.md", scope: "重逢场景相关段落" }],
    ...overrides
  };
}

export function validWorldOutput(overrides?: Partial<WorldMemberOutput>): WorldMemberOutput {
  return {
    verdict: "revise",
    validPremises: ["码头傍晚有工人活动"],
    invalidPremises: ["旧友无法随意离开岗位长谈"],
    blockingConflicts: ["商会管控期间码头闲谈会被监工打断"],
    externalPressures: ["商会正在清点货物"],
    offscreenEvents: ["监工巡逻"],
    informationFlow: ["主角回城消息尚未传到码头"],
    resourceAndInstitutionConstraints: ["帮工需登记出入"],
    alternativeBeats: ["改为收工后在茶棚交谈"],
    proposedWorldDelta: [{ kind: "hypothesis", summary: "商会管控可能加强了夜间巡逻", rationale: "管控期惯例" }],
    uncertainties: ["商会管控的具体起止时间未知"],
    ...overrides
  };
}

export function validCharacterOutput(overrides?: Partial<CharacterMemberOutput>): CharacterMemberOutput {
  return {
    verdict: "revise",
    characterFindings: [
      {
        name: "旧友",
        canonFacts: ["曾与主角同窗"],
        inferredMotives: ["想修复关系但拉不下面子"],
        hypothesizedHistory: ["可能当年替主角担过责任"],
        knowledgeBoundary: ["不知道主角回城的真正原因"],
        likelyPerception: ["初见会戒备"],
        likelyActions: ["先寒暄再试探"],
        unlikelyActions: ["一见面就坦白债务"],
        emotionalProgression: ["戒备到松动"],
        relationshipEffects: ["重逢后关系略回暖"],
        conditionsForChange: ["主角先解释当年离开的原因"],
        uncertainties: ["旧友对主角的怨气程度不确定"]
      }
    ],
    interactionConflicts: ["beat-2 让旧友直接坦白，违背其戒备状态"],
    alternativeBeats: ["债务线索改由旧友酒后失言带出"],
    proposedCharacterDelta: [{ kind: "suggestion", summary: "为旧友增加回避债务话题的习惯", rationale: "符合其戒备心理" }],
    ...overrides
  };
}

export function validConfig(overrides?: {
  worldMember?: Record<string, unknown>;
  characterMember?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  budget?: Record<string, unknown>;
}): Record<string, unknown> {
  const baseMember = {
    name: "评议者",
    provider: "mock",
    model: "mock-model",
    rolePromptPath: "prompts/role.md",
    timeoutMs: 120000,
    enabled: true
  };
  return {
    configVersion: "1.0",
    councils: [
      {
        id: "world",
        enabled: true,
        minValidMembers: 1,
        members: [{ id: "world-causality", ...baseMember, ...(overrides?.worldMember ?? {}) }]
      },
      {
        id: "character",
        enabled: true,
        minValidMembers: 1,
        members: [{ id: "character-psychology", ...baseMember, ...(overrides?.characterMember ?? {}) }]
      }
    ],
    limits: { maxInputChars: 50000, maxReportChars: 20000, ...(overrides?.limits ?? {}) },
    budget: { maxTotalCalls: 4, maxRetriesPerCall: 1, concurrency: 2, ...(overrides?.budget ?? {}) }
  };
}

export function asConfig(raw: Record<string, unknown>): CouncilConfig {
  return raw as unknown as CouncilConfig;
}

/**
 * 多成员配置构建器（阶段 2 测试，C2）。
 * world/character 条目为成员字段覆盖表（必含 id）；预算默认放宽到 12，
 * 需要演练预算闸的用例应显式传入 budget.maxTotalCalls。
 */
export function multiConfig(opts: {
  world: Array<{ id: string } & Record<string, unknown>>;
  character: Array<{ id: string } & Record<string, unknown>>;
  worldMinValidMembers?: number;
  characterMinValidMembers?: number;
  limits?: Record<string, unknown>;
  budget?: Record<string, unknown>;
}): Record<string, unknown> {
  const baseMember = {
    name: "评议者",
    provider: "mock",
    model: "mock-model",
    rolePromptPath: "prompts/role.md",
    timeoutMs: 120000,
    enabled: true
  };
  const build = (list: Array<{ id: string } & Record<string, unknown>>) =>
    list.map(({ id, ...rest }) => ({ id, ...baseMember, ...rest }));
  return {
    configVersion: "1.0",
    councils: [
      {
        id: "world",
        enabled: true,
        minValidMembers: opts.worldMinValidMembers ?? 1,
        members: build(opts.world)
      },
      {
        id: "character",
        enabled: true,
        minValidMembers: opts.characterMinValidMembers ?? 1,
        members: build(opts.character)
      }
    ],
    limits: { maxInputChars: 50000, maxReportChars: 20000, ...(opts.limits ?? {}) },
    budget: { maxTotalCalls: 12, maxRetriesPerCall: 1, concurrency: 2, ...(opts.budget ?? {}) }
  };
}
