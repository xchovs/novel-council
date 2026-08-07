import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli/bin.js";
import {

  multiConfig,
  validCharacterOutput,
  validConfig,
  validPacket,
  validWorldOutput
} from "./helpers/fixtures.js";

/** CLI 测试：in-process 调用 main()，捕获 stdout/stderr；只用 mock 配置（D6/D16）。 */

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

async function writeJson(rel: string, data: unknown): Promise<void> {
  await writeFile(path.join(dir, rel), JSON.stringify(data), "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "novel-council-cli-"));
  stdoutBuf = "";
  stderrBuf = "";
  await mkdir(path.join(dir, "prompts"), { recursive: true });
  await writeFile(path.join(dir, "prompts", "role.md"), "你是评议者。", "utf8");
  await writeJson("packet.json", validPacket());
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function mockConfig(overrides?: { worldMember?: Record<string, unknown>; characterMember?: Record<string, unknown> }) {
  return validConfig({
    worldMember: {
      rolePromptPath: "prompts/role.md",
      mockResponses: [JSON.stringify(validWorldOutput())],
      ...(overrides?.worldMember ?? {})
    },
    characterMember: {
      rolePromptPath: "prompts/role.md",
      mockResponses: [JSON.stringify(validCharacterOutput())],
      ...(overrides?.characterMember ?? {})
    }
  });
}

describe("CLI simulate", () => {
  it("A21：mock 配置无 --allow-mock → MOCK_NOT_ALLOWED，stdout 为空", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(["simulate", "--packet", "packet.json", "--config", "config.json"], makeIo());
    expect(code).toBe(1);
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("MOCK_NOT_ALLOWED");
  });

  it("A21/A24：--allow-mock 端到端成功，stdout 可直接 JSON.parse，进度在 stderr", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock"],
      makeIo()
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(stdoutBuf) as {
      ok: boolean;
      report: { runId: string; rawRefs: Array<{ reportId: string }> } | null;
      memberReports: Array<{ reportId: string }>;
      councilResults: Array<{ councilId: string; status: string }>;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.report).not.toBeNull();
    // D20：rawRefs 可经 reportId 在 memberReports 中解析
    const ids = new Set(envelope.memberReports.map((m) => m.reportId));
    for (const ref of envelope.report?.rawRefs ?? []) expect(ids.has(ref.reportId)).toBe(true);
    // D21：进度只在 stderr
    expect(stderrBuf).toContain("开始，成员");
    expect(stderrBuf).toContain("结束 ok=true");
    expect(stderrBuf).not.toContain('"ok":true');
  });

  it("A17：--output 写入同一完整信封", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock", "--output", "out.json"],
      makeIo()
    );
    expect(code).toBe(0);
    const fileContent = await readFile(path.join(dir, "out.json"), "utf8");
    expect(JSON.parse(fileContent)).toEqual(JSON.parse(stdoutBuf));
  });

  it("A17：--output 路径不可写 → OUTPUT_WRITE_FAILED，stdout 为空", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(
      [
        "simulate",
        "--packet",
        "packet.json",
        "--config",
        "config.json",
        "--allow-mock",
        "--output",
        "no-such-dir/out.json"
      ],
      makeIo()
    );
    expect(code).toBe(1);
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("OUTPUT_WRITE_FAILED");
  });

  it("双组全失败 → 退出码 2，信封保留成员失败报告", async () => {
    await writeJson(
      "config.json",
      mockConfig({
        worldMember: { mockResponses: ["垃圾"] },
        characterMember: { mockResponses: ["也垃圾"] }
      })
    );
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock"],
      makeIo()
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(stdoutBuf) as { ok: boolean; error?: { code: string }; memberReports: unknown[] };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("ALL_COUNCILS_FAILED");
    expect(envelope.memberReports).toHaveLength(2);
  });

  it("packet 非法 → 退出码 1，stdout 为空", async () => {
    await writeJson("config.json", mockConfig());
    await writeJson("bad-packet.json", { schemaVersion: "1.0" });
    const code = await main(
      ["simulate", "--packet", "bad-packet.json", "--config", "config.json", "--allow-mock"],
      makeIo()
    );
    expect(code).toBe(1);
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("PACKET_INVALID");
  });

  it("A22：generationParams 保留字段 → simulate CONFIG_INVALID", async () => {
    await writeJson("config.json", mockConfig({ worldMember: { generationParams: { stream: true } } }));
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock"],
      makeIo()
    );
    expect(code).toBe(1);
    expect(stderrBuf).toContain("CONFIG_INVALID");
    expect(stderrBuf).toContain("stream");
  });
});

describe("CLI check-config", () => {
  it("输出独立检查信封；密钥值永不出现", async () => {
    const config = validConfig({
      worldMember: {
        provider: "openai-compatible",
        baseUrlEnv: "WORLD_BASE",
        apiKeyEnv: "WORLD_KEY",
        rolePromptPath: "prompts/role.md"
      },
      characterMember: {
        provider: "openai-compatible",
        baseUrlEnv: "CHAR_BASE",
        apiKeyEnv: "CHAR_KEY",
        rolePromptPath: "prompts/role.md"
      }
    });
    await writeJson("config.json", config);
    const code = await main(
      ["check-config", "--config", "config.json"],
      makeIo({ WORLD_BASE: "https://a.example.com/v1", WORLD_KEY: "FAKE-KEY-check-1", CHAR_BASE: "https://b.example.com/v1", CHAR_KEY: "FAKE-KEY-check-2" })
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(stdoutBuf) as {
      ok: boolean;
      members: Array<{ keyConfigured: boolean; promptFileReadable: boolean }>;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.members.every((m) => m.keyConfigured)).toBe(true);
    expect(envelope.members.every((m) => m.promptFileReadable)).toBe(true);
    expect(stdoutBuf).not.toContain("FAKE-KEY-check-1");
    expect(stdoutBuf).not.toContain("FAKE-KEY-check-2");
  });

  it("密钥缺失 → ok:false，退出码 1", async () => {
    const config = validConfig({
      worldMember: { provider: "openai-compatible", baseUrlEnv: "WORLD_BASE", apiKeyEnv: "WORLD_KEY", rolePromptPath: "prompts/role.md" }
    });
    await writeJson("config.json", config);
    const code = await main(["check-config", "--config", "config.json"], makeIo({}));
    expect(code).toBe(1);
    const envelope = JSON.parse(stdoutBuf) as { ok: boolean; members: Array<{ keyConfigured: boolean }> };
    expect(envelope.ok).toBe(false);
    expect(envelope.members.some((m) => !m.keyConfigured)).toBe(true);
  });

  it("A22：generationParams 保留字段 → check-config 信封 ok:false", async () => {
    await writeJson("config.json", mockConfig({ worldMember: { generationParams: { tools: [] } } }));
    const code = await main(["check-config", "--config", "config.json"], makeIo());
    expect(code).toBe(1);
    const envelope = JSON.parse(stdoutBuf) as { ok: boolean; issues: string[] };
    expect(envelope.ok).toBe(false);
    expect(envelope.issues.join(" ")).toContain("tools");
  });
});

describe("CLI 参数解析", () => {
  it("未知命令 → 退出码 1 并输出用法到 stderr", async () => {
    const code = await main(["bogus"], makeIo());
    expect(code).toBe(1);
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("用法");
  });

  it("simulate 缺少 --packet → 退出码 1", async () => {
    const code = await main(["simulate", "--config", "config.json"], makeIo());
    expect(code).toBe(1);
    expect(stderrBuf).toContain("--packet");
  });
});

describe("CLI --mode（C4）", () => {
  it("C01：simulate --mode standard → 退出码 0，report.mode=standard，未配置主持回退不告警（A34/D31）", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock", "--mode", "standard"],
      makeIo()
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(stdoutBuf) as {
      ok: boolean;
      report: { mode: string } | null;
      councilReports: Array<{ councilId: string; fallbackUsed: boolean; moderatorMemberId: string }>;
      warnings: string[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.report?.mode).toBe("standard");
    // C5：standard 每组一条 CouncilReport；未配置主持 → 规则回退（fallbackUsed=true，moderatorMemberId=""）
    expect(envelope.councilReports).toHaveLength(2);
    for (const cr of envelope.councilReports) {
      expect(cr.fallbackUsed).toBe(true);
      expect(cr.moderatorMemberId).toBe("");
    }
    // 未配置主持的规则回退不告警（A34）：信封无主持 warning，stderr 亦无
    expect(envelope.warnings).toEqual([]);
    expect(stderrBuf).not.toContain("警告：");
  });


  it("C02：simulate --mode deep → 退出码 1，信封 ok:false + CONFIG_INVALID", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock", "--mode", "deep"],
      makeIo()
    );
    expect(code).toBe(1);
    const envelope = JSON.parse(stdoutBuf) as { ok: boolean; error?: { code: string; message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("CONFIG_INVALID");
    expect(envelope.error?.message).toContain("阶段 3");
  });

  it("C03：simulate --mode bogus → 退出码 1，CONFIG_INVALID", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock", "--mode", "bogus"],
      makeIo()
    );
    expect(code).toBe(1);
    const envelope = JSON.parse(stdoutBuf) as { ok: boolean; error?: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("CONFIG_INVALID");
  });

  it("C04：不传 --mode → report.mode=quick，无警告（回归）", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(
      ["simulate", "--packet", "packet.json", "--config", "config.json", "--allow-mock"],
      makeIo()
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(stdoutBuf) as { report: { mode: string } | null; warnings: string[] };
    expect(envelope.report?.mode).toBe("quick");
    expect(envelope.warnings).toEqual([]);
    expect(stderrBuf).not.toContain("警告：");
  });

  it("C05：check-config --mode quick → 信封含确定性 estimate（A32）", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(["check-config", "--config", "config.json", "--mode", "quick"], makeIo());
    expect(code).toBe(0);
    const envelope = JSON.parse(stdoutBuf) as {
      ok: boolean;
      estimate?: {
        mode: string;
        memberCount: number;
        perMemberMaxCalls: number;
        minCalls: number;
        maxCalls: number;
        maxTotalCalls: number;
        budgetCoverage: string;
        breakdown: { minModeratorCalls: number; maxModeratorCalls: number };
      };

    };
    expect(envelope.ok).toBe(true);
    expect(envelope.estimate).toBeDefined();
    expect(envelope.estimate?.mode).toBe("quick");
    expect(envelope.estimate?.memberCount).toBe(2);
    expect(envelope.estimate?.perMemberMaxCalls).toBe(3);
    expect(envelope.estimate?.minCalls).toBe(2);
    expect(envelope.estimate?.maxCalls).toBe(6);
    expect(envelope.estimate?.maxTotalCalls).toBe(4);
    expect(envelope.estimate?.budgetCoverage).toBe("covers-min");
    expect(envelope.estimate?.breakdown.minModeratorCalls).toBe(0);
    expect(envelope.estimate?.breakdown.maxModeratorCalls).toBe(0);
  });


  it("C06：check-config --mode deep → ok:false + 阶段 3 说明，无 estimate，退出码 1", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(["check-config", "--config", "config.json", "--mode", "deep"], makeIo());
    expect(code).toBe(1);
    const envelope = JSON.parse(stdoutBuf) as { ok: boolean; issues: string[]; estimate?: unknown };
    expect(envelope.ok).toBe(false);
    expect(envelope.issues.join(" ")).toContain("阶段 3");
    expect("estimate" in envelope).toBe(false);
  });

  it("C07：check-config 预估必然不足 → estimate.budgetCoverage=below-min + stderr 告警，退出码仍 0", async () => {
    await writeJson(
      "config.json",
      multiConfig({
        world: [{ id: "w1" }, { id: "w2" }],
        character: [{ id: "c1" }],
        budget: { maxTotalCalls: 2 }
      })
    );
    const code = await main(["check-config", "--config", "config.json"], makeIo());
    expect(code).toBe(0); // 只告警，不拒绝（A32/D26）
    const envelope = JSON.parse(stdoutBuf) as {
      ok: boolean;
      estimate?: { minCalls: number; maxTotalCalls: number; budgetCoverage: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.estimate?.minCalls).toBe(3);
    expect(envelope.estimate?.maxTotalCalls).toBe(2);
    expect(envelope.estimate?.budgetCoverage).toBe("below-min");
    expect(stderrBuf).toContain("警告：调用预算预估不足");
  });

  it("C08：check-config --mode bogus → CONFIG_INVALID（用法错误走 stderr），退出码 1", async () => {
    await writeJson("config.json", mockConfig());
    const code = await main(["check-config", "--config", "config.json", "--mode", "bogus"], makeIo());
    expect(code).toBe(1);
    expect(stdoutBuf).toBe("");
    expect(stderrBuf).toContain("CONFIG_INVALID");
    expect(stderrBuf).toContain("--mode");
  });
});
