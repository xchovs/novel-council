import { describe, expect, it, vi } from "vitest";
import { DEEP_MODE_UNSUPPORTED_MESSAGE } from "../src/core/orchestrator/execution-modes.js";

import { simulateScene, type SimulateInput } from "../src/core/orchestrator/simulate-scene.js";
import {
  multiConfig,
  validCharacterOutput,
  validConfig,
  validPacket,
  validWorldOutput
} from "./helpers/fixtures.js";

/**
 * C4 执行模式集成测试（A31/A32，D24/D26）。
 * 全部使用 MockProvider / mock fetchImpl（D6），禁止真实网络。
 * 文案常量经 import 引用（单一定义点），不复制字面量。
 */

const WORLD_JSON = JSON.stringify(validWorldOutput());
const CHARACTER_JSON = JSON.stringify(validCharacterOutput());

const ROLE_PROMPTS = {
  "world-causality": "你是世界运行评议者。",
  "character-psychology": "你是人物心理评议者。"
};

function makeInput(overrides?: {
  options?: unknown;
  worldMember?: Record<string, unknown>;
  characterMember?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): SimulateInput {
  return {
    packet: validPacket(),
    config: validConfig({
      worldMember: { mockResponses: [WORLD_JSON], ...(overrides?.worldMember ?? {}) },
      characterMember: { mockResponses: [CHARACTER_JSON], ...(overrides?.characterMember ?? {}) },
      budget: overrides?.budget
    }),
    rolePrompts: ROLE_PROMPTS,
    env: overrides?.env ?? {},
    ...(overrides?.options !== undefined ? { options: overrides.options } : {}),
    ...(overrides?.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {})
  };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("执行模式解析与运行（A31，C4）", () => {
  it("M01：缺省 options → quick；councilReports 恒空（D25）", async () => {
    const result = await simulateScene(makeInput());
    expect(result.ok).toBe(true);
    expect(result.report?.mode).toBe("quick");
    expect(result.councilReports).toEqual([]);
  });

  it("M02：显式 mode=quick → 与缺省一致", async () => {
    const result = await simulateScene(makeInput({ options: { mode: "quick" } }));
    expect(result.ok).toBe(true);
    expect(result.report?.mode).toBe("quick");
    expect(result.councilReports).toEqual([]);
  });

  it("M03：standard 生效——report.mode=standard，未配置主持 → 每组规则回退 CouncilReport 且不告警（A34/D31）", async () => {
    const result = await simulateScene(makeInput({ options: { mode: "standard" } }));
    expect(result.ok).toBe(true);
    expect(result.report?.mode).toBe("standard");
    expect(result.report?.stats.totalCalls).toBe(2); // 无主持配置：与 quick 第一轮一致
    expect(result.report?.degraded).toBe(false);
    // 未配置主持的规则回退：每组一条 CouncilReport，fallbackUsed=true、moderatorMemberId=""
    expect(result.councilReports).toHaveLength(2);
    for (const cr of result.councilReports) {
      expect(cr.fallbackUsed).toBe(true);
      expect(cr.moderatorMemberId).toBe("");
      expect(cr.sourceMemberIds).toHaveLength(1);
    }
    // 未配置主持不告警（A34）；covers-min 不告警（默认夹具 min=2 ≤ 预算 4）
    expect(result.warnings.some((w) => w.includes("主持"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("预估不足"))).toBe(false);
  });


  it("M04：deep → CONFIG_INVALID（D24），零调用，不静默降级", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await simulateScene(
      makeInput({
        options: { mode: "deep" },
        worldMember: { provider: "openai-compatible", baseUrlEnv: "W_BASE", apiKeyEnv: "W_KEY" },
        characterMember: { provider: "openai-compatible", baseUrlEnv: "C_BASE", apiKeyEnv: "C_KEY" },
        env: {
          W_BASE: "https://w.example.com/v1",
          W_KEY: "FAKE-KEY-deep-w",
          C_BASE: "https://c.example.com/v1",
          C_KEY: "FAKE-KEY-deep-c"
        },
        fetchImpl
      })
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONFIG_INVALID");
    expect(result.error?.message).toBe(DEEP_MODE_UNSUPPORTED_MESSAGE);
    expect(result.error?.message).toContain("阶段 3");
    expect(result.memberReports).toHaveLength(0);
    expect(result.report).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // deep 在预估与执行之前拒绝：无任何 warning
    expect(result.warnings).toEqual([]);
  });

  it("M05：非法 mode（bogus）→ CONFIG_INVALID（契约 schema 层）", async () => {
    const result = await simulateScene(makeInput({ options: { mode: "bogus" } }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONFIG_INVALID");
    expect(result.error?.message).toContain("SimulateOptions 校验失败");
  });
});

describe("预算预估告警（A32，C4）", () => {
  it("M06：minCalls > maxTotalCalls → warning 不拒绝、不隐式改预算（3 成员预算 2）", async () => {
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "w1", mockResponses: [WORLD_JSON] },
          { id: "w2", mockResponses: [WORLD_JSON] }
        ],
        character: [{ id: "c1", mockResponses: [CHARACTER_JSON] }],
        budget: { maxTotalCalls: 2 }
      }),
      rolePrompts: ROLE_PROMPTS,
      env: {}
    });
    // 不拒绝：运行继续，world 组两成员成功
    expect(result.ok).toBe(true);
    // below-min 告警存在且含关键数字
    const budgetWarning = result.warnings.find((w) => w.includes("预估不足"));
    expect(budgetWarning).toBeDefined();
    expect(budgetWarning).toContain("计划最小调用 3 次");
    expect(budgetWarning).toContain("maxTotalCalls=2");
    // 预算未被隐式修改：硬顶 2 生效，第三人被既有闸截断
    expect(result.report?.stats.totalCalls).toBe(2);
    expect(result.report?.stats.budgetExceeded).toBe(true);
    const c1 = result.memberReports.find((m) => m.memberId === "c1");
    expect(c1?.status).toBe("failed");
    expect(c1?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(c1?.attempts).toBe(0);
    // quick 模式不产生 CouncilReport（D25）
    expect(result.councilReports).toEqual([]);
  });


  it("M08：below-min 配置 + deep → 仅 CONFIG_INVALID，预估不执行、无预算 warning", async () => {
    const result = await simulateScene({
      packet: validPacket(),
      options: { mode: "deep" },
      config: multiConfig({
        world: [
          { id: "w1", mockResponses: [WORLD_JSON] },
          { id: "w2", mockResponses: [WORLD_JSON] }
        ],
        character: [{ id: "c1", mockResponses: [CHARACTER_JSON] }],
        budget: { maxTotalCalls: 2 }
      }),
      rolePrompts: ROLE_PROMPTS,
      env: {}
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONFIG_INVALID");
    expect(result.warnings).toEqual([]);
    expect(result.memberReports).toHaveLength(0);
  });
});

describe("standard 与 quick 的第一轮等价性（C4 边界）", () => {
  it("M07：输入隔离与结果排序一致；仅 mode 与 warning 不同", async () => {
    const env = {
      W_BASE: "https://w.example.com/v1",
      W_KEY: "FAKE-KEY-mode-w",
      C_BASE: "https://c.example.com/v1",
      C_KEY: "FAKE-KEY-mode-c"
    };
    const config = multiConfig({
      world: [{ id: "w1", provider: "openai-compatible", model: "m-w", baseUrlEnv: "W_BASE", apiKeyEnv: "W_KEY" }],
      character: [
        { id: "c1", provider: "openai-compatible", model: "m-c", baseUrlEnv: "C_BASE", apiKeyEnv: "C_KEY" }
      ]
    });
    const rolePrompts = { "world:w1": "ROLE-W1-ONLY", "character:c1": "ROLE-C1-ONLY" };
    const makeFetch = (recorder: Array<{ model: string; body: string }>) =>
      vi.fn<typeof fetch>(async (_url, init) => {
        const body = String(init?.body);
        const model = (JSON.parse(body) as { model?: string }).model ?? "";
        recorder.push({ model, body });
        return jsonResponse(model === "m-w" ? WORLD_JSON : CHARACTER_JSON);
      });

    const quickRec: Array<{ model: string; body: string }> = [];
    const quick = await simulateScene({
      packet: validPacket(),
      config,
      options: { mode: "quick" },
      rolePrompts,
      env,
      fetchImpl: makeFetch(quickRec)
    });
    const standardRec: Array<{ model: string; body: string }> = [];
    const standard = await simulateScene({
      packet: validPacket(),
      config,
      options: { mode: "standard" },
      rolePrompts,
      env,
      fetchImpl: makeFetch(standardRec)
    });

    expect(quick.ok).toBe(true);
    expect(standard.ok).toBe(true);
    expect(standard.report?.mode).toBe("standard");

    // 第一轮输入隔离（standard 同样成立）：各自只含自己的 rolePrompt 哨兵 + 公共 packet
    const byModel = new Map(standardRec.map((r) => [r.model, r.body]));
    expect(byModel.get("m-w")).toContain("ROLE-W1-ONLY");
    expect(byModel.get("m-w")).not.toContain("ROLE-C1-ONLY");
    expect(byModel.get("m-c")).toContain("ROLE-C1-ONLY");
    expect(byModel.get("m-c")).not.toContain("ROLE-W1-ONLY");
    expect(byModel.get("m-w")).toContain("ch01-scene01");

    // 结果确定性：成员元组序列与 findings 完全一致（剔除 runId/mode/warning 差异）
    const tuples = (r: typeof quick) =>
      r.memberReports.map((m) => [m.councilId, m.memberId, m.status, m.attempts] as const);
    expect(tuples(standard)).toEqual(tuples(quick));
    expect(standard.report?.worldFindings).toEqual(quick.report?.worldFindings);
    expect(standard.report?.characterFindings).toEqual(quick.report?.characterFindings);
    expect(standard.report?.stats.totalCalls).toBe(quick.report?.stats.totalCalls);
  });
});
