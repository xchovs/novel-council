import { describe, expect, it } from "vitest";
import {
  CharacterMemberOutputSchema,
  CoreError,
  CoreErrorJsonSchema,
  CouncilConfigSchema,
  ErrorCodeSchema,
  FinalCouncilReportSchema,
  ProposedDeltaSchema,
  ScenePacketSchema,
  SimulateOptionsSchema,
  WorldMemberOutputSchema
} from "../src/contracts/index.js";
import { validCharacterOutput, validConfig, validPacket, validWorldOutput } from "./helpers/fixtures.js";

describe("ScenePacketSchema", () => {
  it("接受合法 packet 并填充默认值", () => {
    const parsed = ScenePacketSchema.parse(validPacket());
    expect(parsed.sceneId).toBe("ch01-scene01");
    expect(parsed.provisional).toBe(true);
  });

  it("缺少必填 sceneId 时拒绝", () => {
    const raw = validPacket() as unknown as Record<string, unknown>;
    delete raw["sceneId"];
    expect(() => ScenePacketSchema.parse(raw)).toThrow();
  });

  it("provisional 缺失或为 false 时拒绝（规划 §4.2）", () => {
    const raw = validPacket() as unknown as Record<string, unknown>;
    delete raw["provisional"];
    expect(() => ScenePacketSchema.parse(raw)).toThrow();
    expect(() => ScenePacketSchema.parse({ ...validPacket(), provisional: false })).toThrow();
  });

  it("未知键在 strict 模式下给出清晰错误（§0）", () => {
    expect(() => ScenePacketSchema.parse({ ...validPacket(), typoField: 1 })).toThrow();
  });

  it("schemaVersion 非 1.0 时拒绝", () => {
    expect(() => ScenePacketSchema.parse({ ...validPacket(), schemaVersion: "2.0" })).toThrow();
  });
});

describe("CouncilConfigSchema", () => {
  it("接受合法配置并填充 limits/budget 默认值", () => {
    const raw = validConfig();
    delete raw["limits"];
    delete raw["budget"];
    const parsed = CouncilConfigSchema.parse(raw);
    expect(parsed.limits.maxInputChars).toBe(50000);
    expect(parsed.limits.maxReportChars).toBe(20000);
    expect(parsed.budget.maxTotalCalls).toBe(4);
    expect(parsed.budget.maxRetriesPerCall).toBe(1);
    expect(parsed.budget.maxTransportRetries).toBe(1);
    expect(parsed.budget.concurrency).toBe(2);
  });

  it("maxTransportRetries 取值 0–3，越界拒绝（D27 硬上限）", () => {
    expect(CouncilConfigSchema.parse(validConfig({ budget: { maxTransportRetries: 3 } })).budget.maxTransportRetries).toBe(3);
    expect(CouncilConfigSchema.parse(validConfig({ budget: { maxTransportRetries: 0 } })).budget.maxTransportRetries).toBe(0);
    expect(() => CouncilConfigSchema.parse(validConfig({ budget: { maxTransportRetries: 4 } }))).toThrow();
    expect(() => CouncilConfigSchema.parse(validConfig({ budget: { maxTransportRetries: -1 } }))).toThrow();
  });

  it("A22：generationParams 含保留字段时拒绝（D17）", () => {
    for (const key of ["model", "messages", "stream", "tools", "tool_choice"]) {
      const raw = validConfig({ worldMember: { generationParams: { [key]: 1 } } });
      expect(() => CouncilConfigSchema.parse(raw), `reserved key: ${key}`).toThrow();
    }
  });

  it("generationParams 允许非保留字段", () => {
    const parsed = CouncilConfigSchema.parse(validConfig({ worldMember: { generationParams: { top_p: 0.9 } } }));
    expect(parsed.councils[0]?.members[0]?.generationParams["top_p"]).toBe(0.9);
  });

  it("openai-compatible 成员缺少 apiKeyEnv/baseUrlEnv 时拒绝", () => {
    expect(() =>
      CouncilConfigSchema.parse(validConfig({ worldMember: { provider: "openai-compatible" } }))
    ).toThrow();
    expect(() =>
      CouncilConfigSchema.parse(
        validConfig({ worldMember: { provider: "openai-compatible", apiKeyEnv: "K", baseUrlEnv: "B" } })
      )
    ).not.toThrow();
  });

  it("mock 成员不需要 baseUrlEnv/apiKeyEnv（D16）", () => {
    expect(() => CouncilConfigSchema.parse(validConfig())).not.toThrow();
  });

  it("extraHeadersEnv 接受 Header 名 → 环境变量名映射（D18）", () => {
    const parsed = CouncilConfigSchema.parse(
      validConfig({ worldMember: { extraHeadersEnv: { "X-API-Key": "CUSTOM_API_KEY" } } })
    );
    expect(parsed.councils[0]?.members[0]?.extraHeadersEnv["X-API-Key"]).toBe("CUSTOM_API_KEY");
  });
});

describe("成员输出 schema", () => {
  it("WorldMemberOutput 仅含 verdict 时以默认值通过", () => {
    const parsed = WorldMemberOutputSchema.parse({ verdict: "accept" });
    expect(parsed.invalidPremises).toEqual([]);
  });

  it("CharacterMemberOutput 解析并剥离未知键", () => {
    const parsed = CharacterMemberOutputSchema.parse({ ...validCharacterOutput(), extraKey: "x" });
    expect("extraKey" in parsed).toBe(false);
  });

  it("A12：proposedDelta.kind 取 canon/fact/confirmed 时拒绝（C4）", () => {
    for (const kind of ["canon", "fact", "confirmed"]) {
      expect(() => ProposedDeltaSchema.parse({ kind, summary: "x" }), `kind: ${kind}`).toThrow();
    }
    expect(() => ProposedDeltaSchema.parse({ kind: "hypothesis", summary: "x" })).not.toThrow();
    expect(() => ProposedDeltaSchema.parse({ kind: "suggestion", summary: "x" })).not.toThrow();
  });

  it("成员输出中 proposedDelta 事实化取值导致整体校验失败", () => {
    const raw = { ...validWorldOutput(), proposedWorldDelta: [{ kind: "canon", summary: "x" }] };
    expect(() => WorldMemberOutputSchema.parse(raw)).toThrow();
  });
});

describe("FinalCouncilReportSchema", () => {
  it("合法报告通过校验", () => {
    const report = {
      schemaVersion: "1.0",
      runId: "r1",
      sceneId: "ch01-scene01",
      generatedAt: new Date().toISOString(),
      mode: "quick",
      degraded: false,
      overallVerdict: "revise",
      planStrengths: [],
      worldFindings: [
        { topic: "blocking-conflict", detail: "x", severity: "blocking", sourceMemberIds: ["world-causality"] }
      ],
      characterFindings: [],
      alternativePlans: [],
      uncertainHypotheses: [],
      proposedDeltas: [],
      questionsForMainModel: [],
      rawRefs: [{ reportId: "r1:world:world-causality", councilId: "world", memberId: "world-causality", status: "ok" }],
      stats: { totalCalls: 2, succeeded: 2, failed: 0, repaired: 0, durationMs: 10, budgetExceeded: false },
      truncation: { applied: false, droppedSections: [] }
    };
    expect(() => FinalCouncilReportSchema.parse(report)).not.toThrow();
  });

  it("C4：mode 接受 quick|standard，拒绝 deep（D24：deep 不产生报告）", () => {
    const base = {
      schemaVersion: "1.0",
      runId: "r1",
      sceneId: "ch01-scene01",
      generatedAt: new Date().toISOString(),
      degraded: false,
      overallVerdict: "accept",
      rawRefs: [],
      stats: { totalCalls: 0, succeeded: 0, failed: 0, repaired: 0, durationMs: 0, budgetExceeded: false },
      truncation: { applied: false, droppedSections: [] }
    };
    expect(() => FinalCouncilReportSchema.parse({ ...base, mode: "quick" })).not.toThrow();
    expect(() => FinalCouncilReportSchema.parse({ ...base, mode: "standard" })).not.toThrow();
    expect(() => FinalCouncilReportSchema.parse({ ...base, mode: "deep" })).toThrow();
  });
});

describe("SimulateOptionsSchema", () => {
  it("缺省为 quick", () => {
    expect(SimulateOptionsSchema.parse(undefined).mode).toBe("quick");
    expect(SimulateOptionsSchema.parse({}).mode).toBe("quick");
  });

  it("C4：接受 quick/standard/deep 三值（D24 契约前向稳定）", () => {
    for (const mode of ["quick", "standard", "deep"] as const) {
      expect(SimulateOptionsSchema.parse({ mode }).mode).toBe(mode);
    }
  });

  it("C4：拒绝非法 mode 与未知键（strictObject）", () => {
    for (const bad of ["turbo", "", 1, null]) {
      expect(() => SimulateOptionsSchema.parse({ mode: bad })).toThrow();
    }
    expect(() => SimulateOptionsSchema.parse({ mode: "quick", extra: 1 })).toThrow();
  });
});

describe("CoreError 契约（D27）", () => {
  it("PROVIDER_NETWORK_ERROR 在错误码枚举内", () => {
    expect(ErrorCodeSchema.safeParse("PROVIDER_NETWORK_ERROR").success).toBe(true);
  });

  it("toJSON 携带 httpStatus，CoreErrorJsonSchema round-trip 完整保留", () => {
    const err = new CoreError("PROVIDER_HTTP_ERROR", "HTTP 503：upstream", {
      memberId: "m1",
      councilId: "world",
      httpStatus: 503
    });
    const parsed = CoreErrorJsonSchema.parse(err.toJSON());
    expect(parsed).toEqual({
      code: "PROVIDER_HTTP_ERROR",
      message: "HTTP 503：upstream",
      memberId: "m1",
      councilId: "world",
      httpStatus: 503
    });
  });

  it("无 httpStatus 时 toJSON 不含该键，schema 仍通过", () => {
    const json = new CoreError("PROVIDER_NETWORK_ERROR", "网络错误：fetch failed").toJSON();
    expect("httpStatus" in json).toBe(false);
    expect(() => CoreErrorJsonSchema.parse(json)).not.toThrow();
  });

  it("httpStatus 非整数或越界（99 / 600 / 1.5）被 schema 拒绝", () => {
    for (const bad of [99, 600, 1.5]) {
      expect(() =>
        CoreErrorJsonSchema.parse({ code: "PROVIDER_HTTP_ERROR", message: "x", httpStatus: bad })
      ).toThrow();
    }
  });
});
