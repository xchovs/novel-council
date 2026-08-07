import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, type CliIo } from "../src/cli/bin.js";
import { CouncilConfigSchema } from "../src/contracts/index.js";
import { CallBudget } from "../src/core/budget/budget.js";
import { getCouncilKind, knownCouncilIds } from "../src/core/council-kinds/council-kinds.js";
import { runMember } from "../src/core/council-runner/council-runner.js";
import { checkConfig } from "../src/core/orchestrator/check-config.js";
import { simulateScene } from "../src/core/orchestrator/simulate-scene.js";
import { createRedactor } from "../src/core/redaction/redact.js";
import { MockProvider } from "../src/providers/mock.js";
import {
  multiConfig,
  validCharacterOutput,
  validPacket,
  validWorldOutput
} from "./helpers/fixtures.js";

/**
 * 阶段 2 多成员第一轮测试（C2）。
 * 全部使用 MockProvider / mock fetchImpl（D6），禁止真实网络。
 * 并发相关断言一律使用计数与门控（D28），不依赖墙钟耗时阈值。
 */

const WORLD_JSON = JSON.stringify(validWorldOutput());
const CHARACTER_JSON = JSON.stringify(validCharacterOutput());

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("多成员第一轮（阶段 2）", () => {
  it("A25：world 2 成员 + character 1 成员全部成功", async () => {
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "world-a", mockResponses: [WORLD_JSON] },
          { id: "world-b", mockResponses: [WORLD_JSON] }
        ],
        character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
      }),
      env: {}
    });
    expect(result.ok).toBe(true);
    expect(result.memberReports).toHaveLength(3);
    expect(result.report?.stats.totalCalls).toBe(3);
    expect(result.report?.degraded).toBe(false);
    const worldSources = new Set(result.report?.worldFindings.flatMap((f) => f.sourceMemberIds));
    expect(worldSources).toEqual(new Set(["world-a", "world-b"]));
    expect(result.councilResults).toEqual([
      { councilId: "world", status: "ok" },
      { councilId: "character", status: "ok" }
    ]);
  });

  it("A27：全局并发池上限 = concurrency（deferred + active/maxActive 计数，无墙钟）", async () => {
    const queue: Array<{ resolve: () => void }> = [];
    const gateResolvers: Array<(() => void) | undefined> = [];
    // 门控：第 n 个调用已启动。调用可能先于 gate 创建（async 函数同步段），故先做计数检查
    const gate = (n: number) =>
      new Promise<void>((r) => {
        if (callCount >= n) r();
        else gateResolvers[n - 1] = r;
      });
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      callCount += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const body = JSON.parse(String(init?.body)) as { model?: string };
      const isCharacter = body.model === "model-c1" || body.model === "model-c2";
      gateResolvers[callCount - 1]?.();
      return new Promise<Response>((resolve) => {
        queue.push({
          resolve: () => {
            active -= 1;
            resolve(jsonResponse(isCharacter ? CHARACTER_JSON : WORLD_JSON));
          }
        });
      });
    });
    const env = {
      W1_BASE: "https://a.example.com/v1",
      W1_KEY: "FAKE-KEY-w1",
      W2_BASE: "https://a.example.com/v1",
      W2_KEY: "FAKE-KEY-w2",
      C1_BASE: "https://b.example.com/v1",
      C1_KEY: "FAKE-KEY-c1",
      C2_BASE: "https://b.example.com/v1",
      C2_KEY: "FAKE-KEY-c2"
    };
    const resultPromise = simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "w1", provider: "openai-compatible", model: "model-w1", baseUrlEnv: "W1_BASE", apiKeyEnv: "W1_KEY" },
          { id: "w2", provider: "openai-compatible", model: "model-w2", baseUrlEnv: "W2_BASE", apiKeyEnv: "W2_KEY" }
        ],
        character: [
          { id: "c1", provider: "openai-compatible", model: "model-c1", baseUrlEnv: "C1_BASE", apiKeyEnv: "C1_KEY" },
          { id: "c2", provider: "openai-compatible", model: "model-c2", baseUrlEnv: "C2_BASE", apiKeyEnv: "C2_KEY" }
        ],
        budget: { maxTotalCalls: 12, concurrency: 2 }
      }),
      env,
      fetchImpl
    });

    await gate(2); // 两个槽位已占满
    await new Promise((r) => setImmediate(r)); // 让微任务边缘落地（非墙钟断言）
    expect(callCount).toBe(2); // 第 3 个任务未启动：池上限生效
    expect(maxActive).toBe(2);

    queue.shift()?.resolve(); // 释放第 1 个 → 第 3 个任务启动
    await gate(3);
    expect(maxActive).toBe(2);

    queue.shift()?.resolve(); // 释放第 2 个 → 第 4 个任务启动
    await gate(4);
    expect(maxActive).toBe(2);

    while (queue.length > 0) queue.shift()?.resolve();
    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(result.memberReports).toHaveLength(4);
    expect(result.report?.stats.totalCalls).toBe(4);
    expect(maxActive).toBe(2);
  });

  it("A26a：组内 1/2 成员失败 → 该组仍 ok（minValidMembers=1），degraded，findings 仅来自幸存成员", async () => {
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "world-ok", mockResponses: [WORLD_JSON] },
          { id: "world-bad", mockResponses: ["无效输出", "仍然无效"] }
        ],
        character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
      }),
      env: {}
    });
    expect(result.ok).toBe(true);
    expect(result.report?.degraded).toBe(true);
    expect(result.councilResults).toContainEqual({ councilId: "world", status: "ok" });
    const bad = result.memberReports.find((m) => m.memberId === "world-bad");
    expect(bad?.status).toBe("failed");
    expect(bad?.error?.code).toBe("REPAIR_FAILED");
    expect(result.report?.rawRefs.find((r) => r.memberId === "world-bad")?.status).toBe("failed");
    const worldSources = new Set(result.report?.worldFindings.flatMap((f) => f.sourceMemberIds));
    expect(worldSources).toEqual(new Set(["world-ok"]));
  });

  it("A26b：minValidMembers=2 仅 1 有效 → 该组 insufficient；幸存成员输出仍参与合并", async () => {
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "world-ok", mockResponses: [WORLD_JSON] },
          { id: "world-bad", mockResponses: ["坏", "仍坏"] }
        ],
        character: [{ id: "char-a", mockResponses: [JSON.stringify(validCharacterOutput({ verdict: "accept" }))] }],
        worldMinValidMembers: 2
      }),
      env: {}
    });
    expect(result.ok).toBe(true);
    expect(result.report?.degraded).toBe(true);
    expect(result.councilResults).toContainEqual({ councilId: "world", status: "insufficient" });
    expect(result.councilResults).toContainEqual({ councilId: "character", status: "ok" });
    // 幸存 world 成员的发现与 verdict 不丢失（merger 合并所有有效成员输出）
    expect(result.report?.worldFindings.length).toBeGreaterThan(0);
    expect(result.report?.overallVerdict).toBe("revise"); // world-ok=revise + char=accept → revise
  });

  it("A05（多成员）：2+2 全部失败 → ALL_COUNCILS_FAILED，保留全部失败报告", async () => {
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "world-a", mockResponses: ["坏", "坏"] },
          { id: "world-b", mockResponses: ["坏", "坏"] }
        ],
        character: [
          { id: "char-a", mockResponses: ["糟", "糟"] },
          { id: "char-b", mockResponses: ["糟", "糟"] }
        ]
      }),
      env: {}
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ALL_COUNCILS_FAILED");
    expect(result.report).toBeNull();
    expect(result.memberReports).toHaveLength(4);
    expect(
      result.memberReports.every((m) => m.status === "failed" && m.error?.code === "REPAIR_FAILED")
    ).toBe(true);
    expect(result.councilResults.every((c) => c.status === "insufficient")).toBe(true);
  });

  it("预算：多成员与 JSON 修复共用 maxTotalCalls（concurrency=1 保证确定性）", async () => {
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [{ id: "world-a", mockResponses: ["无效", WORLD_JSON] }],
        character: [{ id: "char-a", mockResponses: ["也无效", CHARACTER_JSON] }],
        budget: { maxTotalCalls: 3, concurrency: 1 }
      }),
      env: {}
    });
    // 顺序（concurrency=1）：world 初始+修复（2 次）→ character 初始（第 3 次）→ character 修复被闸
    expect(result.ok).toBe(true);
    expect(result.report?.stats.totalCalls).toBe(3);
    expect(result.report?.stats.budgetExceeded).toBe(true);
    expect(result.memberReports.find((m) => m.memberId === "world-a")?.status).toBe("repaired");
    const charReport = result.memberReports.find((m) => m.memberId === "char-a");
    expect(charReport?.status).toBe("failed");
    expect(charReport?.error?.code).toBe("BUDGET_EXCEEDED");
  });

  it("A28：跨组同名 memberId 经复合键路由各自 rolePrompt，互不串扰", async () => {
    const recorder: Array<{ model: string; body: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const bodyText = String(init?.body);
      const model = (JSON.parse(bodyText) as { model?: string }).model ?? "";
      recorder.push({ model, body: bodyText });
      return jsonResponse(model === "model-w" ? WORLD_JSON : CHARACTER_JSON);
    });
    const env = {
      W_BASE: "https://a.example.com/v1",
      W_KEY: "FAKE-KEY-w",
      C_BASE: "https://b.example.com/v1",
      C_KEY: "FAKE-KEY-c"
    };
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "reviewer", provider: "openai-compatible", model: "model-w", baseUrlEnv: "W_BASE", apiKeyEnv: "W_KEY" }
        ],
        character: [
          { id: "reviewer", provider: "openai-compatible", model: "model-c", baseUrlEnv: "C_BASE", apiKeyEnv: "C_KEY" }
        ]
      }),
      rolePrompts: {
        "world:reviewer": "ROLE-WORLD-ONLY 世界席位",
        "character:reviewer": "ROLE-CHAR-ONLY 人物席位"
      },
      env,
      fetchImpl
    });
    expect(result.ok).toBe(true);
    const byModel = new Map(recorder.map((r) => [r.model, r.body]));
    expect(byModel.get("model-w")).toContain("ROLE-WORLD-ONLY");
    expect(byModel.get("model-w")).not.toContain("ROLE-CHAR-ONLY");
    expect(byModel.get("model-c")).toContain("ROLE-CHAR-ONLY");
    expect(byModel.get("model-c")).not.toContain("ROLE-WORLD-ONLY");
    // 同名席位归属不混：reportId 仍按 councilId 区分
    const ids = result.memberReports.map((m) => m.reportId);
    expect(ids).toContain(`${result.report?.runId}:world:reviewer`);
    expect(ids).toContain(`${result.report?.runId}:character:reviewer`);
  });

  it("A28：rolePrompts 裸 memberId 键兜底（向后兼容）", async () => {
    const recorder: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      recorder.push(String(init?.body));
      return jsonResponse(WORLD_JSON);
    });
    const env = { W_BASE: "https://a.example.com/v1", W_KEY: "FAKE-KEY-w" };
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "world-a", provider: "openai-compatible", model: "model-w", baseUrlEnv: "W_BASE", apiKeyEnv: "W_KEY" }
        ],
        character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
      }),
      rolePrompts: { "world-a": "ROLE-BARE-KEY 裸键提示词" }, // 无复合键
      env,
      fetchImpl
    });
    expect(result.ok).toBe(true);
    expect(recorder[0]).toContain("ROLE-BARE-KEY");
  });

  it("A29：未知 council id → CONFIG_INVALID 且消息含非法 id；check-config 同样报告", async () => {
    const raw = multiConfig({
      world: [{ id: "world-a", mockResponses: [WORLD_JSON] }],
      character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
    });
    (raw.councils as unknown[]).push({ id: "writing", enabled: true, minValidMembers: 1, members: [] });
    const result = await simulateScene({ packet: validPacket(), config: raw, env: {} });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONFIG_INVALID");
    expect(result.error?.message).toContain("writing");

    const checked = checkConfig(CouncilConfigSchema.parse(raw), {});
    expect(checked.ok).toBe(false);
    expect(checked.issues.join(" ")).toContain("writing");
  });

  it("check-config：接受 2+1 多成员配置", () => {
    const config = CouncilConfigSchema.parse(
      multiConfig({
        world: [
          { id: "world-a", mockResponses: [WORLD_JSON] },
          { id: "world-b", mockResponses: [WORLD_JSON] }
        ],
        character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
      })
    );
    const result = checkConfig(config, {});
    expect(result.ok).toBe(true);
    expect(result.members).toHaveLength(3);
  });

  it("两组必须存在：缺少 character 组 → CONFIG_INVALID 且消息含缺失组 id", async () => {
    const raw = multiConfig({
      world: [{ id: "world-a", mockResponses: [WORLD_JSON] }],
      character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
    });
    (raw as { councils: unknown[] }).councils = (raw.councils as unknown[]).filter(
      (c) => (c as { id: string }).id !== "character"
    );
    const result = await simulateScene({ packet: validPacket(), config: raw, env: {} });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONFIG_INVALID");
    expect(result.error?.message).toContain("缺少评议组 character");
  });

  it("第一轮输入隔离：成员只收到 packet 与自己的 rolePrompt 哨兵，无前序结果回流", async () => {
    const recorder: Array<{ model: string; body: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const bodyText = String(init?.body);
      const model = (JSON.parse(bodyText) as { model?: string }).model ?? "";
      recorder.push({ model, body: bodyText });
      const content =
        model === "model-c1"
          ? JSON.stringify(validCharacterOutput({ interactionConflicts: ["OUT-C1"] }))
          : model === "model-w2"
            ? JSON.stringify(validWorldOutput({ externalPressures: ["OUT-W2"] }))
            : JSON.stringify(validWorldOutput({ externalPressures: ["OUT-W1"] }));
      return jsonResponse(content);
    });
    const env = {
      W1_BASE: "https://a.example.com/v1",
      W1_KEY: "FAKE-KEY-w1",
      W2_BASE: "https://a.example.com/v1",
      W2_KEY: "FAKE-KEY-w2",
      C1_BASE: "https://b.example.com/v1",
      C1_KEY: "FAKE-KEY-c1"
    };
    const result = await simulateScene({
      packet: validPacket(),
      config: multiConfig({
        world: [
          { id: "w1", provider: "openai-compatible", model: "model-w1", baseUrlEnv: "W1_BASE", apiKeyEnv: "W1_KEY" },
          { id: "w2", provider: "openai-compatible", model: "model-w2", baseUrlEnv: "W2_BASE", apiKeyEnv: "W2_KEY" }
        ],
        character: [
          { id: "c1", provider: "openai-compatible", model: "model-c1", baseUrlEnv: "C1_BASE", apiKeyEnv: "C1_KEY" }
        ]
      }),
      rolePrompts: {
        "world:w1": "ROLE-PROMPT-W1-ONLY 世界评议者一",
        "world:w2": "ROLE-PROMPT-W2-ONLY 世界评议者二",
        "character:c1": "ROLE-PROMPT-C1-ONLY 人物评议者"
      },
      env,
      fetchImpl
    });
    expect(result.ok).toBe(true);
    expect(recorder).toHaveLength(3);
    const byModel = new Map(recorder.map((r) => [r.model, r.body]));
    const sentinels: Record<string, string> = {
      "model-w1": "ROLE-PROMPT-W1-ONLY",
      "model-w2": "ROLE-PROMPT-W2-ONLY",
      "model-c1": "ROLE-PROMPT-C1-ONLY"
    };
    for (const [model, body] of byModel) {
      // 1. 公共 packet 确实下发
      expect(body).toContain("ch01-scene01");
      // 2. 含且只含自己的 rolePrompt 哨兵
      expect(body).toContain(sentinels[model]);
      for (const [otherModel, sentinel] of Object.entries(sentinels)) {
        if (otherModel !== model) expect(body).not.toContain(sentinel);
      }
      // 3. 不含任何前序执行结果结构
      expect(body).not.toContain("memberReports");
      expect(body).not.toContain("councilResults");
      expect(body).not.toContain("reportId");
      expect(body).not.toContain("sourceMemberIds");
      expect(body).not.toContain("worldFindings");
    }
    // 4. 归属确认（非隔离证明）：各成员输出归属正确
    const w1 = result.memberReports.find((m) => m.memberId === "w1");
    const w2 = result.memberReports.find((m) => m.memberId === "w2");
    const c1 = result.memberReports.find((m) => m.memberId === "c1");
    expect(JSON.stringify(w1?.output)).toContain("OUT-W1");
    expect(JSON.stringify(w2?.output)).toContain("OUT-W2");
    expect(JSON.stringify(c1?.output)).toContain("OUT-C1");
  });

  it("席位身份：仅切换 model 不改变 reportId / rawRefs 归属", async () => {
    const makeConfig = (model: string) =>
      multiConfig({
        world: [{ id: "world-a", model, mockResponses: [WORLD_JSON] }],
        character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
      });
    const r1 = await simulateScene({
      packet: validPacket(),
      config: makeConfig("model-a"),
      env: {},
      runId: "fixed-run"
    });
    const r2 = await simulateScene({
      packet: validPacket(),
      config: makeConfig("model-b"),
      env: {},
      runId: "fixed-run"
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.memberReports.map((m) => m.reportId)).toEqual(r2.memberReports.map((m) => m.reportId));
    expect(r1.report?.rawRefs).toEqual(r2.report?.rawRefs);
  });
});

describe("council-kinds 注册表", () => {
  it("world/character 命中，未知组 undefined，knownCouncilIds 列举两组", () => {
    expect(getCouncilKind("world")?.reportBucket).toBe("worldFindings");
    expect(getCouncilKind("character")?.reportBucket).toBe("characterFindings");
    expect(getCouncilKind("writing")).toBeUndefined();
    expect(knownCouncilIds()).toEqual(["world", "character"]);
  });

  it("防御：runMember 收到未知 councilId → CONFIG_INVALID 失败报告，零调用", async () => {
    const provider = new MockProvider([{ kind: "text", text: WORLD_JSON }]);
    const report = await runMember({
      runId: "run-x",
      councilId: "writing",
      member: {
        id: "m1",
        name: "x",
        provider: "mock",
        model: "mock-model",
        extraHeadersEnv: {},
        rolePromptPath: "p",
        generationParams: {},
        timeoutMs: 1000,
        enabled: true
      },
      provider,
      packet: validPacket(),
      rolePrompt: "",
      maxInputChars: 50000,
      maxRetries: 1,
      maxTransportRetries: 1,
      budget: new CallBudget(4),
      redact: createRedactor(),
      now: () => new Date()
    });
    expect(report.status).toBe("failed");
    expect(report.error?.code).toBe("CONFIG_INVALID");
    expect(report.attempts).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("CLI 多成员端到端", () => {
  let dir = "";
  let stdoutBuf = "";
  let stderrBuf = "";

  function makeIo(env: Record<string, string | undefined> = {}): CliIo {
    return {
      stdout: (t) => {
        stdoutBuf += t;
      },
      stderr: (t) => {
        stderrBuf += t;
      },
      env,
      cwd: dir
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "novel-council-mm-"));
    stdoutBuf = "";
    stderrBuf = "";
    await mkdir(path.join(dir, "prompts"), { recursive: true });
    await writeFile(path.join(dir, "prompts", "role.md"), "你是评议者。", "utf8");
    await writeFile(path.join(dir, "packet.json"), JSON.stringify(validPacket()), "utf8");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("2+1 mock 成员端到端：退出码 0，stdout 可 JSON.parse，3 份成员报告，findings 双来源", async () => {
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify(
        multiConfig({
          world: [
            { id: "world-a", mockResponses: [WORLD_JSON] },
            { id: "world-b", mockResponses: [WORLD_JSON] }
          ],
          character: [{ id: "char-a", mockResponses: [CHARACTER_JSON] }]
        })
      ),
      "utf8"
    );
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock"],
      makeIo()
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(stdoutBuf) as {
      ok: boolean;
      memberReports: Array<{ reportId: string }>;
      report: { worldFindings: Array<{ sourceMemberIds: string[] }> } | null;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.memberReports).toHaveLength(3);
    const sources = new Set(envelope.report?.worldFindings.flatMap((f) => f.sourceMemberIds));
    expect(sources).toEqual(new Set(["world-a", "world-b"]));
    // 进度走 stderr：3 个 member-end 行
    expect(stderrBuf).toContain("world/world-a");
    expect(stderrBuf).toContain("world/world-b");
    expect(stderrBuf).toContain("character/char-a");
  });
});
