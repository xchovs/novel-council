import {
  CoreError,
  SimulateOptionsSchema,
  type CouncilConfig,
  type CouncilReport,
  type CouncilResult,
  type CoreErrorJson,
  type FinalCouncilReport,
  type MemberConfig,
  type MemberReport,
  type RunStats,
  type ScenePacket
} from "../../contracts/index.js";
import { MockProvider, type MockStep } from "../../providers/mock.js";
import { OpenAICompatibleProvider } from "../../providers/openai-compatible.js";
import type { ProviderAdapter } from "../../providers/types.js";
import { CallBudget } from "../budget/budget.js";
import { estimateCalls } from "../budget/estimate.js";
import { getCouncilKind, knownCouncilIds } from "../council-kinds/council-kinds.js";
import { runMember } from "../council-runner/council-runner.js";
import { safeEmit, type ProgressHandler } from "../events/emit.js";
import { toCoreError } from "../errors/core-error.js";
import {
  DEEP_MODE_UNSUPPORTED_MESSAGE,
  moderatorFailedWarning,
  moderatorSkippedQuickWarning
} from "./execution-modes.js";
import {
  fallbackCouncilReport,
  resolveModeratorConfig,
  runModerator,
  type ResolvedModeratorConfig
} from "../moderator-runner/moderator-runner.js";
import { createRedactor, type Redactor } from "../redaction/redact.js";
import { mergeReports } from "../report-merger/merge.js";
import { summarizeIssues, validateCouncilConfig, validateScenePacket } from "../validation/validate.js";

/**
 * core/orchestrator：simulateScene 主流程（阶段 2：多成员第一轮 + standard 组内主持，D23/D25/D31）。
 * 校验 → council 形态校验（checkCouncilShape）→ packet 体积总预检 → provider/密钥解析（注册 redactor）
 * → 每组全部启用成员并发执行（allSettled 语义，全局上限 concurrency）→ 组级判定（council-end）
 * → standard：每组 0–1 次主持汇总（moderator-end；失败回退规则化 CouncilReport，成员报告不丢）
 * → 规则化合并（FinalCouncilReport 唯一生产者，主持不介入，C16）。
 * 第一轮成员输入相互隔离：成员只收到 packet 与自己的 rolePrompt，看不到任何其他成员输出。
 * 主持输入只含本组有效成员输出与失败成员 id 列表：无跨组信息泄漏通道。
 * core 为纯计算：不做任何文件 IO（D7/D22）。
 */

export interface SimulateInput {
  /** 未校验数据，core 内部经 zod 校验（调用方可先经 validateScenePacket 预检）。 */
  packet: unknown;
  /** 未校验数据，core 内部经 zod 校验。 */
  config: unknown;
  /** SimulateOptions：mode 缺省 quick；quick/standard 可运行，deep 显式 CONFIG_INVALID（D24，C4）。 */
  options?: unknown;
  /** `${councilId}:${memberId}` → 角色提示词内容（由 CLI 读文件内联传入，D22/C18）；主持提示词键 `${councilId}:moderator`（D31）。 */
  rolePrompts?: Record<string, string>;
  env?: Record<string, string | undefined>;
  onProgress?: ProgressHandler;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  runId?: string;
}

/** CLI simulate 的 stdout/--output 输出信封（D20；councilReports 为 C5 新增，quick 恒空数组）。 */
export interface SimulateResult {
  ok: boolean;
  report: FinalCouncilReport | null;
  memberReports: MemberReport[];
  councilResults: CouncilResult[];
  /** 组内主持汇总（standard 每组 ok 一条；quick / 组 insufficient / disabled / 零启用成员时无该组条目）。 */
  councilReports: CouncilReport[];
  warnings: string[];
  error?: CoreErrorJson;
}

export async function simulateScene(input: SimulateInput): Promise<SimulateResult> {
  const now = input.now ?? (() => new Date());
  const started = now();
  const runId = input.runId ?? globalThis.crypto.randomUUID();
  const env = input.env ?? process.env;
  const warnings: string[] = [];

  const failRun = (
    error: CoreError,
    memberReports: MemberReport[] = [],
    councilResults: CouncilResult[] = []
  ): SimulateResult => ({
    ok: false,
    report: null,
    memberReports,
    councilResults,
    councilReports: [],
    warnings,
    error: error.toJSON()
  });

  // 1. 契约校验
  const packetV = validateScenePacket(input.packet);
  if (!packetV.ok) return failRun(new CoreError("PACKET_INVALID", `ScenePacket 校验失败：${packetV.issues}`));
  const packet: ScenePacket = packetV.value;

  const optionsV = SimulateOptionsSchema.safeParse(input.options ?? undefined);
  if (!optionsV.success) {
    return failRun(new CoreError("CONFIG_INVALID", `SimulateOptions 校验失败：${summarizeIssues(optionsV.error)}`));
  }
  const mode = optionsV.data.mode;
  // D24：deep 契约可解析但阶段 2 不支持——显式 CONFIG_INVALID，在任何调用与预估之前拒绝（零调用）
  if (mode === "deep") {
    return failRun(new CoreError("CONFIG_INVALID", DEEP_MODE_UNSUPPORTED_MESSAGE));
  }

  const configV = validateCouncilConfig(input.config);
  if (!configV.ok) return failRun(new CoreError("CONFIG_INVALID", `CouncilConfig 校验失败：${configV.issues}`));
  const config: CouncilConfig = configV.value;

  // 2. council 形态校验（两组齐全 / 未知组拒绝 / id 唯一；每组允许多个启用成员）
  const shapeIssues = checkCouncilShape(config);
  if (shapeIssues.length > 0) {
    return failRun(new CoreError("CONFIG_INVALID", `评议组形态校验未通过：${shapeIssues.join("；")}`));
  }

  // 3. packet 体积总预检（D8：超限不发起任何调用，禁止静默截断）
  const packetChars = JSON.stringify(packet).length;
  if (packetChars > config.limits.maxInputChars) {
    return failRun(
      new CoreError(
        "PACKET_TOO_LARGE",
        `ScenePacket 序列化 ${packetChars} 字符，超过 maxInputChars=${config.limits.maxInputChars}`
      )
    );
  }

  // 3.5 确定性调用数预估（D26/A32：纯函数只读，不读 env；C5 起 standard 含主持计划计数，D31）
  const estimate = estimateCalls(config, mode);
  // below-min（maxTotalCalls < minCalls）= 必然不足：告警但不拒绝、不隐式修改预算（A32）；
  // covers-min（不覆盖重试上界）属正常配置，不告警
  if (estimate.budgetCoverage === "below-min") {
    warnings.push(
      `调用预算预估不足：计划最小调用 ${estimate.minCalls} 次超过 maxTotalCalls=${estimate.maxTotalCalls}` +
        `（单成员加法上限 ${estimate.perMemberMaxCalls}，理论上限 ${estimate.maxCalls} 次）；` +
        `运行将继续，既有预算闸可能提前截断成员调用（BUDGET_EXCEEDED），预算值不被隐式修改`
    );
  }

  // 4. 收集任务并解析 provider / 密钥（密钥立即注册 redactor，D12/D18；主持连接配置同步解析，D25）
  const redactorSecrets: string[] = [];
  const planned: PlannedMember[] = [];
  const plannedModerators: PlannedModerator[] = [];
  const councilResults: CouncilResult[] = [];

  for (const council of config.councils) {
    if (!council.enabled) {
      councilResults.push({ councilId: council.id, status: "insufficient" });
      warnings.push(`评议组 ${council.id} 未启用，按 insufficient 处理`);
      continue;
    }
    // 阶段 2：每组全部启用成员参与第一轮独立推演
    const enabledMembers = council.members.filter((m) => m.enabled);
    if (enabledMembers.length === 0) {
      councilResults.push({ councilId: council.id, status: "insufficient" });
      warnings.push(`评议组 ${council.id} 无启用成员，按 insufficient 处理`);
      continue;
    }
    for (const member of enabledMembers) {
      planned.push({ councilId: council.id, member, ...resolveProvider(council.id, member, env, input.fetchImpl, redactorSecrets) });
    }
    // 组内主持：配置存在时同步解析连接配置（env 缺失 → preError，运行时回退并告警，不发起调用）
    if (council.moderator !== undefined) {
      const resolved = resolveModeratorConfig(council);
      if (resolved !== undefined) {
        plannedModerators.push({
          councilId: council.id,
          resolved,
          ...resolveProvider(council.id, toConnectionConfig(resolved), env, input.fetchImpl, redactorSecrets)
        });
      }
    }
  }

  const redact = createRedactor(redactorSecrets);
  const budget = new CallBudget(config.budget.maxTotalCalls);
  const memberReports: MemberReport[] = [];

  const runnable: Array<PlannedMember & { provider: ProviderAdapter }> = [];
  for (const p of planned) {
    if (p.preError !== undefined) {
      memberReports.push(preFailedReport(runId, p.councilId, p.member, p.preError, redact));
    } else if (p.provider !== undefined) {
      runnable.push({ councilId: p.councilId, member: p.member, provider: p.provider });
    }
  }

  safeEmit(input.onProgress, { type: "run-start", runId, memberIds: runnable.map((p) => p.member.id) });

  // 5. 并发执行（Promise.allSettled 语义：单成员失败不取消其他成员）
  const tasks = runnable.map((p) => async (): Promise<MemberReport> => {
    const report = await runMember({
      runId,
      councilId: p.councilId,
      member: p.member,
      provider: p.provider,
      packet,
      rolePrompt:
        input.rolePrompts?.[`${p.councilId}:${p.member.id}`] ?? input.rolePrompts?.[p.member.id] ?? "",
      maxInputChars: config.limits.maxInputChars,
      maxRetries: config.budget.maxRetriesPerCall,
      maxTransportRetries: config.budget.maxTransportRetries,
      budget,
      redact,
      now,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {})
    });
    safeEmit(input.onProgress, {
      type: "member-end",
      runId,
      councilId: report.councilId,
      memberId: report.memberId,
      status: report.status,
      latencyMs: report.latencyMs
    });
    return report;
  });
  const settled = await runPool(tasks, config.budget.concurrency);
  for (const s of settled) {
    if (s.status === "fulfilled") {
      memberReports.push(s.value);
    } else {
      // runMember 设计上不 reject；防御性兜底，不让单点异常拖垮全局
      memberReports.push(internalFailureReport(runId, s.reason, redact));
    }
  }

  // 6. 组级有效成员判定 + council-end（含 disabled/insufficient 组；主持之前逐组发射）
  for (const council of config.councils) {
    if (!council.enabled) continue; // 已登记 insufficient
    const reports = memberReports.filter((m) => m.councilId === council.id);
    const validCount = reports.filter((m) => m.status === "ok" || m.status === "repaired").length;
    councilResults.push({
      councilId: council.id,
      status: validCount >= council.minValidMembers ? "ok" : "insufficient"
    });
  }
  for (const council of config.councils) {
    const entry = councilResults.find((c) => c.councilId === council.id);
    const validMemberCount = council.enabled
      ? memberReports.filter((m) => m.councilId === council.id && (m.status === "ok" || m.status === "repaired")).length
      : 0;
    safeEmit(input.onProgress, {
      type: "council-end",
      runId,
      councilId: council.id,
      status: entry?.status ?? "insufficient",
      validMemberCount
    });
  }

  // 6.5 组内主持阶段（D25/D31）：
  // - quick：不调用（配置了 moderator 的启用组逐组注入跳过 warning + moderator-end skipped）；
  // - standard：每组 ok 且 ≥2 有效成员且已配置 moderator → 0–1 次主持调用；
  //   未配置 / 单有效成员 → 规则回退（fallbackUsed=true，不告警）；组 insufficient/disabled → 不产报告；
  //   主持最终失败 → 回退并告警、degraded（主持身份保留于 moderatorMemberId）。
  const councilReports: CouncilReport[] = [];
  let moderatorFailed = false;

  if (mode === "quick") {
    for (const council of config.councils) {
      if (!council.enabled || council.moderator === undefined) continue;
      warnings.push(moderatorSkippedQuickWarning(council.id));
      safeEmit(input.onProgress, {
        type: "moderator-end",
        runId,
        councilId: council.id,
        moderatorMemberId: council.moderator.useMember ?? "moderator",
        status: "skipped",
        latencyMs: 0
      });
    }
  } else {
    for (const council of config.councils) {
      if (!council.enabled) continue;
      const entry = councilResults.find((c) => c.councilId === council.id);
      if (entry?.status !== "ok") continue; // 组 insufficient：不伪造汇总（规划 §13.3，D31）

      const reports = memberReports.filter((m) => m.councilId === council.id);
      const valid = reports.filter(
        (m): m is MemberReport & { output: NonNullable<MemberReport["output"]> } =>
          (m.status === "ok" || m.status === "repaired") && m.output !== null
      );
      const failedMemberIds = reports
        .filter((m) => m.status === "failed")
        .map((m) => m.memberId)
        .sort();

      // 单有效成员：跳过主持调用（规划 §9.3 单成员省略，D31），规则回退不告警
      if (valid.length < 2) {
        if (council.moderator !== undefined) {
          safeEmit(input.onProgress, {
            type: "moderator-end",
            runId,
            councilId: council.id,
            moderatorMemberId: council.moderator.useMember ?? "moderator",
            status: "skipped",
            latencyMs: 0
          });
        }
        councilReports.push(fallbackCouncilReport({ councilId: council.id, validReports: valid, moderatorMemberId: "" }));
        continue;
      }

      // 未配置主持：规则回退，不告警（A34）
      if (council.moderator === undefined) {
        councilReports.push(fallbackCouncilReport({ councilId: council.id, validReports: valid, moderatorMemberId: "" }));
        continue;
      }

      const plannedMod = plannedModerators.find((p) => p.councilId === council.id);
      if (plannedMod === undefined) continue; // 防御：schema 已保证可解析
      const moderatorMemberId = plannedMod.resolved.moderatorMemberId;

      // 预解析失败（ENV_KEY_MISSING 等）：零调用回退 + 告警
      if (plannedMod.preError !== undefined || plannedMod.provider === undefined) {
        const err =
          plannedMod.preError ?? new CoreError("INTERNAL", "主持 provider 解析失败", { councilId: council.id });
        moderatorFailed = true;
        warnings.push(moderatorFailedWarning(council.id, err.code, redact(err.message)));
        councilReports.push(fallbackCouncilReport({ councilId: council.id, validReports: valid, moderatorMemberId }));
        safeEmit(input.onProgress, {
          type: "moderator-end",
          runId,
          councilId: council.id,
          moderatorMemberId,
          status: "failed",
          latencyMs: 0
        });
        continue;
      }

      const outcome = await runModerator({
        councilId: council.id,
        moderator: plannedMod.resolved,
        provider: plannedMod.provider,
        packet,
        rolePrompt: input.rolePrompts?.[`${council.id}:moderator`] ?? "",
        validReports: valid,
        failedMemberIds,
        maxInputChars: config.limits.maxInputChars,
        maxRetries: config.budget.maxRetriesPerCall,
        maxTransportRetries: config.budget.maxTransportRetries,
        budget,
        redact,
        now
      });
      if (outcome.error !== null) {
        moderatorFailed = true;
        warnings.push(moderatorFailedWarning(council.id, outcome.error.code, outcome.error.message));
      }
      councilReports.push(outcome.report);
      safeEmit(input.onProgress, {
        type: "moderator-end",
        runId,
        councilId: council.id,
        moderatorMemberId,
        status: outcome.error === null ? "ok" : "failed",
        latencyMs: outcome.latencyMs
      });
    }
  }

  // 7. 运行统计（在主持阶段之后计算：totalCalls 含主持调用，D26）
  const stats: RunStats = {
    totalCalls: budget.used,
    succeeded: memberReports.filter((m) => m.status === "ok" || m.status === "repaired").length,
    failed: memberReports.filter((m) => m.status === "failed").length,
    repaired: memberReports.filter((m) => m.status === "repaired").length,
    durationMs: Math.max(0, now().getTime() - started.getTime()),
    budgetExceeded: budget.exceeded
  };

  // 8. 两组均 insufficient → ALL_COUNCILS_FAILED；保留成员报告，不伪造汇总（A05）
  if (councilResults.every((c) => c.status === "insufficient")) {
    safeEmit(input.onProgress, { type: "run-end", runId, ok: false, stats });
    const err = new CoreError("ALL_COUNCILS_FAILED", "所有评议组均无有效成员结果，无法形成评议");
    return {
      ok: false,
      report: null,
      memberReports,
      councilResults,
      councilReports,
      warnings,
      error: { ...err.toJSON(), message: redact(err.message) }
    };
  }

  // 9. 规则化合并（不调 LLM；FinalCouncilReport 唯一生产者，主持不介入，D25/C16）
  const report = mergeReports({
    runId,
    packet,
    memberReports,
    councilResults,
    stats,
    maxReportChars: config.limits.maxReportChars,
    now,
    mode,
    moderatorFailed
  });
  safeEmit(input.onProgress, { type: "run-end", runId, ok: true, stats });
  return { ok: true, report, memberReports, councilResults, councilReports, warnings };
}

/**
 * 阶段 2 council 形态校验（D23 / C14）：
 * world 与 character 两组必须存在；未知 council id 拒绝；
 * council id 不重复；组内 member id 不重复；每组允许多个启用成员。
 */
export function checkCouncilShape(config: CouncilConfig): string[] {
  const issues: string[] = [];
  const ids = config.councils.map((c) => c.id);
  for (const required of knownCouncilIds()) {
    if (!ids.includes(required)) issues.push(`缺少评议组 ${required}`);
  }
  const seenCouncils = new Set<string>();
  for (const c of config.councils) {
    if (getCouncilKind(c.id) === undefined) {
      issues.push(`未知评议组 "${c.id}"（仅支持 ${knownCouncilIds().join("/")}）`);
    }
    if (seenCouncils.has(c.id)) issues.push(`评议组 id 重复：${c.id}`);
    seenCouncils.add(c.id);
    const seenMembers = new Set<string>();
    for (const m of c.members) {
      if (seenMembers.has(m.id)) issues.push(`评议组 ${c.id} 内成员 id 重复：${m.id}`);
      seenMembers.add(m.id);
    }
  }
  return issues;
}

/** provider 连接配置的最小结构（成员与主持共用解析入口，D25/D31）。 */
interface ConnectionConfig {
  id: string;
  provider: "openai-compatible" | "mock";
  baseUrlEnv?: string;
  apiKeyEnv?: string;
  extraHeadersEnv: Record<string, string>;
  mockResponses?: string[];
}

/** 主持解析结果 → 连接配置（显式字段拷贝，避免多余字段流入 provider 层）。 */
function toConnectionConfig(resolved: ResolvedModeratorConfig): ConnectionConfig {
  return {
    id: resolved.moderatorMemberId,
    provider: resolved.provider,
    ...(resolved.baseUrlEnv !== undefined ? { baseUrlEnv: resolved.baseUrlEnv } : {}),
    ...(resolved.apiKeyEnv !== undefined ? { apiKeyEnv: resolved.apiKeyEnv } : {}),
    extraHeadersEnv: resolved.extraHeadersEnv,
    ...(resolved.mockResponses !== undefined ? { mockResponses: resolved.mockResponses } : {})
  };
}

interface PlannedMember {
  councilId: string;
  member: MemberConfig;
  provider?: ProviderAdapter;
  preError?: CoreError;
}

interface PlannedModerator {
  councilId: string;
  resolved: ResolvedModeratorConfig;
  provider?: ProviderAdapter;
  preError?: CoreError;
}

function resolveProvider(
  councilId: string,
  conn: ConnectionConfig,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch | undefined,
  redactorSecrets: string[]
): { provider?: ProviderAdapter; preError?: CoreError } {
  if (conn.provider === "mock") {
    const steps: MockStep[] = (conn.mockResponses ?? []).map((text) => ({ kind: "text", text }));
    return { provider: new MockProvider(steps) };
  }

  const baseUrl = conn.baseUrlEnv !== undefined ? env[conn.baseUrlEnv] : undefined;
  const apiKey = conn.apiKeyEnv !== undefined ? env[conn.apiKeyEnv] : undefined;
  const extraHeaders: Record<string, string> = {};
  const missing: string[] = [];
  if (baseUrl === undefined || baseUrl === "") missing.push(conn.baseUrlEnv ?? "baseUrlEnv");
  if (apiKey === undefined || apiKey === "") missing.push(conn.apiKeyEnv ?? "apiKeyEnv");
  for (const [headerName, envName] of Object.entries(conn.extraHeadersEnv)) {
    const v = env[envName];
    if (v === undefined || v === "") {
      missing.push(envName);
    } else {
      extraHeaders[headerName] = v;
      redactorSecrets.push(v);
    }
  }
  if (missing.length > 0) {
    return {
      preError: new CoreError("ENV_KEY_MISSING", `环境变量未设置：${missing.join(", ")}`, {
        memberId: conn.id,
        councilId
      })
    };
  }
  redactorSecrets.push(apiKey as string);
  return {
    provider: new OpenAICompatibleProvider({
      baseUrl: baseUrl as string,
      apiKey: apiKey as string,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      extraHeaders
    })
  };
}

function preFailedReport(
  runId: string,
  councilId: string,
  member: MemberConfig,
  error: CoreError,
  redact: Redactor
): MemberReport {
  return {
    reportId: `${runId}:${councilId}:${member.id}`,
    runId,
    councilId,
    memberId: member.id,
    status: "failed",
    latencyMs: 0,
    attempts: 0,
    error: { ...error.toJSON(), message: redact(error.message) },
    output: null
  };
}

function internalFailureReport(runId: string, reason: unknown, redact: Redactor): MemberReport {
  const err = toCoreError(reason, "INTERNAL");
  return {
    reportId: `${runId}:internal:unknown`,
    runId,
    councilId: "internal",
    memberId: "unknown",
    status: "failed",
    latencyMs: 0,
    attempts: 0,
    error: { ...err.toJSON(), message: redact(err.message) },
    output: null
  };
}

/** 极简并发池：allSettled 语义，上限 limit（D10：quick=2）。 */
async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      const task = tasks[i];
      if (task === undefined) continue;
      try {
        results[i] = { status: "fulfilled", value: await task() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
