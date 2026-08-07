import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CoreError,
  CouncilConfigSchema,
  type CouncilConfig,
  type ProgressEvent
} from "../contracts/index.js";
import { exitCodeFor } from "../core/errors/core-error.js";
import { simulateScene, type SimulateResult } from "../core/orchestrator/simulate-scene.js";
import { createRedactor } from "../core/redaction/redact.js";
import { validateScenePacket } from "../core/validation/validate.js";
import type { CliFlags, CliIo } from "./bin.js";

/**
 * CLI simulate（D7/D16/D20/D21）：
 * - stdout 只输出完整 SimulateResult 信封 JSON；
 * - 进度（ProgressEvent）与错误走 stderr；
 * - mock 配置必须显式 --allow-mock；
 * - rolePromptPath 相对配置文件所在目录解析（D22）。
 */
export async function runSimulate(flags: CliFlags, io: CliIo): Promise<number> {
  const redact = createRedactor(collectSecretValues(io.env));
  try {
    // 1. 读取 packet / config
    const packetPath = path.resolve(io.cwd, flags.packet as string);
    const configPath = path.resolve(io.cwd, flags.config as string);
    const packetRaw = await readJsonFile(packetPath, "PACKET_INVALID", "packet");
    const configRaw = await readJsonFile(configPath, "CONFIG_INVALID", "config");

    // 2. 配置先行校验（mock 门禁需要 provider 信息）
    const configParsed = CouncilConfigSchema.safeParse(configRaw);
    if (!configParsed.success) {
      throw new CoreError("CONFIG_INVALID", `CouncilConfig 校验失败：${summarize(configParsed.error.issues)}`);
    }
    const config = configParsed.data;

    // 3. mock 门禁（D16）
    if (!flags.allowMock && hasEnabledMockMember(config)) {
      throw new CoreError(
        "MOCK_NOT_ALLOWED",
        "配置包含启用的 mock provider 成员（仅供测试，不产生真实推演）。如确需运行，请显式传入 --allow-mock。"
      );
    }

    // 4. packet 预校验（提供清晰的 CLI 错误；core 内部会再校验一次）
    const packetV = validateScenePacket(packetRaw);
    if (!packetV.ok) {
      throw new CoreError("PACKET_INVALID", `ScenePacket 校验失败：${packetV.issues}`);
    }

    // 5. 角色提示词内联（相对配置文件目录解析；core 零文件 IO）
    const rolePrompts = await loadRolePrompts(config, path.dirname(configPath));

    // 6. 运行（进度 → stderr；--mode 透传为 SimulateOptions，合法性由 core 契约 schema 统一判定）
    const onProgress = (e: ProgressEvent) => io.stderr(`${formatProgress(e)}\n`);
    const result: SimulateResult = await simulateScene({
      packet: packetRaw,
      config,
      rolePrompts,
      env: io.env,
      onProgress,
      ...(flags.mode !== undefined ? { options: { mode: flags.mode } } : {})
    });

    // 6.5 警告 → stderr（D21：stdout 信封不变；below-min 预算告警与 standard 边界提示对人可达）
    for (const w of result.warnings) {
      io.stderr(`警告：${redact(w)}\n`);
    }

    const json = JSON.stringify(result);

    // 7. --output 先写文件（失败 → OUTPUT_WRITE_FAILED，不写 stdout）
    if (flags.output !== undefined) {
      const outputPath = path.resolve(io.cwd, flags.output);
      try {
        await writeFile(outputPath, json + "\n", "utf8");
      } catch (e) {
        throw new CoreError("OUTPUT_WRITE_FAILED", `无法写入 --output 文件：${flags.output}`, { cause: e });
      }
    }

    // 8. stdout 只输出信封 JSON（D21）
    io.stdout(json + "\n");
    return result.ok ? 0 : exitCodeFor(result.error?.code ?? "INTERNAL");
  } catch (e) {
    const err =
      e instanceof CoreError ? e : new CoreError("INTERNAL", e instanceof Error ? e.message : String(e));
    io.stderr(`错误 [${err.code}] ${redact(err.message)}\n`);
    return exitCodeFor(err.code);
  }
}

function hasEnabledMockMember(config: CouncilConfig): boolean {
  return config.councils.some(
    (c) =>
      c.enabled &&
      (c.members.some((m) => m.enabled && m.provider === "mock") ||
        // 内联 mock 主持同样受 D16 门禁（D31）；useMember 指向 mock 成员时已被成员检查覆盖
        c.moderator?.provider === "mock")
  );
}


async function loadRolePrompts(config: CouncilConfig, configDir: string): Promise<Record<string, string>> {
  const prompts: Record<string, string> = {};
  for (const council of config.councils) {
    for (const member of council.members) {
      if (!member.enabled) continue;
      const promptPath = path.resolve(configDir, member.rolePromptPath);
      try {
        // 键 = ${councilId}:${memberId}（C18；core 侧接受裸 memberId 兜底以兼容旧调用）
        prompts[`${council.id}:${member.id}`] = await readFile(promptPath, "utf8");
      } catch (e) {
        throw new CoreError(
          "CONFIG_INVALID",
          `成员 ${council.id}:${member.id} 的角色提示词不可读：${member.rolePromptPath}`,
          { cause: e }
        );
      }
    }
    // 组内主持提示词（D25/D31）：键 = ${councilId}:moderator（无裸键兜底，避免跨组串键）；
    // 主持有自己的 rolePromptPath，不复用 useMember 目标成员的提示词
    if (council.enabled && council.moderator !== undefined) {
      const promptPath = path.resolve(configDir, council.moderator.rolePromptPath);
      try {
        prompts[`${council.id}:moderator`] = await readFile(promptPath, "utf8");
      } catch (e) {
        throw new CoreError(
          "CONFIG_INVALID",
          `评议组 ${council.id} 主持的角色提示词不可读：${council.moderator.rolePromptPath}`,
          { cause: e }
        );
      }
    }
  }
  return prompts;
}


async function readJsonFile(
  filePath: string,
  code: "PACKET_INVALID" | "CONFIG_INVALID",
  label: string
): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    throw new CoreError(code, `无法读取 ${label} 文件：${filePath}`, { cause: e });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new CoreError(code, `${label} 文件不是有效 JSON：${filePath}`, { cause: e });
  }
}

function formatProgress(e: ProgressEvent): string {
  switch (e.type) {
    case "run-start":
      return `[run ${e.runId}] 开始，成员：${e.memberIds.join(", ") || "（无可运行成员）"}`;
    case "member-retry": {
      const detail = e.httpStatus !== undefined ? `HTTP ${e.httpStatus}` : e.code;
      return `[run ${e.runId}] ${e.councilId}/${e.memberId} 传输错误（${detail}），重试中（第 ${e.attempt} 次调用）`;
    }
    case "member-end":
      return `[run ${e.runId}] ${e.councilId}/${e.memberId} → ${e.status}（${e.latencyMs}ms）`;
    case "council-end":
      return `[run ${e.runId}] 评议组 ${e.councilId} → ${e.status}（有效成员 ${e.validMemberCount}）`;
    case "moderator-end":
      return `[run ${e.runId}] 评议组 ${e.councilId} 主持（${e.moderatorMemberId}）→ ${e.status}（${e.latencyMs}ms）`;
    case "run-end":

      return `[run ${e.runId}] 结束 ok=${e.ok} calls=${e.stats.totalCalls} 用时=${e.stats.durationMs}ms`;
  }
}

function summarize(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** 从 env 收集可能被引用的密钥值（按常见命名），供 stderr 脱敏兜底。 */
function collectSecretValues(env: Record<string, string | undefined>): string[] {
  const secretNameRe = /(key|token|secret)/i;
  return Object.entries(env)
    .filter(([name, value]) => secretNameRe.test(name) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string);
}
