import { describe, expect, it } from "vitest";
import { CoreError, type MemberConfig } from "../src/contracts/index.js";
import { CallBudget } from "../src/core/budget/budget.js";
import { runMember, type RunMemberArgs } from "../src/core/council-runner/council-runner.js";
import { createRedactor } from "../src/core/redaction/redact.js";
import { MockProvider, type MockStep } from "../src/providers/mock.js";
import { validPacket, validWorldOutput } from "./helpers/fixtures.js";

/** council-runner 单元测试：全部使用 MockProvider（D6）。 */

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

function makeArgs(steps: MockStep[], overrides?: Partial<RunMemberArgs>) {
  const provider = new MockProvider(steps);
  return {
    runId: "run-1",
    councilId: "world",
    member: makeMember(),
    packet: validPacket(),
    rolePrompt: "你是世界运行评议者。",
    maxInputChars: 50000,
    maxRetries: 1,
    maxTransportRetries: 1,
    budget: new CallBudget(4),
    redact: createRedactor(),
    now: () => new Date(),
    ...overrides,
    provider
  };
}

const VALID_JSON = JSON.stringify(validWorldOutput());

describe("runMember", () => {
  it("首次调用成功：status ok，attempts 1", async () => {
    const args = makeArgs([{ kind: "text", text: VALID_JSON }]);
    const report = await runMember(args);
    expect(report.status).toBe("ok");
    expect(report.attempts).toBe(1);
    expect(report.output?.verdict).toBe("revise");
    expect(report.reportId).toBe("run-1:world:world-causality");
    expect(args.provider.calls).toHaveLength(1);
  });

  it("A03/A04：无效 JSON 触发恰好一次修复，修复成功标记 repaired", async () => {
    const args = makeArgs([
      { kind: "text", text: "这不是 JSON" },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("repaired");
    expect(report.attempts).toBe(2);
    expect(args.provider.calls).toHaveLength(2);
    // 修复调用包含错误回显
    const repairMessages = args.provider.calls[1]?.messages ?? [];
    expect(repairMessages.at(-1)?.content).toContain("未通过 JSON 校验");
  });

  it("A04：修复仍失败 → REPAIR_FAILED，attempts 2，不再重试", async () => {
    const args = makeArgs([
      { kind: "text", text: "垃圾输出" },
      { kind: "text", text: '{"verdict":"maybe"}' }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("REPAIR_FAILED");
    expect(report.attempts).toBe(2);
    expect(args.provider.calls).toHaveLength(2);
  });

  it("A02：超时步骤 + 小 timeoutMs → PROVIDER_TIMEOUT，不重试", async () => {
    const args = makeArgs([{ kind: "timeout" }], { member: makeMember({ timeoutMs: 30 }) });
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_TIMEOUT");
    expect(report.attempts).toBe(1);
    expect(args.provider.calls).toHaveLength(1);
  });

  it("HTTP 错误不修复不重试（architecture §9.3）", async () => {
    const args = makeArgs([
      { kind: "error", error: new CoreError("PROVIDER_HTTP_ERROR", "HTTP 500") },
      { kind: "text", text: VALID_JSON }
    ]);
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PROVIDER_HTTP_ERROR");
    expect(report.attempts).toBe(1);
    expect(args.provider.calls).toHaveLength(1);
  });

  it("成员级 PACKET_TOO_LARGE：零调用（D8）", async () => {
    const args = makeArgs([{ kind: "text", text: VALID_JSON }], { maxInputChars: 10 });
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("PACKET_TOO_LARGE");
    expect(report.attempts).toBe(0);
    expect(args.provider.calls).toHaveLength(0);
  });

  it("A10：预算耗尽时修复被闸住 → BUDGET_EXCEEDED", async () => {
    const args = makeArgs([{ kind: "text", text: "无效" }, { kind: "text", text: VALID_JSON }], {
      budget: new CallBudget(1)
    });
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("BUDGET_EXCEEDED");
    expect(report.attempts).toBe(1);
    expect(args.provider.calls).toHaveLength(1);
  });

  it("maxRetries=0 时无效 JSON 直接 REPAIR_FAILED", async () => {
    const args = makeArgs([{ kind: "text", text: "无效" }], { maxRetries: 0 });
    const report = await runMember(args);
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("REPAIR_FAILED");
    expect(args.provider.calls).toHaveLength(1);
  });
});
