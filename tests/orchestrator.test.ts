import { describe, expect, it, vi } from "vitest";
import type { ProgressEvent } from "../src/contracts/index.js";
import { simulateScene, type SimulateInput } from "../src/core/orchestrator/simulate-scene.js";
import {
  validCharacterOutput,
  validConfig,
  validPacket,
  validWorldOutput
} from "./helpers/fixtures.js";

/** orchestrator 集成测试：MockProvider / mock fetchImpl，禁止真实网络（D6）。 */

const WORLD_JSON = JSON.stringify(validWorldOutput());
const CHARACTER_JSON = JSON.stringify(validCharacterOutput());

const ROLE_PROMPTS = {
  "world-causality": "你是世界运行评议者。",
  "character-psychology": "你是人物心理评议者。"
};

function makeInput(overrides?: {
  worldResponses?: string[];
  characterResponses?: string[];
  worldMember?: Record<string, unknown>;
  characterMember?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  packet?: unknown;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  onProgress?: (e: ProgressEvent) => void;
}): SimulateInput {
  return {
    packet: overrides?.packet ?? validPacket(),
    config: validConfig({
      worldMember: {
        mockResponses: overrides?.worldResponses ?? [WORLD_JSON],
        ...(overrides?.worldMember ?? {})
      },
      characterMember: {
        mockResponses: overrides?.characterResponses ?? [CHARACTER_JSON],
        ...(overrides?.characterMember ?? {})
      },
      limits: overrides?.limits,
      budget: overrides?.budget
    }),
    rolePrompts: ROLE_PROMPTS,
    env: overrides?.env ?? {},
    ...(overrides?.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides?.onProgress !== undefined ? { onProgress: overrides.onProgress } : {})
  };
}

describe("simulateScene（quick，D10）", () => {
  it("A01/A14：两成员并发成功，rawRefs 与 memberReports 一一对应", async () => {
    const result = await simulateScene(makeInput());
    expect(result.ok).toBe(true);
    const report = result.report;
    expect(report).not.toBeNull();
    expect(report?.worldFindings.length).toBeGreaterThan(0);
    expect(report?.characterFindings.length).toBeGreaterThan(0);
    expect(report?.degraded).toBe(false);
    expect(report?.stats.totalCalls).toBe(2);
    expect(report?.stats.succeeded).toBe(2);
    // A14：rawRefs 可经 reportId 在 memberReports 中解析（D20）
    const byId = new Map(result.memberReports.map((m) => [m.reportId, m]));
    for (const ref of report?.rawRefs ?? []) {
      expect(byId.has(ref.reportId)).toBe(true);
    }
    expect(report?.rawRefs).toHaveLength(2);
    expect(result.councilResults).toEqual([
      { councilId: "world", status: "ok" },
      { councilId: "character", status: "ok" }
    ]);
  });

  it("并发时序：两个 150ms 延迟成员在 <280ms 内完成（Promise.allSettled 真并发）", async () => {
    // 用 fetchImpl 双 150ms 延迟验证编排层并发：串行需 ≥300ms。
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, _init) =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({ choices: [{ message: { content: WORLD_JSON } }] }),
                  { status: 200, headers: { "content-type": "application/json" } }
                )
              ),
            150
          )
        )
    );
    const env = {
      WORLD_BASE: "https://api.example.com/v1",
      WORLD_KEY: "FAKE-KEY-world-1",
      CHAR_BASE: "https://api.example.org/v1",
      CHAR_KEY: "FAKE-KEY-char-1"
    };
    const result = await simulateScene(
      makeInput({
        worldMember: { provider: "openai-compatible", baseUrlEnv: "WORLD_BASE", apiKeyEnv: "WORLD_KEY" },
        characterMember: { provider: "openai-compatible", baseUrlEnv: "CHAR_BASE", apiKeyEnv: "CHAR_KEY" },
        env,
        fetchImpl
      })
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.report?.stats.durationMs).toBeLessThan(280);
  });

  it("A02/A20：一成员超时 → 该侧 failed，另侧正常，degraded，verdict 直通", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    const env = { WORLD_BASE: "https://api.example.com/v1", WORLD_KEY: "FAKE-KEY-world-timeout" };
    const result = await simulateScene(
      makeInput({
        worldMember: {
          provider: "openai-compatible",
          baseUrlEnv: "WORLD_BASE",
          apiKeyEnv: "WORLD_KEY",
          timeoutMs: 40
        },
        env,
        fetchImpl
      })
    );
    expect(result.ok).toBe(true);
    expect(result.report?.degraded).toBe(true);
    expect(result.report?.overallVerdict).toBe("revise"); // character 侧直通
    expect(result.report?.worldFindings).toHaveLength(0);
    expect(result.report?.characterFindings.length).toBeGreaterThan(0);
    const worldReport = result.memberReports.find((m) => m.councilId === "world");
    expect(worldReport?.status).toBe("failed");
    expect(worldReport?.error?.code).toBe("PROVIDER_TIMEOUT");
    expect(result.councilResults).toContainEqual({ councilId: "world", status: "insufficient" });
    expect(result.councilResults).toContainEqual({ councilId: "character", status: "ok" });
  });

  it("A05：双组均失败 → ALL_COUNCILS_FAILED，保留成员报告，不伪造汇总", async () => {
    const result = await simulateScene(
      makeInput({ worldResponses: ["无效输出"], characterResponses: ["也无效"] })
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ALL_COUNCILS_FAILED");
    expect(result.report).toBeNull();
    expect(result.memberReports).toHaveLength(2);
    expect(result.memberReports.every((m) => m.status === "failed")).toBe(true);
    expect(result.memberReports.every((m) => m.error?.code === "REPAIR_FAILED")).toBe(true);
    expect(result.councilResults.every((c) => c.status === "insufficient")).toBe(true);
  });

  it("A10：修复重试触达 maxTotalCalls → BUDGET_EXCEEDED + budgetExceeded", async () => {
    const result = await simulateScene(
      makeInput({
        worldResponses: ["无效", WORLD_JSON],
        characterResponses: ["也无效", CHARACTER_JSON],
        budget: { maxTotalCalls: 3 }
      })
    );
    // 共 3 次实际调用：world 初始+修复，character 初始；character 修复被闸住
    expect(result.ok).toBe(true); // world 修复成功，character insufficient → degraded
    expect(result.report?.stats.totalCalls).toBe(3);
    expect(result.report?.stats.budgetExceeded).toBe(true);
    const statuses = new Map(result.memberReports.map((m) => [m.councilId, m]));
    expect(statuses.get("world")?.status).toBe("repaired");
    expect(statuses.get("character")?.error?.code).toBe("BUDGET_EXCEEDED");
  });

  it("A13：同一 packet 重跑生成不同 runId", async () => {
    const r1 = await simulateScene(makeInput());
    const r2 = await simulateScene(makeInput());
    expect(r1.report?.runId).toBeTruthy();
    expect(r1.report?.runId).not.toBe(r2.report?.runId);
  });

  it("A15：packet 超 maxInputChars → PACKET_TOO_LARGE，零调用", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const env = {
      WORLD_BASE: "https://api.example.com/v1",
      WORLD_KEY: "FAKE-KEY-world-big",
      CHAR_BASE: "https://api.example.org/v1",
      CHAR_KEY: "FAKE-KEY-char-big"
    };
    const result = await simulateScene(
      makeInput({
        worldMember: { provider: "openai-compatible", baseUrlEnv: "WORLD_BASE", apiKeyEnv: "WORLD_KEY" },
        characterMember: { provider: "openai-compatible", baseUrlEnv: "CHAR_BASE", apiKeyEnv: "CHAR_KEY" },
        limits: { maxInputChars: 100 },
        env,
        fetchImpl
      })
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PACKET_TOO_LARGE");
    expect(result.memberReports).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("A18：密钥未配置成员 ENV_KEY_MISSING，不发起调用（D12）", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await simulateScene(
      makeInput({
        worldMember: { provider: "openai-compatible", baseUrlEnv: "WORLD_BASE", apiKeyEnv: "WORLD_KEY" },
        env: {}, // 未设置 WORLD_BASE / WORLD_KEY
        fetchImpl
      })
    );
    expect(result.ok).toBe(true); // character 侧 mock 正常
    expect(result.report?.degraded).toBe(true);
    const world = result.memberReports.find((m) => m.councilId === "world");
    expect(world?.status).toBe("failed");
    expect(world?.error?.code).toBe("ENV_KEY_MISSING");
    expect(world?.attempts).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("A19：enabled:false 成员不被调用（D12）", async () => {
    const result = await simulateScene(makeInput({ characterMember: { enabled: false } }));
    expect(result.ok).toBe(true);
    expect(result.report?.degraded).toBe(true);
    expect(result.memberReports.find((m) => m.councilId === "character")).toBeUndefined();
    expect(result.councilResults).toContainEqual({ councilId: "character", status: "insufficient" });
    expect(result.warnings.some((w) => w.includes("character"))).toBe(true);
  });

  it("A11/A23：API Key 与 extraHeadersEnv 值不出现在错误或报告中", async () => {
    const apiKey = "FAKE-KEY-leak-check-001";
    const headerSecret = "header-secret-leak-002";
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(`上游错误：key=${apiKey} header=${headerSecret}`, { status: 500 })
    );
    const env = {
      WORLD_BASE: "https://api.example.com/v1",
      WORLD_KEY: apiKey,
      HDR_SECRET: headerSecret
    };
    const result = await simulateScene(
      makeInput({
        worldMember: {
          provider: "openai-compatible",
          baseUrlEnv: "WORLD_BASE",
          apiKeyEnv: "WORLD_KEY",
          extraHeadersEnv: { "X-API-Key": "HDR_SECRET" }
        },
        env,
        fetchImpl
      })
    );
    expect(result.ok).toBe(true); // character 侧仍成功
    const world = result.memberReports.find((m) => m.councilId === "world");
    expect(world?.status).toBe("failed");
    expect(world?.error?.code).toBe("PROVIDER_HTTP_ERROR");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(headerSecret);
  });

  // C2 改写：原用例断言"单组多启用成员 → CONFIG_INVALID"（阶段 1 限制）；
  // 阶段 2 该限制被移除，改为验证多启用成员通过形态校验并全部正常执行。
  it("阶段 2 形态：world 组 2 个启用成员 + character 组存在 → 通过校验并全部执行", async () => {
    const config = validConfig({
      worldMember: { mockResponses: [WORLD_JSON] },
      characterMember: { mockResponses: [CHARACTER_JSON] }
    });
    (config.councils as unknown as Array<{ members: unknown[] }>)[0]?.members.push({
      id: "world-extra",
      name: "第二世界评议者",
      provider: "mock",
      model: "mock-model",
      rolePromptPath: "prompts/role.md",
      timeoutMs: 120000,
      enabled: true,
      mockResponses: [WORLD_JSON]
    });
    const result = await simulateScene({ packet: validPacket(), config, rolePrompts: ROLE_PROMPTS, env: {} });
    expect(result.ok).toBe(true);
    expect(result.memberReports).toHaveLength(3);
    expect(result.memberReports.every((m) => m.status === "ok")).toBe(true);
    expect(result.councilResults).toEqual([
      { councilId: "world", status: "ok" },
      { councilId: "character", status: "ok" }
    ]);
    const worldSources = new Set(result.report?.worldFindings.flatMap((f) => f.sourceMemberIds));
    expect(worldSources.has("world-causality")).toBe(true);
    expect(worldSources.has("world-extra")).toBe(true);
  });

  it("阶段 1 形态守卫：额外评议组 → CONFIG_INVALID", async () => {
    const config = validConfig({});
    (config.councils as unknown[]).push({ id: "writing", enabled: true, minValidMembers: 1, members: [] });
    const result = await simulateScene({ packet: validPacket(), config, rolePrompts: ROLE_PROMPTS, env: {} });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONFIG_INVALID");
  });

  it("PACKET_INVALID / CONFIG_INVALID 顶层错误", async () => {
    const badPacket = await simulateScene(makeInput({ packet: { schemaVersion: "1.0" } }));
    expect(badPacket.ok).toBe(false);
    expect(badPacket.error?.code).toBe("PACKET_INVALID");

    const badConfig = await simulateScene({ packet: validPacket(), config: { configVersion: "9.9" }, env: {} });
    expect(badConfig.ok).toBe(false);
    expect(badConfig.error?.code).toBe("CONFIG_INVALID");
  });

  it("ProgressEvent 最小集按序发射（C8）", async () => {
    const events: ProgressEvent[] = [];
    const result = await simulateScene(makeInput({ onProgress: (e) => events.push(e) }));
    expect(result.ok).toBe(true);
    expect(events[0]?.type).toBe("run-start");
    expect(events.filter((e) => e.type === "member-end")).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("run-end");
  });
});
