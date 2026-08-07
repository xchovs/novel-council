import type { CouncilConfig, ExecutionMode } from "../../contracts/index.js";
import { estimateCalls, type CallEstimate } from "../budget/estimate.js";
import { resolveModeratorConfig } from "../moderator-runner/moderator-runner.js";
import { DEEP_MODE_UNSUPPORTED_MESSAGE } from "./execution-modes.js";
import { checkCouncilShape } from "./simulate-scene.js";


/**
 * core/orchestrator/check-config（architecture §6）。
 * 只输出 { provider, model, keyConfigured } 等状态，永不输出密钥值（D12）。
 * promptFileReadable 由 CLI 填充（core 无文件 IO，D22）。
 * C4：estimate 为 estimateCalls 的确定性预估（只读 config，不读 env）。
 */

export interface ConfigCheckMember {
  councilId: string;
  memberId: string;
  provider: string;
  model: string;
  baseUrlConfigured: boolean;
  keyConfigured: boolean;
  promptFileReadable?: boolean;
  issues: string[];
}

/** ok:true 分支：estimate 必然存在（C4 约束：成功结果的 estimate 不为 optional）。 */
export interface ConfigCheckOk {
  ok: true;
  configVersion: string;
  members: ConfigCheckMember[];
  issues: string[];
  estimate: CallEstimate;
}

/** ok:false 分支：可不携带 estimate（如 mode=deep 无法预估）。 */
export interface ConfigCheckFailed {
  ok: false;
  configVersion: string;
  members: ConfigCheckMember[];
  issues: string[];
  estimate?: CallEstimate;
}

/** ok 判别联合：经 result.ok  narrowing 后 estimate 的可见性随之确定。 */
export type ConfigCheckResult = ConfigCheckOk | ConfigCheckFailed;

export function checkConfig(
  config: CouncilConfig,
  env: Record<string, string | undefined>,
  mode: ExecutionMode = "quick"
): ConfigCheckResult {
  const issues = checkCouncilShape(config);
  const members: ConfigCheckMember[] = [];

  for (const council of config.councils) {
    for (const m of council.members) {
      const memberIssues: string[] = [];
      let baseUrlConfigured = true;
      let keyConfigured = true;

      if (m.provider === "openai-compatible") {
        baseUrlConfigured = m.baseUrlEnv !== undefined && isSet(env[m.baseUrlEnv]);
        keyConfigured = m.apiKeyEnv !== undefined && isSet(env[m.apiKeyEnv]);
        if (!baseUrlConfigured) {
          memberIssues.push(`baseUrl 环境变量未设置：${m.baseUrlEnv ?? "（baseUrlEnv 未配置）"}`);
        }
        if (!keyConfigured) {
          memberIssues.push(`API Key 环境变量未设置：${m.apiKeyEnv ?? "（apiKeyEnv 未配置）"}`);
        }
        for (const [headerName, envName] of Object.entries(m.extraHeadersEnv)) {
          if (!isSet(env[envName])) {
            memberIssues.push(`extraHeadersEnv["${headerName}"] 指向的环境变量未设置：${envName}`);
          }
        }
      }
      if (!m.enabled) memberIssues.push("成员未启用");

      members.push({
        councilId: council.id,
        memberId: m.id,
        provider: m.provider,
        model: m.model,
        baseUrlConfigured,
        keyConfigured,
        issues: memberIssues
      });
    }

    // C5（D25/D31）：组内主持的 env 可解析性检查（只报状态，永不输出密钥值）；
    // useMember 目标存在性/启用态与互斥已在 CouncilConfigSchema 层拒绝，此处只查 env
    if (council.moderator !== undefined) {
      const resolved = resolveModeratorConfig(council);
      if (resolved === undefined) {
        issues.push(`评议组 ${council.id} 主持配置无法解析（useMember 目标缺失或未启用）`);
      } else if (resolved.provider === "openai-compatible") {
        if (resolved.baseUrlEnv === undefined || !isSet(env[resolved.baseUrlEnv])) {
          issues.push(`评议组 ${council.id} 主持：baseUrl 环境变量未设置：${resolved.baseUrlEnv ?? "（未配置）"}`);
        }
        if (resolved.apiKeyEnv === undefined || !isSet(env[resolved.apiKeyEnv])) {
          issues.push(`评议组 ${council.id} 主持：API Key 环境变量未设置：${resolved.apiKeyEnv ?? "（未配置）"}`);
        }
        for (const [headerName, envName] of Object.entries(resolved.extraHeadersEnv)) {
          if (!isSet(env[envName])) {
            issues.push(`评议组 ${council.id} 主持：extraHeadersEnv["${headerName}"] 指向的环境变量未设置：${envName}`);
          }
        }
      }
    }
  }


  // C4：deep 无法预估（D24 显式拒绝，与 orchestrator 同一消息）；quick/standard 产出确定性 estimate
  let estimate: CallEstimate | undefined;
  if (mode === "deep") {
    issues.push(DEEP_MODE_UNSUPPORTED_MESSAGE);
  } else {
    estimate = estimateCalls(config, mode);
  }

  const base = { configVersion: config.configVersion, members, issues };
  if (issues.length === 0 && members.every((m) => m.issues.length === 0) && estimate !== undefined) {
    return { ...base, ok: true, estimate };
  }
  return estimate === undefined ? { ...base, ok: false } : { ...base, ok: false, estimate };
}

function isSet(v: string | undefined): boolean {
  return v !== undefined && v !== "";
}
