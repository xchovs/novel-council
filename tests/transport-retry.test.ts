import { describe, expect, it, vi } from "vitest";
import { CoreError, type MemberConfig, type ProgressEvent } from "../src/contracts/index.js";
import { CallBudget } from "../src/core/budget/budget.js";
import { runMember, type RunMemberArgs } from "../src/core/council-runner/council-runner.js";
import { simulateScene } from "../src/core/orchestrator/simulate-scene.js";
import { createRedactor } from "../src/core/redaction/redact.js";
import { MockProvider, type MockStep } from "../src/providers/mock.js";
import {
  multiConfig,
  validCharacterOutput,
  validPacket,
  validWorldOutput
} from "./helpers/fixtures.js";

/**
 * C3 传输错误分类与有界重试（D27 / A30）。
 * 全部使用 MockProvider / mock fetchImpl（D6），禁止真实网络。
 * 事件断言只检查因果序与计数，不依赖跨成员交错序或墙钟耗时（D28）。
 */

const VALID_JSON = JSON.stringify(validWorldOutput());
const CHARACTER_JSON = JSON.stringify(validCharacterOutput());

const networkError = () => new CoreError("PROVIDER_NETWORK_ERROR", "网络错误：fetch failed");
const httpError = (status: number) =>
  new CoreError("PROVIDER_HTTP_ERROR", `HTTP ${status}`, { httpStatus: status });

const retryEvents = (events: ProgressEvent[]) => events.filter((e) => e.type === "member-retry");

function makeMember(overrides?: Partial<MemberConfig>): MemberConfig {
  return {
    id: "world-causality",
    name: "世界评议者",
    provider: "mock",
    model: "mock-model",
    extraHeadersEnv: {},
    rolePromptPath: "prompts/world.md",
    generationParams: {},
    timeoutMs: 1000,
    enabled: true,
    ...overrides
  };
}

function makeArgs(
  steps: MockStep[],
  overrides?: Partial<RunMemberArgs>
): { args: RunMemberArgs; provider: MockProvider; events: ProgressEvent[] } {
  const provider = new MockProvider(steps);
  const events: ProgressEvent[] = [];
  const args: RunMemberArgs = {
    runId: "run-1",
    councilId: "world",
    member: makeMember(),
    packet: validPacket(),
    rolePrompt: "你是世界运行评议者。",
    maxInputChars: 50000,
    maxRetries: 1,
    maxTransportRetries: 1,
    budget: new CallBudget(10),
    redact: createRedactor(),
    now: () => new Date(),
    onProgress: (e: ProgressEvent) => {
      events.push(e);
    },
    ...overrides,
    provider
  };
  return { args, provider, events };
}

describe("传输重试：白名单与边界（A30 / D27）", () => {
  it("网络错误重试成功 → ok（非 repaired），attempts=2，事件与调用一一对应", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: networkError() },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("ok"); // 仅传输重试不标记 repaired
    expect(report.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
    // 传输重试原样重用当前 messages（不重写、不进入修复流程）
    expect(provider.calls[1]?.messages).toEqual(provider.calls[0]?.messages);
    const retries = retryEvents(events);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      type: "member-retry",
      runId: "run-1",
      councilId: "world",
      memberId: "world-causality",
      attempt: 2,
      code: "PROVIDER_NETWORK_ERROR"
    });
  });

  it("HTTP 429 重试成功，事件携带 httpStatus", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: httpError(429) },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("ok");
    expect(report.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(retryEvents(events)).toHaveLength(1);
    expect(retryEvents(events)[0]).toMatchObject({
      code: "PROVIDER_HTTP_ERROR",
      httpStatus: 429,
      attempt: 2
    });
  });

  it.each([500, 502, 503, 504])("HTTP %i 在白名单内 → 重试成功", async (status) => {
    const { args, provider } = makeArgs([
      { kind: "error", error: httpError(status) },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("ok");
    expect(report.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("HTTP 501 不在白名单 → 不重试", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: httpError(501) },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_HTTP_ERROR");
    expect(report.error?.httpStatus).toBe(501);
    expect(report.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(retryEvents(events)).toHaveLength(0);
  });

  it.each([400, 401, 403, 404, 422])("HTTP %i（请求错误 / 认证失败）→ 不重试", async (status) => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: httpError(status) },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_HTTP_ERROR");
    expect(report.error?.httpStatus).toBe(status);
    expect(report.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(retryEvents(events)).toHaveLength(0);
  });

  it("PROVIDER_BAD_JSON（响应信封坏）→ 不重试", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: new CoreError("PROVIDER_BAD_JSON", "响应缺少 choices[0].message.content") },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_BAD_JSON");
    expect(report.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(retryEvents(events)).toHaveLength(0);
  });

  it("无 httpStatus 的 HTTP 错误 → 保守不重试", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: new CoreError("PROVIDER_HTTP_ERROR", "HTTP 500") },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(retryEvents(events)).toHaveLength(0);
  });

  it("网络错误耗尽额度 → failed PROVIDER_NETWORK_ERROR，attempts=2，不再消耗后续步骤", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: networkError() },
      { kind: "error", error: networkError() },
      { kind: "text", text: VALID_JSON } // 不应被消费
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_NETWORK_ERROR");
    expect(report.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(retryEvents(events)).toHaveLength(1);
  });

  it("maxTransportRetries=0 关闭重试：网络错误直接失败", async () => {
    const { args, provider, events } = makeArgs(
      [
        { kind: "error", error: networkError() },
        { kind: "text", text: VALID_JSON }
      ],
      { maxTransportRetries: 0 }
    );
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_NETWORK_ERROR");
    expect(report.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    expect(retryEvents(events)).toHaveLength(0);
  });

  it("maxTransportRetries=2：两次网络错误后成功，attempts=3，事件 attempt=2/3", async () => {
    const { args, provider, events } = makeArgs(
      [
        { kind: "error", error: networkError() },
        { kind: "error", error: networkError() },
        { kind: "text", text: VALID_JSON }
      ],
      { maxTransportRetries: 2 }
    );
    const report = await runMember(args);
    expect(report.status).toBe("ok");
    expect(report.attempts).toBe(3);
    expect(provider.calls).toHaveLength(3);
    expect(retryEvents(events).map((e) => (e.type === "member-retry" ? e.attempt : 0))).toEqual([2, 3]);
  });

  it("预算闸住重试：BUDGET_EXCEEDED，重试未发起，零 member-retry 事件", async () => {
    const { args, provider, events } = makeArgs(
      [
        { kind: "error", error: networkError() },
        { kind: "text", text: VALID_JSON }
      ],
      { budget: new CallBudget(1) }
    );
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("BUDGET_EXCEEDED");
    expect(report.attempts).toBe(1);
    expect(provider.calls).toHaveLength(1);
    // member-retry 严格对应实际发起的调用：预算不足、重试未发起 → 无事件
    expect(retryEvents(events)).toHaveLength(0);
  });
});

describe("传输重试 × 修复重试：加法上限（非嵌套乘法）", () => {
  it("上限证明：maxRetries=1 + maxTransportRetries=1 → 每成员至多 1+1+1=3 次调用（非 2×2=4）", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "error", error: networkError() }, // 调用 1：传输失败 → 用掉唯一传输额度
      { kind: "text", text: "坏JSON" }, // 调用 2：校验失败 → 用掉唯一修复额度
      { kind: "error", error: networkError() }, // 调用 3：传输失败，额度已尽 → 最终失败
      { kind: "text", text: VALID_JSON } // 不应被消费
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_NETWORK_ERROR"); // 最终失败原因 = 最后一次传输错误
    expect(report.attempts).toBe(3); // = 1 首轮 + 1 传输重试 + 1 修复
    expect(provider.calls).toHaveLength(3);
    expect(retryEvents(events)).toHaveLength(1);
  });

  it("交错成功：传输错误 → 校验失败 → 修复成功 = repaired，attempts=3", async () => {
    const { args, provider } = makeArgs([
      { kind: "error", error: networkError() },
      { kind: "text", text: "坏JSON" },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("repaired"); // 经历过 JSON 修复方为 repaired
    expect(report.attempts).toBe(3);
    expect(provider.calls).toHaveLength(3);
    // 第 2 次调用是传输重试（messages 与首次相同）；第 3 次是修复调用（含错误回显，4 条消息）
    expect(provider.calls[1]?.messages).toEqual(provider.calls[0]?.messages);
    expect(provider.calls[2]?.messages).toHaveLength(4);
  });

  it("修复后遇传输错误：以同一修复消息重试且成功（两类计数器独立）", async () => {
    const { args, provider, events } = makeArgs([
      { kind: "text", text: "坏JSON" }, // 调用 1：校验失败 → 修复额度 -1
      { kind: "error", error: networkError() }, // 调用 2（修复消息）：传输失败 → 传输额度 -1
      { kind: "text", text: VALID_JSON } // 调用 3：同一修复消息重发 → 成功
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("repaired");
    expect(report.attempts).toBe(3);
    expect(provider.calls).toHaveLength(3);
    // 传输重试保留修复上下文：第 3 次调用消息与第 2 次一致（含错误回显）
    expect(provider.calls[1]?.messages).toHaveLength(4);
    expect(provider.calls[2]?.messages).toEqual(provider.calls[1]?.messages);
    expect(retryEvents(events)).toHaveLength(1);
    expect(retryEvents(events)[0]).toMatchObject({ attempt: 3 });
  });
});

describe("orchestrator 集成：统计、事件纪律与成员隔离", () => {
  function jsonResponse(content: string, status = 200): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  it("A30：world 500 → 重试成功；totalCalls 含重试；member-retry 先于同成员 member-end；无新增 warning", async () => {
    const events: ProgressEvent[] = [];
    let worldCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      worldCalls += 1;
      if (worldCalls === 1) return new Response("upstream", { status: 500 });
      return jsonResponse(VALID_JSON);
    });
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "world-a", provider: "openai-compatible", model: "m-w", baseUrlEnv: "W_BASE", apiKeyEnv: "W_KEY" }
        ],
        character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }],
        budget: { maxTotalCalls: 6, concurrency: 1 } // concurrency=1 → 确定性顺序
      }),
      env: { W_BASE: "https://a.example.com/v1", W_KEY: "FAKE-KEY-w-a30" },
      fetchImpl,
      onProgress: (e) => {
        events.push(e);
      }
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.report?.stats.totalCalls).toBe(3); // world 2 次 + character 1 次
    const world = result.memberReports.find((m) => m.memberId === "world-a");
    expect(world?.status).toBe("ok");
    expect(world?.attempts).toBe(2);
    expect(result.memberReports.find((m) => m.memberId === "char-a")?.status).toBe("ok");
    // 事件纪律：run-start 最先、run-end 最后、member-retry 先于同成员 member-end
    expect(events[0]?.type).toBe("run-start");
    expect(events.at(-1)?.type).toBe("run-end");
    const retryIdx = events.findIndex((e) => e.type === "member-retry");
    const endIdx = events.findIndex((e) => e.type === "member-end" && e.memberId === "world-a");
    expect(retryIdx).toBeGreaterThan(0);
    expect(endIdx).toBeGreaterThan(retryIdx);
    expect(retryEvents(events)).toHaveLength(1);
    // C3 不产生传输重试 warning
    expect(result.warnings).toHaveLength(0);
  });

  it("A30：429 重试后仍失败 → failed + httpStatus 429；另一成员正常；degraded", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("rate limited", { status: 429 }));
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "world-a", provider: "openai-compatible", model: "m-w", baseUrlEnv: "W_BASE", apiKeyEnv: "W_KEY" }
        ],
        character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }],
        budget: { maxTotalCalls: 6, concurrency: 1 }
      }),
      env: { W_BASE: "https://a.example.com/v1", W_KEY: "FAKE-KEY-w-429" },
      fetchImpl
    });
    expect(result.ok).toBe(true); // character 侧成功 → 降级报告
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 首轮 + 恰好一次重试
    const world = result.memberReports.find((m) => m.memberId === "world-a");
    expect(world?.status).toBe("failed");
    expect(world?.error?.code).toBe("PROVIDER_HTTP_ERROR");
    expect(world?.error?.httpStatus).toBe(429);
    expect(world?.attempts).toBe(2);
    expect(result.memberReports.find((m) => m.memberId === "char-a")?.status).toBe("ok");
    expect(result.report?.degraded).toBe(true);
    expect(result.report?.stats.totalCalls).toBe(3);
    expect(result.councilResults).toContainEqual({ councilId: "world", status: "insufficient" });
    expect(result.councilResults).toContainEqual({ councilId: "character", status: "ok" });
  });
});
