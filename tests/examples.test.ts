import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli/bin.js";
import { CouncilConfigSchema, ScenePacketSchema } from "../src/contracts/index.js";
import { moderatorSkippedQuickWarning } from "../src/core/orchestrator/execution-modes.js";

/**
 * 示例守门（C6/T16：mock 端到端冒烟 + 文档一致性）：
 * - examples/ 全部配置过 CouncilConfigSchema、packet 过 ScenePacketSchema；
 * - 示例引用的 rolePromptPath（含 moderator）按生产基准可解析——与 src/cli/cmd-simulate.ts
 *   loadRolePrompts 完全相同的规则：相对【配置文件所在目录】解析（path.dirname(path.resolve(cwd, config))），
 *   仅加载启用成员与启用组主持的提示词；本测试不自建任何路径解析规则；
 * - mock 示例经 in-process CLI 端到端：旧单成员 quick 兼容 / quick 多成员 + 主持跳过 /
 *   standard 主持成功 / deep 零调用 CONFIG_INVALID；
 * - openai-compatible 示例注入非敏感测试 env 跑 check-config（纯检查，不发起网络请求），
 *   estimate 数值与 README 文档表保持一致；
 * - 全程无网络调用：simulate 只跑 mock 配置；check-config 不发起请求。
 */

const repoRoot = process.cwd();
const examplesDir = path.join(repoRoot, "examples");

const CONFIG_EXAMPLES = [
  "councils.example.json",
  "councils.mock.example.json",
  "councils.multi-quick.example.json",
  "councils.standard-usemember.example.json",
  "councils.standard-inline-moderator.example.json",
  "councils.disabled-council.example.json",
  "councils.standard-mock.example.json"
] as const;

/** 非敏感测试占位 env：仅用于 check-config 的 keyConfigured 判定，永不进入请求；输出不得泄漏这些值。 */
const TEST_ENV: Record<string, string> = {
  WORLD_API_BASE_URL: "https://example.invalid/v1",
  WORLD_API_KEY: "TEST-PLACEHOLDER-WORLD-KEY",
  WORLD2_API_BASE_URL: "https://example.invalid/v1",
  WORLD2_API_KEY: "TEST-PLACEHOLDER-WORLD2-KEY",
  CHARACTER_API_BASE_URL: "https://example.invalid/v1",
  CHARACTER_API_KEY: "TEST-PLACEHOLDER-CHARACTER-KEY",
  MODERATOR_API_BASE_URL: "https://example.invalid/v1",
  MODERATOR_API_KEY: "TEST-PLACEHOLDER-MODERATOR-KEY"
};

function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  let stdoutBuf = "";
  let stderrBuf = "";
  return {
    io: {
      stdout: (t) => {
        stdoutBuf += t;
      },
      stderr: (t) => {
        stderrBuf += t;
      },
      env: { ...TEST_ENV },
      cwd: repoRoot
    },
    out: () => stdoutBuf,
    err: () => stderrBuf
  };
}

function exampleRel(name: string): string {
  return path.join("examples", name);
}

describe("examples 契约与提示词路径", () => {
  it("scene-packet.example.json 通过 ScenePacketSchema", async () => {
    const raw = JSON.parse(await readFile(path.join(examplesDir, "scene-packet.example.json"), "utf8"));
    const parsed = ScenePacketSchema.safeParse(raw);
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
  });

  it("全部 councils 示例通过 CouncilConfigSchema", async () => {
    for (const name of CONFIG_EXAMPLES) {
      const raw = JSON.parse(await readFile(path.join(examplesDir, name), "utf8"));
      const parsed = CouncilConfigSchema.safeParse(raw);
      if (!parsed.success) console.error(name, parsed.error.issues);
      expect(parsed.success, `${name} 应通过 CouncilConfigSchema`).toBe(true);
    }
  });

  it("示例引用的 rolePromptPath（含 moderator）按生产基准可解析", async () => {
    const checked: string[] = [];
    for (const name of CONFIG_EXAMPLES) {
      const configRel = exampleRel(name);
      // 与生产完全一致：configPath = path.resolve(cwd, flags.config)；基准目录 = path.dirname(configPath)
      const configDir = path.dirname(path.resolve(repoRoot, configRel));
      const raw = JSON.parse(await readFile(path.join(examplesDir, name), "utf8"));
      const config = CouncilConfigSchema.parse(raw);
      for (const council of config.councils) {
        for (const member of council.members) {
          if (!member.enabled) continue; // 与 loadRolePrompts 一致：只加载启用成员
          const p = path.resolve(configDir, member.rolePromptPath);
          await readFile(p, "utf8"); // 不可读则抛错使测试失败
          checked.push(`${council.id}:${member.id}`);
        }
        if (council.enabled && council.moderator !== undefined) {
          const p = path.resolve(configDir, council.moderator.rolePromptPath);
          await readFile(p, "utf8");
          checked.push(`${council.id}:moderator`);
        }
      }
    }
    // 覆盖成员与主持提示词（world/character 成员 + world/character 主持）
    expect(checked).toContain("world:moderator");
    expect(checked).toContain("character:character-psychology");
    expect(checked.length).toBeGreaterThanOrEqual(8);
  });
});

describe("examples mock 端到端冒烟（in-process CLI，cwd=仓库根）", () => {
  it("旧阶段 1 单成员 mock 配置：quick 成功，councilReports 为空（兼容回归）", async () => {
    const { io, out } = captureIo();
    const code = await main(
      [
        "simulate",
        "--packet", exampleRel("scene-packet.example.json"),
        "--config", exampleRel("councils.mock.example.json"),
        "--allow-mock"
      ],
      io
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out()) as {
      ok: boolean;
      report: { mode: string; stats: { totalCalls: number } } | null;
      memberReports: unknown[];
      councilReports: unknown[];
      warnings: string[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.report?.mode).toBe("quick");
    expect(envelope.memberReports).toHaveLength(2);
    expect(envelope.report?.stats.totalCalls).toBe(2);
    expect(envelope.councilReports).toEqual([]);
    expect(envelope.warnings).toEqual([]);
  });

  it("quick 多成员：3 份成员报告；配置了主持的启用组逐组 warning 且不调用主持", async () => {
    const { io, out } = captureIo();
    const code = await main(
      [
        "simulate",
        "--packet", exampleRel("scene-packet.example.json"),
        "--config", exampleRel("councils.standard-mock.example.json"),
        "--allow-mock"
      ],
      io
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out()) as {
      ok: boolean;
      report: { mode: string; stats: { totalCalls: number } } | null;
      memberReports: Array<{ status: string }>;
      councilReports: unknown[];
      warnings: string[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.report?.mode).toBe("quick");
    expect(envelope.memberReports).toHaveLength(3);
    expect(envelope.memberReports.every((m) => m.status === "ok")).toBe(true);
    expect(envelope.report?.stats.totalCalls).toBe(3); // 主持零调用
    expect(envelope.councilReports).toEqual([]);
    expect(envelope.warnings).toEqual([moderatorSkippedQuickWarning("world")]);
  });

  it("standard：world 主持成功（fallbackUsed=false），character 单成员规则回退不告警", async () => {
    const { io, out } = captureIo();
    const code = await main(
      [
        "simulate",
        "--packet", exampleRel("scene-packet.example.json"),
        "--config", exampleRel("councils.standard-mock.example.json"),
        "--allow-mock",
        "--mode", "standard"
      ],
      io
    );
    expect(code).toBe(0);
    const envelope = JSON.parse(out()) as {
      ok: boolean;
      report: { mode: string; degraded: boolean; stats: { totalCalls: number } } | null;
      councilReports: Array<{
        councilId: string;
        fallbackUsed: boolean;
        moderatorMemberId: string;
        summary: string;
        sourceMemberIds: string[];
      }>;
      warnings: string[];
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.report?.mode).toBe("standard");
    expect(envelope.report?.degraded).toBe(false);
    expect(envelope.report?.stats.totalCalls).toBe(4); // 3 成员 + 1 主持
    expect(envelope.councilReports).toHaveLength(2);
    const world = envelope.councilReports.find((c) => c.councilId === "world");
    const character = envelope.councilReports.find((c) => c.councilId === "character");
    expect(world?.fallbackUsed).toBe(false);
    expect(world?.moderatorMemberId).toBe("moderator"); // 内联主持
    expect(world?.sourceMemberIds).toEqual(["world-causality", "world-conditions"]); // 按 memberId 升序
    expect(world?.summary.length).toBeGreaterThan(0); // mock 主持输出被采用
    expect(character?.fallbackUsed).toBe(true); // 单有效成员跳过主持的规则回退
    expect(character?.moderatorMemberId).toBe("");
    expect(envelope.warnings).toEqual([]); // 主持成功 + 单成员跳过均不告警
  });

  it("deep：零调用 CONFIG_INVALID，退出码 1，信封 ok:false", async () => {
    const { io, out } = captureIo();
    const code = await main(
      [
        "simulate",
        "--packet", exampleRel("scene-packet.example.json"),
        "--config", exampleRel("councils.standard-mock.example.json"),
        "--allow-mock",
        "--mode", "deep"
      ],
      io
    );
    expect(code).toBe(1);
    const envelope = JSON.parse(out()) as {
      ok: boolean;
      error?: { code: string; message: string };
      memberReports: unknown[];
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("CONFIG_INVALID");
    expect(envelope.error?.message).toContain("阶段 3");
    expect(envelope.memberReports).toEqual([]); // 零调用
  });
});

describe("check-config estimate 与 README 文档值一致（注入非敏感测试 env，无网络）", () => {
  const CASES: Array<{
    file: string;
    mode?: string;
    memberCount: number;
    minCalls: number;
    maxCalls: number;
    maxTotalCalls: number;
    budgetCoverage: string;
    minModeratorCalls: number;
    maxModeratorCalls: number;
  }> = [
    { file: "councils.example.json", memberCount: 2, minCalls: 2, maxCalls: 6, maxTotalCalls: 4, budgetCoverage: "covers-min", minModeratorCalls: 0, maxModeratorCalls: 0 },
    { file: "councils.multi-quick.example.json", memberCount: 3, minCalls: 3, maxCalls: 9, maxTotalCalls: 9, budgetCoverage: "covers-max", minModeratorCalls: 0, maxModeratorCalls: 0 },
    { file: "councils.standard-usemember.example.json", mode: "standard", memberCount: 3, minCalls: 4, maxCalls: 12, maxTotalCalls: 12, budgetCoverage: "covers-max", minModeratorCalls: 1, maxModeratorCalls: 3 },
    { file: "councils.standard-usemember.example.json", memberCount: 3, minCalls: 3, maxCalls: 9, maxTotalCalls: 12, budgetCoverage: "covers-max", minModeratorCalls: 0, maxModeratorCalls: 0 }, // quick 恒不计主持
    { file: "councils.standard-inline-moderator.example.json", mode: "standard", memberCount: 3, minCalls: 4, maxCalls: 12, maxTotalCalls: 12, budgetCoverage: "covers-max", minModeratorCalls: 1, maxModeratorCalls: 3 },
    { file: "councils.disabled-council.example.json", memberCount: 1, minCalls: 1, maxCalls: 3, maxTotalCalls: 4, budgetCoverage: "covers-max", minModeratorCalls: 0, maxModeratorCalls: 0 },
    { file: "councils.standard-mock.example.json", mode: "standard", memberCount: 3, minCalls: 4, maxCalls: 12, maxTotalCalls: 12, budgetCoverage: "covers-max", minModeratorCalls: 1, maxModeratorCalls: 3 }
  ];

  for (const c of CASES) {
    it(`${c.file}（${c.mode ?? "quick"}）→ min ${c.minCalls} / max ${c.maxCalls} / ${c.budgetCoverage}`, async () => {
      const { io, out } = captureIo();
      const args = ["check-config", "--config", exampleRel(c.file)];
      if (c.mode !== undefined) args.push("--mode", c.mode);
      const code = await main(args, io);
      expect(code).toBe(0);
      const envelope = JSON.parse(out()) as {
        ok: boolean;
        issues: string[];
        estimate?: {
          memberCount: number;
          minCalls: number;
          maxCalls: number;
          maxTotalCalls: number;
          budgetCoverage: string;
          breakdown: { minModeratorCalls: number; maxModeratorCalls: number };
        };
      };
      expect(envelope.ok, `${c.file} 在测试 env 下应无 issues：${envelope.issues.join("; ")}`).toBe(true);
      expect(envelope.estimate?.memberCount).toBe(c.memberCount);
      expect(envelope.estimate?.minCalls).toBe(c.minCalls);
      expect(envelope.estimate?.maxCalls).toBe(c.maxCalls);
      expect(envelope.estimate?.maxTotalCalls).toBe(c.maxTotalCalls);
      expect(envelope.estimate?.budgetCoverage).toBe(c.budgetCoverage);
      expect(envelope.estimate?.breakdown.minModeratorCalls).toBe(c.minModeratorCalls);
      expect(envelope.estimate?.breakdown.maxModeratorCalls).toBe(c.maxModeratorCalls);
      // 密钥占位值永不进入 stdout
      expect(out()).not.toContain("TEST-PLACEHOLDER");
    });
  }
});
