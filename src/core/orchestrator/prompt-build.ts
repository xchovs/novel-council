import type { MemberOutput, ScenePacket } from "../../contracts/index.js";
import type { ChatMessage } from "../../providers/types.js";


/**
 * core/orchestrator/prompt-build：成员消息构造。
 * 角色提示词（CLI 读文件内联传入，D22）+ 输出契约提醒 + packet 注入。
 * 输出结构说明由 council-kinds 注册表按组提供（C14）。
 * sourceReferences 的路径不读取，内容必须已内联（D8）。
 */

const COMMON_RULES = [
  "你是小说写作评议会的一名独立评议成员。",
  "输入为暂定方案（provisional=true），不是既定答案；你可以 accept / revise / reject。",
  "只依据 packet 中给出的材料判断；无法确定的内容放入 uncertainties，禁止编造。",
  "区分事实、推论与假设；proposedDelta 的 kind 只能是 hypothesis 或 suggestion，禁止把假设写成既定事实。",
  "只输出一个 JSON 对象：不要输出解释、Markdown 围栏以外的文字或注释。"
].join("\n");

export function buildMemberMessages(args: {
  /** 该评议组的输出结构说明（由 council-kinds 注册表提供）。 */
  outputShape: string;
  rolePrompt: string;
  packet: ScenePacket;
}): ChatMessage[] {
  const system = [args.rolePrompt.trim(), "---", COMMON_RULES, "", args.outputShape].join("\n");
  const user = [
    "以下是本次评议的 Scene Packet（暂定方案）。请按系统提示词要求的 JSON 结构输出评议结果。",
    "",
    JSON.stringify(args.packet, null, 2)
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

/** 主持通用规则（规划 §9.3：主持人职责是整理，不是重新自由发挥）。 */
const MODERATOR_RULES = [
  "你是小说写作评议会的组内主持。你的职责是整理本组评议结果，不是重新自由发挥。",
  "只依据给定的本组成员评议输出与 Scene Packet 整理；保留核心分歧、少数意见与证据强弱，不得以多数一致自动视为正确。",
  "失败成员缺失的结果不计入赞成或反对，也不得据此编造其立场。",
  "只输出一个 JSON 对象：不要输出解释、Markdown 围栏以外的文字或注释。"
].join("\n");

/** 主持输出结构说明（contracts/council-report.ts 的 ModeratorOutputSchema）。 */
const MODERATOR_OUTPUT_SHAPE = `输出 JSON 结构（所有数组字段可空）：
{
  "verdict": "accept | revise | reject",
  "summary": "组内主持的一段总述",
  "consensus": [], "disagreements": [], "minorityOpinions": [],
  "evidenceStrength": [], "questionsForMainModel": []
}`;

/**
 * 组内主持消息构造（D25/D31，C5）。
 * 输入隔离：仅含本组有效成员输出（按 memberId 升序，调用方保证）与失败成员 id 列表，
 * 不含任何其他评议组的成员报告（无跨组信息泄漏通道）。
 * validReports 顺序即注入顺序——调用方先按 memberId 排序，保证与完成顺序无关的确定性。
 */
export function buildModeratorMessages(args: {
  rolePrompt: string;
  packet: ScenePacket;
  /** 本组有效成员输出（已按 memberId 升序）。 */
  validReports: Array<{ memberId: string; output: MemberOutput }>;
  /** 本组失败成员 id（仅 id，不含其内容；缺失结果不计入赞成/反对）。 */
  failedMemberIds: string[];
}): ChatMessage[] {
  const system = [args.rolePrompt.trim(), "---", MODERATOR_RULES, "", MODERATOR_OUTPUT_SHAPE].join("\n");
  const memberBlocks = args.validReports.map((r) =>
    [`成员 ${r.memberId} 的评议输出：`, JSON.stringify(r.output, null, 2)].join("\n")
  );
  const failedLine =
    args.failedMemberIds.length > 0
      ? `以下成员未能产出有效结果（缺失结果不计入赞成或反对）：${args.failedMemberIds.join(", ")}`
      : "本组无失败成员。";
  const user = [
    "以下是本次评议的 Scene Packet（暂定方案）与本组有效成员的评议输出。请按系统提示词要求的 JSON 结构输出组内汇总。",
    "",
    "Scene Packet：",
    JSON.stringify(args.packet, null, 2),
    "",
    ...memberBlocks.flatMap((b) => [b, ""]),
    failedLine
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

/** 一次格式修复重试的消息（§11：原 prompt + 错误回显）。 */

export function buildRepairMessages(
  base: ChatMessage[],
  previousRaw: string,
  issuesSummary: string
): ChatMessage[] {
  return [
    ...base,
    { role: "assistant", content: previousRaw },
    {
      role: "user",
      content: [
        "你上一次的输出未通过 JSON 校验。问题如下：",
        issuesSummary,
        "请只输出修正后的 JSON 对象，不要输出任何解释或额外文字。"
      ].join("\n")
    }
  ];
}

/** 成员实际发送的消息内容字符数（maxInputChars 预检口径，§2.1）。 */
export function measureInputChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0);
}
