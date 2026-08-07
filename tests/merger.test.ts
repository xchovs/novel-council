import { describe, expect, it } from "vitest";
import type { FinalCouncilReport, MemberReport, RunStats } from "../src/contracts/index.js";
import { deriveVerdict, mergeReports, truncateReport } from "../src/core/report-merger/merge.js";
import { validCharacterOutput, validPacket, validWorldOutput } from "./helpers/fixtures.js";

function stats(overrides?: Partial<RunStats>): RunStats {
  return { totalCalls: 2, succeeded: 2, failed: 0, repaired: 0, durationMs: 5, budgetExceeded: false, ...overrides };
}

function memberReport(overrides?: Partial<MemberReport>): MemberReport {
  return {
    reportId: "r1:world:world-causality",
    runId: "r1",
    councilId: "world",
    memberId: "world-causality",
    status: "ok",
    latencyMs: 5,
    attempts: 1,
    error: null,
    output: validWorldOutput(),
    ...overrides
  };
}

function makeMergeArgs(memberReports: MemberReport[], maxReportChars = 20000) {
  return {
    runId: "r1",
    packet: validPacket(),
    memberReports,
    councilResults: [
      { councilId: "world", status: "ok" as const },
      { councilId: "character", status: "ok" as const }
    ],
    stats: stats(),
    maxReportChars,
    now: () => new Date("2026-08-05T00:00:00Z"),
    mode: "quick" as const // C4：MergeArgs.mode 必填；本文件用例均为 quick 语义
  };
}

describe("deriveVerdict（C5）", () => {
  it("全 accept → accept", () => {
    expect(deriveVerdict(["accept", "accept"])).toBe("accept");
  });
  it("有 revise 无 reject → revise", () => {
    expect(deriveVerdict(["accept", "revise"])).toBe("revise");
  });
  it("任一 reject → reject（A07）", () => {
    expect(deriveVerdict(["accept", "reject"])).toBe("reject");
    expect(deriveVerdict(["revise", "reject"])).toBe("reject");
  });
  it("单侧直通", () => {
    expect(deriveVerdict(["revise"])).toBe("revise");
  });
});

describe("mergeReports（§6.1 规则化映射）", () => {
  it("world/character 输出映射为 findings，blocking 在前", () => {
    const report = mergeReports(
      makeMergeArgs([
        memberReport(),
        memberReport({
          reportId: "r1:character:character-psychology",
          councilId: "character",
          memberId: "character-psychology",
          output: validCharacterOutput()
        })
      ])
    );
    expect(report.overallVerdict).toBe("revise");
    expect(report.worldFindings[0]?.severity).toBe("blocking");
    expect(report.worldFindings[0]?.topic).toBe("blocking-conflict");
    expect(report.worldFindings.some((f) => f.topic === "invalid-premise" && f.severity === "warning")).toBe(true);
    expect(report.characterFindings.some((f) => f.topic === "interaction-conflict")).toBe(true);
    expect(report.characterFindings.some((f) => f.topic.startsWith("unlikely-action:"))).toBe(true);
    expect(report.planStrengths).toContain("码头傍晚有工人活动");
    expect(report.alternativePlans.map((p) => p.id)).toEqual(["A", "B"]);
    expect(report.alternativePlans[0]?.sourceMemberIds).toEqual(["world-causality"]);
    expect(report.uncertainHypotheses.some((h) => h.includes("商会管控"))).toBe(true);
    expect(report.questionsForMainModel.length).toBeGreaterThan(0);
    expect(report.proposedDeltas).toHaveLength(2);
    expect(report.degraded).toBe(false);
    expect(report.truncation.applied).toBe(false);
  });

  it("存在失败成员时 degraded=true，rawRefs 保留失败标记", () => {
    const report = mergeReports(
      makeMergeArgs([
        memberReport({ status: "failed", output: null, error: { code: "PROVIDER_TIMEOUT", message: "t" } }),
        memberReport({
          reportId: "r1:character:character-psychology",
          councilId: "character",
          memberId: "character-psychology",
          output: validCharacterOutput()
        })
      ])
    );
    expect(report.degraded).toBe(true);
    expect(report.rawRefs.find((r) => r.memberId === "world-causality")?.status).toBe("failed");
    expect(report.worldFindings).toHaveLength(0);
    expect(report.overallVerdict).toBe("revise"); // 单侧直通
  });
});

describe("truncateReport（C6 / D9 / A16）", () => {
  function bigReport(): FinalCouncilReport {
    const filler = "长".repeat(200);
    return {
      schemaVersion: "1.0",
      runId: "r1",
      sceneId: "s1",
      generatedAt: "2026-08-05T00:00:00.000Z",
      mode: "quick",
      degraded: false,
      overallVerdict: "revise",
      planStrengths: [filler, filler],
      worldFindings: [
        { topic: "blocking-conflict", detail: filler, severity: "blocking", sourceMemberIds: ["w"] },
        { topic: "invalid-premise", detail: filler, severity: "warning", sourceMemberIds: ["w"] },
        { topic: "external-pressure", detail: filler, severity: "info", sourceMemberIds: ["w"] }
      ],
      characterFindings: [],
      alternativePlans: [
        { id: "A", summary: filler, advantages: [], risks: [], requiredChanges: [], sourceMemberIds: ["w"] }
      ],
      uncertainHypotheses: [filler],
      proposedDeltas: [{ kind: "hypothesis", summary: filler, rationale: filler }],
      questionsForMainModel: [filler],
      rawRefs: [{ reportId: "r1:world:w", councilId: "world", memberId: "w", status: "ok" }],
      stats: stats(),
      truncation: { applied: false, droppedSections: [] }
    };
  }

  it("超限后按项裁剪：输出恒为有效 JSON，droppedSections 有记录，blocking 保留", () => {
    const report = bigReport();
    const full = JSON.stringify(report).length;
    const truncated = truncateReport(report, Math.floor(full / 2));
    expect(truncated.truncation.applied).toBe(true);
    expect(truncated.truncation.droppedSections.length).toBeGreaterThan(0);
    // 输出必须是有效 JSON 且不超过上限
    const serialized = JSON.stringify(truncated);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized.length).toBeLessThanOrEqual(Math.floor(full / 2));
    // 低优先级先裁：planStrengths 最先整体裁掉
    expect(truncated.planStrengths).toEqual([]);
    // blocking finding 比 info 更晚被裁
    expect(truncated.worldFindings.some((f) => f.severity === "blocking")).toBe(true);
    // 信封字段完整
    expect(truncated.runId).toBe("r1");
    expect(truncated.rawRefs).toHaveLength(1);
  });

  it("未超限时不裁剪", () => {
    const report = bigReport();
    const out = truncateReport(report, Number.MAX_SAFE_INTEGER);
    expect(out.truncation.applied).toBe(false);
    expect(out.planStrengths).toHaveLength(2);
  });
});
