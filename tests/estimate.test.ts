import { describe, expect, it } from "vitest";
import { CoreError, CouncilConfigSchema, type CouncilConfig } from "../src/contracts/index.js";
import { estimateCalls } from "../src/core/budget/estimate.js";
import { multiConfig, validConfig } from "./helpers/fixtures.js";

/**
 * estimateCalls 纯函数单元测试（C4，D26/A32）：
 * 只读已校验 config，不读 env；同输入恒同输出；
 * 单成员上限恒为 1 + maxRetriesPerCall + maxTransportRetries（C3 加法，禁止乘法嵌套）。
 */

function parse(raw: Record<string, unknown>): CouncilConfig {
  return CouncilConfigSchema.parse(raw);
}

describe("estimateCalls（C4 确定性调用数预估）", () => {
  it("E01：quick 默认夹具（2 成员，R=1，T=1，预算 4）", () => {
    const est = estimateCalls(parse(validConfig()), "quick");
    expect(est.mode).toBe("quick");
    expect(est.memberCount).toBe(2);
    expect(est.perMemberMaxCalls).toBe(3); // 1 + 1 + 1
    expect(est.minCalls).toBe(2);
    expect(est.maxCalls).toBe(6); // 2 × 3
    expect(est.breakdown).toEqual({
      baseMemberCalls: 2,
      maxRepairCalls: 2,
      maxTransportRetryCalls: 2,
      minModeratorCalls: 0,
      maxModeratorCalls: 0
    });

    expect(est.maxTotalCalls).toBe(4);
    expect(est.budgetCoverage).toBe("covers-min"); // 2 ≤ 4 < 6：计划可行但不覆盖重试上界
  });

  it("E02：standard 同配置数值与 quick 相同（未配置 moderator → 主持计数 0/0，D31）", () => {
    const config = parse(validConfig());
    const { mode: _quickMode, ...quickRest } = estimateCalls(config, "quick");
    const standard = estimateCalls(config, "standard");
    expect(standard.mode).toBe("standard");
    const { mode: _standardMode, ...standardRest } = standard;
    expect(standardRest).toEqual(quickRest);
    expect(standard.breakdown.minModeratorCalls).toBe(0);
    expect(standard.breakdown.maxModeratorCalls).toBe(0);
  });


  it("E03：deep → CONFIG_INVALID（消息指明阶段 3，与 orchestrator 同一文案，D24）", () => {
    const config = parse(validConfig());
    let caught: unknown;
    try {
      estimateCalls(config, "deep");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CoreError);
    expect((caught as CoreError).code).toBe("CONFIG_INVALID");
    expect((caught as CoreError).message).toContain("阶段 3");
  });

  it("E04：disabled council 整组不计入", () => {
    const raw = validConfig();
    (raw["councils"] as Array<Record<string, unknown>>)[0]!["enabled"] = false;
    const est = estimateCalls(parse(raw), "quick");
    expect(est.memberCount).toBe(1);
    expect(est.minCalls).toBe(1);
    expect(est.maxCalls).toBe(3);
  });

  it("E05：全部成员 disabled → memberCount=0，min=max=0", () => {
    const est = estimateCalls(
      parse(validConfig({ worldMember: { enabled: false }, characterMember: { enabled: false } })),
      "quick"
    );
    expect(est.memberCount).toBe(0);
    expect(est.minCalls).toBe(0);
    expect(est.maxCalls).toBe(0);
    expect(est.budgetCoverage).toBe("covers-max"); // 0 调用恒在预算内
  });

  it("E06：maxRetriesPerCall=0 且 maxTransportRetries=0 → 每成员恰好 1 次，min=max", () => {
    const est = estimateCalls(
      parse(validConfig({ budget: { maxRetriesPerCall: 0, maxTransportRetries: 0 } })),
      "quick"
    );
    expect(est.perMemberMaxCalls).toBe(1);
    expect(est.minCalls).toBe(2);
    expect(est.maxCalls).toBe(2);
    expect(est.breakdown.maxRepairCalls).toBe(0);
    expect(est.breakdown.maxTransportRetryCalls).toBe(0);
    expect(est.budgetCoverage).toBe("covers-max"); // 4 ≥ 2
  });

  it("E07：maxTransportRetries=3（D27 硬上限）→ perMemberMax=1+1+3=5", () => {
    const est = estimateCalls(parse(validConfig({ budget: { maxTransportRetries: 3 } })), "quick");
    expect(est.perMemberMaxCalls).toBe(5);
    expect(est.maxCalls).toBe(10);
    expect(est.breakdown.maxTransportRetryCalls).toBe(6);
  });

  it("E08：多成员（world 2 + character 2）→ memberCount=4，min=4，max=12", () => {
    const est = estimateCalls(
      parse(
        multiConfig({
          world: [{ id: "w1" }, { id: "w2" }],
          character: [{ id: "c1" }, { id: "c2" }]
        })
      ),
      "quick"
    );
    expect(est.memberCount).toBe(4);
    expect(est.minCalls).toBe(4);
    expect(est.maxCalls).toBe(12); // 4 × (1+1+1)
    expect(est.budgetCoverage).toBe("covers-max"); // 默认预算 12
  });

  it("E09：budgetCoverage 三态分界（默认夹具 min=2，max=6）", () => {
    const at = (maxTotalCalls: number) =>
      estimateCalls(parse(validConfig({ budget: { maxTotalCalls } })), "quick").budgetCoverage;
    expect(at(1)).toBe("below-min"); // 1 < 2：必然不足
    expect(at(2)).toBe("covers-min"); // == min
    expect(at(5)).toBe("covers-min"); // < max
    expect(at(6)).toBe("covers-max"); // == max
    expect(at(7)).toBe("covers-max");
  });

  it("E10：确定性——同输入两次调用深相等且非同一引用", () => {
    const config = parse(validConfig());
    const a = estimateCalls(config, "standard");
    const b = estimateCalls(config, "standard");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("E11：加法上限守护——R=2、T=1、单成员 → max=4（加法），而非乘法嵌套 6", () => {
    const est = estimateCalls(
      parse(
        validConfig({
          characterMember: { enabled: false },
          budget: { maxRetriesPerCall: 2, maxTransportRetries: 1 }
        })
      ),
      "quick"
    );
    expect(est.memberCount).toBe(1);
    expect(est.perMemberMaxCalls).toBe(4); // 1 + 2 + 1（C3 加法）
    expect(est.maxCalls).toBe(4); // 乘法嵌套 (1+2)×(1+1)=6 即为回归
    expect(est.breakdown).toEqual({
      baseMemberCalls: 1,
      maxRepairCalls: 2,
      maxTransportRetryCalls: 1,
      minModeratorCalls: 0,
      maxModeratorCalls: 0
    });
  });
});

describe("estimateCalls 主持计数条件（C5，D31 修订 2）", () => {
  /** 给 world 组注入 useMember 主持配置（指向该组首个成员）。 */
  function withWorldModerator(raw: Record<string, unknown>, useMember: string): Record<string, unknown> {
    (raw["councils"] as Array<Record<string, unknown>>)[0]!["moderator"] = {
      rolePromptPath: "prompts/world-moderator.md",
      useMember
    };
    return raw;
  }

  it("E12：enabled=1、minValidMembers=1 → 主持计数 0/0（单成员不主持）", () => {
    const raw = withWorldModerator(
      multiConfig({ world: [{ id: "w1" }], character: [{ id: "c1" }], worldMinValidMembers: 1 }),
      "w1"
    );
    const est = estimateCalls(parse(raw), "standard");
    expect(est.breakdown.minModeratorCalls).toBe(0);
    expect(est.breakdown.maxModeratorCalls).toBe(0);
    expect(est.minCalls).toBe(2); // 仅成员
  });

  it("E13：enabled=2、minValidMembers=3 → 主持计数 0/0（启用数 < minValidMembers）", () => {
    const raw = withWorldModerator(
      multiConfig({ world: [{ id: "w1" }, { id: "w2" }], character: [{ id: "c1" }], worldMinValidMembers: 3 }),
      "w1"
    );
    const est = estimateCalls(parse(raw), "standard");
    expect(est.breakdown.minModeratorCalls).toBe(0);
    expect(est.breakdown.maxModeratorCalls).toBe(0);
  });

  it("E14：enabled=3、minValidMembers=2 → 主持计数 1/(1+R+T)；quick 恒 0/0", () => {
    const raw = withWorldModerator(
      multiConfig({
        world: [{ id: "w1" }, { id: "w2" }, { id: "w3" }],
        character: [{ id: "c1" }],
        worldMinValidMembers: 2
      }),
      "w1"
    );
    const standard = estimateCalls(parse(raw), "standard");
    expect(standard.breakdown.minModeratorCalls).toBe(1);
    expect(standard.breakdown.maxModeratorCalls).toBe(3); // 1 + 1 + 1（与成员同一加法公式）
    expect(standard.minCalls).toBe(5); // 4 成员 + 1 主持
    expect(standard.maxCalls).toBe(15); // 4 × 3 + 3
    const quick = estimateCalls(parse(raw), "quick");
    expect(quick.breakdown.minModeratorCalls).toBe(0);
    expect(quick.breakdown.maxModeratorCalls).toBe(0);
  });
});


