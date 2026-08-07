import { describe, expect, it } from "vitest";
import { CouncilConfigSchema, type ProgressEvent } from "../src/contracts/index.js";
import {
  moderatorFailedWarning,
  moderatorSkippedQuickWarning
} from "../src/core/orchestrator/execution-modes.js";
import { simulateScene, type SimulateInput } from "../src/core/orchestrator/simulate-scene.js";
import { multiConfig, validCharacterOutput, validPacket, validWorldOutput } from "./helpers/fixtures.js";

/**
 * C5 组内主持集成测试（A06/A33/A34，D25/D31）。
 * 全部使用 MockProvider（D6），禁止真实网络。
 * 文案经 import 引用构造函数产出（单一定义点），不复制字面量。
 */

const WORLD_JSON = JSON.stringify(validWorldOutput());
const CHARACTER_JSON = JSON.stringify(validCharacterOutput());

/** 主持输出夹具（含少数意见与证据强弱，A33）。 */
function moderatorOutputJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    verdict: "revise",
    summary: "两成员一致认为码头管控是核心约束，对坦白时机存在分歧。",
    consensus: ["码头管控期间闲谈会被打断"],
    disagreements: ["旧友是否会在初见时提及债务"],
    minorityOpinions: ["少数意见：beat-2 可保留但需前置铺垫"],
    evidenceStrength: ["管控约束：强（两成员一致）", "坦白时机：弱（单方推测）"],
    questionsForMainModel: ["商会管控的具体起止时间未知"],
    ...overrides
  });
}

const ROLE_PROMPTS = {
  "world:w1": "ROLE-W1",
  "world:w2": "ROLE-W2",
  "character:c1": "ROLE-C1",
  "world:moderator": "ROLE-WORLD-MODERATOR",
  "character:moderator": "ROLE-CHAR-MODERATOR"
};

/** 双组各 2 成员 + 双组内联 mock 主持（mock 回复经 mockResponses 注入）。 */
function moderatorConfig(opts?: {
  worldModerator?: Record<string, unknown>;
  characterModerator?: Record<string, unknown>;
  worldMember2?: Record<string, unknown>;
  budget?: Record<string, unknown>;
}): Record<string, unknown> {
  const raw = multiConfig({
    world: [
      { id: "w1", mockResponses: [WORLD_JSON] },
      { id: "w2", mockResponses: [WORLD_JSON], ...(opts?.worldMember2 ?? {}) }
    ],
    character: [
      { id: "c1", mockResponses: [CHARACTER_JSON] },
      { id: "c2", mockResponses: [CHARACTER_JSON] }
    ],
    budget: opts?.budget
  });
  const councils = raw["councils"] as Array<Record<string, unknown>>;
  councils[0]!["moderator"] = {
    rolePromptPath: "prompts/world-moderator.md",
    provider: "mock",
    mockResponses: [moderatorOutputJson()],
    ...(opts?.worldModerator ?? {})
  };
  councils[1]!["moderator"] = {
    rolePromptPath: "prompts/character-moderator.md",
    provider: "mock",
    mockResponses: [moderatorOutputJson()],
    ...(opts?.characterModerator ?? {})
  };
  return raw;
}

function makeInput(config: Record<string, unknown>, opts?: { mode?: "quick" | "standard" }): SimulateInput {
  return {
    packet: validPacket(),
    config,
    options: { mode: opts?.mode ?? "standard" },
    rolePrompts: ROLE_PROMPTS,
    env: {}
  };
}

describe("A33：standard 主持成功", () => {
  it("双组主持成功：CouncilReport 含 consensus/disagreements/minorityOpinions，少数意见保留，主持调用计入预算", async () => {
    const result = await simulateScene(makeInput(moderatorConfig()));
    expect(result.ok).toBe(true);
    expect(result.councilReports).toHaveLength(2);
    for (const cr of result.councilReports) {
      expect(cr.fallbackUsed).toBe(false);
      expect(cr.moderatorMemberId).toBe("moderator");
      expect(cr.consensus).toContain("码头管控期间闲谈会被打断");
      expect(cr.disagreements.length).toBeGreaterThan(0);
      // 少数意见保留（不以多数一致自动视为正确，规划 §9.3）
      expect(cr.minorityOpinions).toContain("少数意见：beat-2 可保留但需前置铺垫");
      expect(cr.evidenceStrength.length).toBe(2);
      expect(cr.sourceMemberIds).toHaveLength(2);
    }
    // 主持调用计入预算与统计：4 成员 + 2 主持 = 6
    expect(result.report?.stats.totalCalls).toBe(6);
    expect(result.report?.degraded).toBe(false);
    // 无主持失败 warning
    expect(result.warnings.some((w) => w.includes("主持"))).toBe(false);
    // FinalCouncilReport 仍由规则 merger 生成（C16：主持不介入最终报告）
    expect(result.report?.worldFindings.length).toBeGreaterThan(0);
  });

  it("useMember 主持：moderatorMemberId=被复用成员 id；复用连接配置但不复用成员 rolePrompt", async () => {
    const raw = multiConfig({
      world: [
        { id: "w1", mockResponses: [WORLD_JSON, moderatorOutputJson()] }, // 成员首轮 + 主持复用同脚本续流
        { id: "w2", mockResponses: [WORLD_JSON] }
      ],
      character: [
        { id: "c1", mockResponses: [CHARACTER_JSON] },
        { id: "c2", mockResponses: [CHARACTER_JSON] }
      ]
    });
    (raw["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/world-moderator.md",
      useMember: "w1"
    };
    const result = await simulateScene(makeInput(raw));
    expect(result.ok).toBe(true);
    const world = result.councilReports.find((c) => c.councilId === "world");
    expect(world?.fallbackUsed).toBe(false);
    expect(world?.moderatorMemberId).toBe("w1"); // useMember：被复用成员 id（D31 修订 1）
    // character 组未配置主持 → 规则回退不告警
    const character = result.councilReports.find((c) => c.councilId === "character");
    expect(character?.fallbackUsed).toBe(true);
    expect(character?.moderatorMemberId).toBe("");
    expect(result.warnings.some((w) => w.includes("主持"))).toBe(false);
  });
});

describe("A06：主持失败不丢成员结果，确定性回退", () => {
  it("主持返回坏 JSON 且修复失败 → fallbackUsed=true、保留 moderatorMemberId、成员报告原样、degraded、warning 含脱敏 code", async () => {
    const result = await simulateScene(
      makeInput(moderatorConfig({ worldModerator: { mockResponses: ["垃圾", "还是垃圾"] } }))
    );
    expect(result.ok).toBe(true);
    const world = result.councilReports.find((c) => c.councilId === "world");
    expect(world?.fallbackUsed).toBe(true);
    // D31 修订 1：已尝试主持的失败回退保留主持身份（内联 → "moderator"）
    expect(world?.moderatorMemberId).toBe("moderator");
    expect(world?.sourceMemberIds).toEqual(["w1", "w2"]);
    // 原始成员报告完整保留（A06）
    expect(result.memberReports.filter((m) => m.councilId === "world" && m.status === "ok")).toHaveLength(2);
    // 失败 warning（单一定义点模板：组 id + 脱敏 code + 回退说明）+ degraded（D31：配置了但失败才置位）
    const w = result.warnings.find((x) => x.includes("评议组 world 主持调用失败"));
    expect(w).toBeDefined();
    expect(w).toContain("（REPAIR_FAILED）：");
    expect(w).toContain("；已回退规则化汇总（fallbackUsed=true），原始成员报告完整保留（A06）");
    // 模板与 moderatorFailedWarning 构造函数逐字一致（单一定义点回归守护）
    const detail = (w ?? "").match(/主持调用失败（REPAIR_FAILED）：(.*)；已回退规则化汇总/)?.[1] ?? "<none>";
    expect(w).toBe(moderatorFailedWarning("world", "REPAIR_FAILED", detail));


    expect(result.report?.degraded).toBe(true);
    // character 组主持成功不受影响
    expect(result.councilReports.find((c) => c.councilId === "character")?.fallbackUsed).toBe(false);
    // 整个运行以 degraded 状态继续完成
    expect(result.report).not.toBeNull();
  });

  it("useMember 主持失败（预算耗尽）→ fallback 保留被复用成员 id（D31 修订 1）", async () => {
    // useMember + mock：主持新建 MockProvider 实例从头消费脚本（D-L）——
    // 成员输出竟能通过主持 schema（verdict 合法、其余默认空），脚本注入无法稳定制造主持失败；
    // 改用预算闸：4 成员耗尽预算后主持 0 调用失败，确定性触发回退。
    const raw = multiConfig({
      world: [
        { id: "w1", mockResponses: [WORLD_JSON] },
        { id: "w2", mockResponses: [WORLD_JSON] }
      ],
      character: [
        { id: "c1", mockResponses: [CHARACTER_JSON] },
        { id: "c2", mockResponses: [CHARACTER_JSON] }
      ],
      budget: { maxTotalCalls: 4 }
    });
    (raw["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/world-moderator.md",
      useMember: "w1"
    };
    const result = await simulateScene(makeInput(raw));
    const world = result.councilReports.find((c) => c.councilId === "world");
    expect(world?.fallbackUsed).toBe(true);
    expect(world?.moderatorMemberId).toBe("w1"); // 已尝试的主持身份保留（非 ""）
    expect(result.warnings.some((w) => w.includes("评议组 world 主持调用失败（BUDGET_EXCEEDED）"))).toBe(true);
    expect(result.report?.degraded).toBe(true);
  });


  it("主持预算耗尽（BUDGET_EXCEEDED）→ 回退且统计中 budgetExceeded=false 不溢出（主持 0 调用）", async () => {
    // 预算恰好只够 4 个成员调用：主持在预算闸被截断，0 次主持调用
    const result = await simulateScene(makeInput(moderatorConfig({ budget: { maxTotalCalls: 4 } })));
    expect(result.ok).toBe(true);
    expect(result.report?.stats.totalCalls).toBe(4);
    expect(result.report?.stats.budgetExceeded).toBe(true);
    for (const cr of result.councilReports) {
      expect(cr.fallbackUsed).toBe(true);
      expect(cr.moderatorMemberId).toBe("moderator");
    }
    // below-min 预估 warning 文案亦含 "BUDGET_EXCEEDED" 字样，须按主持失败模板精确过滤
    expect(result.warnings.filter((w) => w.includes("主持调用失败（BUDGET_EXCEEDED）"))).toHaveLength(2);
    expect(result.report?.degraded).toBe(true);
  });

});

describe("A34：quick 跳过与 standard 未配置", () => {
  it("quick 配置 moderator → 零主持调用、每组跳过 warning、moderator-end skipped、councilReports 为空", async () => {
    const events: ProgressEvent[] = [];
    const result = await simulateScene({ ...makeInput(moderatorConfig(), { mode: "quick" }), onProgress: (e) => events.push(e) });
    expect(result.ok).toBe(true);
    // councilReports 恒空（D25）
    expect(result.councilReports).toEqual([]);
    // 每组一条跳过 warning（常量构造函数单一定义点）
    expect(result.warnings).toContain(moderatorSkippedQuickWarning("world"));
    expect(result.warnings).toContain(moderatorSkippedQuickWarning("character"));
    // 零主持调用：totalCalls 仅含 4 个成员首轮
    expect(result.report?.stats.totalCalls).toBe(4);
    // moderator-end skipped × 2
    const modEnds = events.filter((e) => e.type === "moderator-end");
    expect(modEnds).toHaveLength(2);
    expect(modEnds.every((e) => e.type === "moderator-end" && e.status === "skipped")).toBe(true);
  });

  it("standard 未配置 moderator → 规则回退不告警（A34）", async () => {
    const raw = multiConfig({
      world: [
        { id: "w1", mockResponses: [WORLD_JSON] },
        { id: "w2", mockResponses: [WORLD_JSON] }
      ],
      character: [
        { id: "c1", mockResponses: [CHARACTER_JSON] },
        { id: "c2", mockResponses: [CHARACTER_JSON] }
      ]
    });
    const result = await simulateScene(makeInput(raw));
    expect(result.ok).toBe(true);
    expect(result.councilReports).toHaveLength(2);
    for (const cr of result.councilReports) {
      expect(cr.fallbackUsed).toBe(true);
      expect(cr.moderatorMemberId).toBe("");
    }
    expect(result.warnings).toEqual([]);
    expect(result.report?.stats.totalCalls).toBe(4);
    expect(result.report?.degraded).toBe(false);
  });
});

describe("执行条件矩阵（D31）", () => {
  it("单有效成员（2 选 1 失败）→ 跳过主持调用、规则回退不告警、moderator-end skipped", async () => {
    const events: ProgressEvent[] = [];
    const result = await simulateScene({
      ...makeInput(moderatorConfig({ worldMember2: { mockResponses: ["坏", "仍坏"] } })),
      onProgress: (e) => events.push(e)
    });
    expect(result.ok).toBe(true);
    const world = result.councilReports.find((c) => c.councilId === "world");
    expect(world?.fallbackUsed).toBe(true);
    expect(world?.moderatorMemberId).toBe(""); // 跳过：无主持身份（D31 修订 1）
    expect(world?.sourceMemberIds).toEqual(["w1"]);
    // world 主持 0 调用：totalCalls = 4 成员首轮 + 1 修复（w2）+ 1 character 主持 = 6
    expect(result.report?.stats.totalCalls).toBe(6);
    const worldModEnd = events.filter((e) => e.type === "moderator-end" && e.councilId === "world");
    expect(worldModEnd).toHaveLength(1);
    expect(worldModEnd[0]?.type === "moderator-end" && worldModEnd[0].status).toBe("skipped");
    // 单成员跳过不告警
    expect(result.warnings.some((w) => w.includes("评议组 world 主持"))).toBe(false);
  });

  it("组 insufficient（minValidMembers=2 仅 1 有效）→ 不产 CouncilReport、不发射 moderator-end", async () => {
    const events: ProgressEvent[] = [];
    const raw = moderatorConfig({ worldMember2: { mockResponses: ["坏", "仍坏"] } });
    (raw["councils"] as Array<Record<string, unknown>>)[0]!["minValidMembers"] = 2;
    const result = await simulateScene({ ...makeInput(raw), onProgress: (e) => events.push(e) });
    expect(result.ok).toBe(true);
    expect(result.councilReports.some((c) => c.councilId === "world")).toBe(false);
    expect(result.councilReports.some((c) => c.councilId === "character")).toBe(true);
    expect(events.filter((e) => e.type === "moderator-end" && e.councilId === "world")).toHaveLength(0);
    expect(result.councilResults.find((c) => c.councilId === "world")?.status).toBe("insufficient");
    expect(result.report?.degraded).toBe(true); // 组 insufficient 本身置 degraded（既有口径）
  });

  it("council disabled → 无 CouncilReport、无主持调用", async () => {
    const raw = moderatorConfig();
    (raw["councils"] as Array<Record<string, unknown>>)[1]!["enabled"] = false;
    const result = await simulateScene(makeInput(raw));
    expect(result.ok).toBe(true);
    expect(result.councilReports).toHaveLength(1);
    expect(result.councilReports[0]?.councilId).toBe("world");
    expect(result.report?.stats.totalCalls).toBe(3); // 2 world 成员 + 1 主持
  });
});

describe("跨组隔离与确定性", () => {
  it("两组主持使用各自独立脚本与报告归属：world 报告含 world 主持哨兵且不含 character 哨兵", async () => {
    const raw = multiConfig({
      world: [
        { id: "w1", mockResponses: [WORLD_JSON] },
        { id: "w2", mockResponses: [WORLD_JSON] }
      ],
      character: [
        { id: "c1", mockResponses: [CHARACTER_JSON] },
        { id: "c2", mockResponses: [CHARACTER_JSON] }
      ]
    });
    const councils = raw["councils"] as Array<Record<string, unknown>>;
    councils[0]!["moderator"] = {
      rolePromptPath: "prompts/world-moderator.md",
      provider: "mock",
      mockResponses: [moderatorOutputJson({ summary: "W-MOD-SENTINEL", consensus: ["W-CONSENSUS-SENTINEL"] })]
    };
    councils[1]!["moderator"] = {
      rolePromptPath: "prompts/character-moderator.md",
      provider: "mock",
      mockResponses: [moderatorOutputJson({ summary: "C-MOD-SENTINEL", consensus: ["C-CONSENSUS-SENTINEL"] })]
    };
    const result = await simulateScene(makeInput(raw));
    expect(result.ok).toBe(true);
    const world = result.councilReports.find((c) => c.councilId === "world");
    const character = result.councilReports.find((c) => c.councilId === "character");
    // 各组主持产出归入本组报告，不含他组主持产物的任何痕迹
    expect(world?.summary).toBe("W-MOD-SENTINEL");
    expect(world?.consensus).toEqual(["W-CONSENSUS-SENTINEL"]);
    expect(JSON.stringify(world)).not.toContain("C-MOD-SENTINEL");
    expect(JSON.stringify(world)).not.toContain("C-CONSENSUS-SENTINEL");
    expect(character?.summary).toBe("C-MOD-SENTINEL");
    expect(JSON.stringify(character)).not.toContain("W-MOD-SENTINEL");
    // sourceMemberIds 只含本组成员（无跨组引用通道）
    expect(world?.sourceMemberIds).toEqual(["w1", "w2"]);
    expect(character?.sourceMemberIds).toEqual(["c1", "c2"]);
  });

  it("buildModeratorMessages 内容级隔离：world 主持输入不含 character 输出，反之亦然", async () => {
    const { buildModeratorMessages } = await import("../src/core/orchestrator/prompt-build.js");
    const worldOut = validWorldOutput({ validPremises: ["WORLD-ONLY-SENTINEL"] });
    const charOut = validCharacterOutput({ interactionConflicts: ["CHAR-ONLY-SENTINEL"] });
    const packet = validPacket();
    const worldMsgs = buildModeratorMessages({
      rolePrompt: "MOD",
      packet,
      validReports: [
        { memberId: "w1", output: worldOut },
        { memberId: "w2", output: worldOut }
      ],
      failedMemberIds: []
    });
    const worldText = worldMsgs.map((m) => m.content).join("\n");
    expect(worldText).toContain("WORLD-ONLY-SENTINEL");
    expect(worldText).not.toContain("CHAR-ONLY-SENTINEL");
    const charMsgs = buildModeratorMessages({
      rolePrompt: "MOD",
      packet,
      validReports: [{ memberId: "c1", output: charOut }],
      failedMemberIds: ["c2"]
    });
    const charText = charMsgs.map((m) => m.content).join("\n");
    expect(charText).toContain("CHAR-ONLY-SENTINEL");
    expect(charText).not.toContain("WORLD-ONLY-SENTINEL");
    // 失败成员仅 id 注入
    expect(charText).toContain("c2");
  });

  it("确定性：同输入两次运行 councilReports 深度相等（与完成顺序无关）", async () => {
    const a = await simulateScene(makeInput(moderatorConfig()));
    const b = await simulateScene(makeInput(moderatorConfig()));
    expect(a.councilReports).toEqual(b.councilReports);
    // fallback 确定性同法：失败主持两次运行产物一致
    const failCfg = () => moderatorConfig({ worldModerator: { mockResponses: ["坏", "仍坏"] } });
    const fa = await simulateScene(makeInput(failCfg()));
    const fb = await simulateScene(makeInput(failCfg()));
    expect(fa.councilReports).toEqual(fb.councilReports);
  });
});


describe("moderator 配置校验（D25/D31）", () => {
  const base = (): Record<string, unknown> =>
    multiConfig({
      world: [
        { id: "w1" },
        { id: "w2" }
      ],
      character: [{ id: "c1" }]
    });

  it("useMember 与内联连接字段互斥 → CONFIG_INVALID", () => {
    const raw = base();
    (raw["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/mod.md",
      useMember: "w1",
      provider: "mock"
    };
    const r = CouncilConfigSchema.safeParse(raw);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues.map((i) => i.message).join(" ")).toContain("互斥");
  });

  it("useMember 指向不存在或未启用成员 → CONFIG_INVALID", () => {
    const missing = base();
    (missing["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/mod.md",
      useMember: "ghost"
    };
    expect(CouncilConfigSchema.safeParse(missing).success).toBe(false);

    const disabled = multiConfig({
      world: [{ id: "w1" }, { id: "w2", enabled: false }],
      character: [{ id: "c1" }]
    });
    (disabled["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/mod.md",
      useMember: "w2"
    };
    const r = CouncilConfigSchema.safeParse(disabled);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues.map((i) => i.message).join(" ")).toContain("未启用");
  });

  it("内联主持缺 provider → CONFIG_INVALID；generationParams 保留字段 → CONFIG_INVALID", () => {
    const noProvider = base();
    (noProvider["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/mod.md",
      model: "m"
    };
    expect(CouncilConfigSchema.safeParse(noProvider).success).toBe(false);

    const reserved = base();
    (reserved["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/mod.md",
      provider: "mock",
      generationParams: { stream: true }
    };
    const r = CouncilConfigSchema.safeParse(reserved);
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues.map((i) => i.message).join(" ")).toContain("stream");
  });

  it("旧配置（无 moderator 字段）零修改通过（向后兼容）", () => {
    expect(CouncilConfigSchema.safeParse(base()).success).toBe(true);
  });
});

describe("事件序列（D31）", () => {
  it("council-end 先于 moderator-end 先于 run-end；council-end 含 validMemberCount", async () => {
    const events: ProgressEvent[] = [];
    const result = await simulateScene({ ...makeInput(moderatorConfig()), onProgress: (e) => events.push(e) });
    expect(result.ok).toBe(true);
    const types = events.map((e) => e.type);
    const firstCouncilEnd = types.indexOf("council-end");
    const firstModEnd = types.indexOf("moderator-end");
    const runEnd = types.indexOf("run-end");
    expect(firstCouncilEnd).toBeGreaterThan(types.indexOf("run-start"));
    expect(firstModEnd).toBeGreaterThan(firstCouncilEnd);
    expect(runEnd).toBeGreaterThan(firstModEnd);
    const councilEnds = events.filter((e) => e.type === "council-end");
    expect(councilEnds).toHaveLength(2);
    for (const e of councilEnds) {
      expect(e.type === "council-end" && e.status).toBe("ok");
      expect(e.type === "council-end" && e.validMemberCount).toBe(2);
    }
    const modEnds = events.filter((e) => e.type === "moderator-end");
    expect(modEnds).toHaveLength(2);
    expect(modEnds.every((e) => e.type === "moderator-end" && e.status === "ok")).toBe(true);
  });
});
