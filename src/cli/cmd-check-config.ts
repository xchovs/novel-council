import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CoreError,
  CouncilConfigSchema,
  ExecutionModeSchema,
  type CouncilConfig,
  type ExecutionMode
} from "../contracts/index.js";
import { exitCodeFor } from "../core/errors/core-error.js";
import { checkConfig, type ConfigCheckResult } from "../core/orchestrator/check-config.js";
import type { CliFlags, CliIo } from "./bin.js";

/**
 * CLI check-config（D20）：输出独立检查结果信封到 stdout；永不输出密钥值。
 * promptFileReadable 由本层填充（core 无文件 IO，D22）。
 * C4：--mode 选择预估模式（缺省 quick）；信封 estimate 为确定性调用数预估（A32）。
 */
export async function runCheckConfig(flags: CliFlags, io: CliIo): Promise<number> {
  try {
    const configPath = path.resolve(io.cwd, flags.config as string);
    const configRaw = await readJsonFile(configPath);
    const mode = parseModeFlag(flags.mode);

    const parsed = CouncilConfigSchema.safeParse(configRaw);
    if (!parsed.success) {
      const envelope: ConfigCheckResult = {
        ok: false,
        configVersion: "1.0",
        members: [],
        issues: [
          `CouncilConfig 校验失败：${parsed.error.issues
            .slice(0, 8)
            .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        ]
      };
      io.stdout(JSON.stringify(envelope) + "\n");
      return 1;
    }

    const checked = checkConfig(parsed.data, io.env, mode);
    const result = await fillPromptReadability(parsed.data, path.dirname(configPath), checked);

    io.stdout(JSON.stringify(result) + "\n");
    // below-min = 必然不足：stderr 告警（不改变信封与退出码，不拒绝，A32/D26）
    if (result.estimate?.budgetCoverage === "below-min") {
      io.stderr(
        `警告：调用预算预估不足（minCalls=${result.estimate.minCalls} > maxTotalCalls=${result.estimate.maxTotalCalls}）\n`
      );
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    const err =
      e instanceof CoreError ? e : new CoreError("INTERNAL", e instanceof Error ? e.message : String(e));
    io.stderr(`错误 [${err.code}] ${err.message}\n`);
    return exitCodeFor(err.code);
  }
}

/** --mode 解析：非法取值 → CONFIG_INVALID（用法错误走 stderr）；缺省 quick。 */
function parseModeFlag(raw: string | undefined): ExecutionMode {
  if (raw === undefined) return "quick";
  const parsed = ExecutionModeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CoreError("CONFIG_INVALID", `--mode 仅支持 quick/standard/deep，收到："${raw}"`);
  }
  return parsed.data;
}

async function fillPromptReadability(
  config: CouncilConfig,
  configDir: string,
  result: ConfigCheckResult
): Promise<ConfigCheckResult> {
  for (const member of result.members) {
    const m = config.councils
      .find((c) => c.id === member.councilId)
      ?.members.find((x) => x.id === member.memberId);
    if (m === undefined) continue;
    const promptPath = path.resolve(configDir, m.rolePromptPath);
    try {
      await readFile(promptPath, "utf8");
      member.promptFileReadable = true;
    } catch {
      member.promptFileReadable = false;
      member.issues.push(`角色提示词不可读：${m.rolePromptPath}`);
    }
  }
  // 填充后重算 ok（本步只增 issues，不会把 false 翻回 true）；ok 判别联合：ok:true 必携带 estimate
  const ok = result.issues.length === 0 && result.members.every((m) => m.issues.length === 0);
  const base = { configVersion: result.configVersion, members: result.members, issues: result.issues };
  if (ok && result.estimate !== undefined) return { ...base, ok: true, estimate: result.estimate };
  if (result.estimate !== undefined) return { ...base, ok: false, estimate: result.estimate };
  return { ...base, ok: false };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    throw new CoreError("CONFIG_INVALID", `无法读取 config 文件：${filePath}`, { cause: e });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new CoreError("CONFIG_INVALID", `config 文件不是有效 JSON：${filePath}`, { cause: e });
  }
}
