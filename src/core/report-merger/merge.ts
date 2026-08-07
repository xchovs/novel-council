import {
  type AlternativePlan,
  type CharacterMemberOutput,
  type CouncilResult,
  type FinalCouncilReport,
  type Finding,
  type MemberReport,
  type ProposedDelta,
  type RunStats,
  type ScenePacket,
  type Severity,
  type Verdict,
  type WorldMemberOutput
} from "../../contracts/index.js";
import { getCouncilKind } from "../council-kinds/council-kinds.js";

/**
 * core/report-merger：quick 模式规则化合并（不调 LLM，D10）。
 * - overallVerdict 推导（C5）；findings/alternativePlans 确定性映射（§6.1）；
 *   merger 不做语义归纳。
 * - 裁剪按 C6 优先级、完整字段/完整数组项粒度；任何情况输出有效 JSON（D9）。
 */

const SEVERITY_ORDER: Record<Severity, number> = { blocking: 0, warning: 1, info: 2 };

export interface MergeArgs {
  runId: string;
  packet: ScenePacket;
  memberReports: MemberReport[];
  councilResults: CouncilResult[];
  stats: RunStats;
  maxReportChars: number;
  now: () => Date;
  /** 执行模式（D24：阶段 2 仅 quick|standard；deep 在 orchestrator 被拒绝，不产生报告）。必填以防调用方漏传。 */
  mode: FinalCouncilReport["mode"];
  /**
   * standard 主持已配置但最终失败（D31，C5）：degraded 口径扩展。
   * 未配置主持 / 单有效成员跳过的规则回退不计入（否则 standard 无主持配置恒 degraded，语义失真）。
   */
  moderatorFailed?: boolean;
}


export function mergeReports(args: MergeArgs): FinalCouncilReport {
  const valid = args.memberReports.filter(
    (m): m is MemberReport & { output: NonNullable<MemberReport["output"]> } =>
      (m.status === "ok" || m.status === "repaired") && m.output !== null
  );

  const worldFindings: Finding[] = [];
  const characterFindings: Finding[] = [];
  const planStrengths: string[] = [];
  const alternativePlans: AlternativePlan[] = [];
  const uncertainHypotheses: string[] = [];
  const proposedDeltas: ProposedDelta[] = [];
  const questionsForMainModel: string[] = [];

  for (const m of valid) {
    const kind = getCouncilKind(m.councilId);
    if (kind === undefined) continue; // 防御：未知组不进入合并（orchestrator 已先行拒绝）
    if (kind.reportBucket === "worldFindings") {
      const out = m.output as WorldMemberOutput;
      pushAll(worldFindings, out.blockingConflicts, "blocking-conflict", "blocking", m.memberId);
      pushAll(worldFindings, out.invalidPremises, "invalid-premise", "warning", m.memberId);
      pushAll(
        worldFindings,
        out.resourceAndInstitutionConstraints,
        "resource-institution-constraint",
        "warning",
        m.memberId
      );
      pushAll(worldFindings, out.externalPressures, "external-pressure", "info", m.memberId);
      pushAll(worldFindings, out.informationFlow, "information-flow", "info", m.memberId);
      pushAll(worldFindings, out.offscreenEvents, "offscreen-event", "info", m.memberId);
      planStrengths.push(...out.validPremises);
      questionsForMainModel.push(...out.uncertainties);
      collectDeltas(out.proposedWorldDelta, proposedDeltas, uncertainHypotheses);
      pushAlternatives(alternativePlans, out.alternativeBeats, m.memberId);
    } else {
      const out = m.output as CharacterMemberOutput;
      pushAll(characterFindings, out.interactionConflicts, "interaction-conflict", "blocking", m.memberId);
      for (const cf of out.characterFindings) {
        pushAll(characterFindings, cf.unlikelyActions, `unlikely-action:${cf.name}`, "warning", m.memberId);
        pushAll(characterFindings, cf.knowledgeBoundary, `knowledge-boundary:${cf.name}`, "info", m.memberId);
        pushAll(characterFindings, cf.likelyActions, `likely-action:${cf.name}`, "info", m.memberId);
        pushAll(
          characterFindings,
          cf.conditionsForChange,
          `conditions-for-change:${cf.name}`,
          "info",
          m.memberId
        );
        uncertainHypotheses.push(...cf.hypothesizedHistory.map((h) => `${cf.name}: ${h}`));
        questionsForMainModel.push(...cf.uncertainties.map((u) => `${cf.name}: ${u}`));
      }
      collectDeltas(out.proposedCharacterDelta, proposedDeltas, uncertainHypotheses);
      pushAlternatives(alternativePlans, out.alternativeBeats, m.memberId);
    }
  }

  sortFindings(worldFindings);
  sortFindings(characterFindings);

  const degraded =
    args.councilResults.some((c) => c.status === "insufficient") ||
    args.memberReports.some((m) => m.status === "failed") ||
    args.moderatorFailed === true;


  const report: FinalCouncilReport = {
    schemaVersion: "1.0",
    runId: args.runId,
    sceneId: args.packet.sceneId,
    generatedAt: args.now().toISOString(),
    mode: args.mode,
    degraded,
    overallVerdict: deriveVerdict(valid.map((m) => (m.output as { verdict: Verdict }).verdict)),
    planStrengths,
    worldFindings,
    characterFindings,
    alternativePlans,
    uncertainHypotheses,
    proposedDeltas,
    questionsForMainModel,
    rawRefs: args.memberReports.map((m) => ({
      reportId: m.reportId,
      councilId: m.councilId,
      memberId: m.memberId,
      status: m.status
    })),
    stats: args.stats,
    truncation: { applied: false, droppedSections: [] }
  };

  return truncateReport(report, args.maxReportChars);
}

/** C5：全 accept→accept；有 revise 无 reject→revise；有 reject→reject；单侧直通。 */
export function deriveVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("reject")) return "reject";
  if (verdicts.includes("revise")) return "revise";
  return "accept";
}

function pushAll(
  target: Finding[],
  details: string[],
  topic: string,
  severity: Severity,
  memberId: string
): void {
  for (const detail of details) {
    target.push({ topic, detail, severity, sourceMemberIds: [memberId] });
  }
}

function pushAlternatives(target: AlternativePlan[], beats: string[], memberId: string): void {
  for (const summary of beats) {
    target.push({
      id: planId(target.length),
      summary,
      advantages: [],
      risks: [],
      requiredChanges: [],
      sourceMemberIds: [memberId]
    });
  }
}

function planId(index: number): string {
  // A..Z, AA..（quick 模式实际不超过个位数）
  const first = String.fromCharCode(65 + (index % 26));
  return index < 26 ? first : `${first}${Math.floor(index / 26)}`;
}

function collectDeltas(deltas: ProposedDelta[], target: ProposedDelta[], hypotheses: string[]): void {
  for (const d of deltas) {
    target.push(d);
    if (d.kind === "hypothesis") hypotheses.push(d.summary);
  }
}

function sortFindings(findings: Finding[]): void {
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * C6 裁剪：丢弃顺序 = 优先级反向（planStrengths → proposedDeltas →
 * questionsForMainModel / uncertainHypotheses → alternativePlans →
 * characterFindings / worldFindings 自最低 severity 起）。
 * 单位为完整字段或完整数组项；被裁部分记入 truncation.droppedSections。
 * 信封字段永不裁；极端情况下输出可能超过 maxReportChars，但恒为有效 JSON。
 */
export function truncateReport(report: FinalCouncilReport, maxReportChars: number): FinalCouncilReport {
  if (JSON.stringify(report).length <= maxReportChars) return report;

  const dropped: string[] = [];
  const r: FinalCouncilReport = { ...report, truncation: { applied: true, droppedSections: dropped } };
  const fits = (): boolean => JSON.stringify(r).length <= maxReportChars;

  const dropWholeField = (field: "planStrengths"): void => {
    if (r[field].length > 0) {
      dropped.push(`${field}（全部 ${r[field].length} 项）`);
      r[field] = [];
    }
  };
  const dropFromEnd = (
    field: "proposedDeltas" | "questionsForMainModel" | "uncertainHypotheses" | "alternativePlans"
  ): boolean => {
    const arr = r[field];
    if (arr.length === 0) return false;
    arr.pop();
    dropped.push(`${field}[${arr.length}]`);
    return true;
  };
  const dropLowestFinding = (field: "worldFindings" | "characterFindings"): boolean => {
    const arr = r[field];
    if (arr.length === 0) return false;
    const item = arr.pop();
    dropped.push(`${field}[${arr.length}](${item?.severity ?? "?"})`);
    return true;
  };

  dropWholeField("planStrengths");
  while (!fits() && dropFromEnd("proposedDeltas")) { /* 逐项 */ }
  while (!fits() && (dropFromEnd("questionsForMainModel") || dropFromEnd("uncertainHypotheses"))) { /* 逐项 */ }
  while (!fits() && dropFromEnd("alternativePlans")) { /* 逐项 */ }
  while (!fits() && (dropLowestFinding("characterFindings") || dropLowestFinding("worldFindings"))) { /* 逐项 */ }

  return r;
}
