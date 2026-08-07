import { z } from "zod";
import { ErrorCodeSchema } from "./errors.js";
import { MemberStatusSchema } from "./member-report.js";
import { RunStatsSchema } from "./final-report.js";

/**
 * ProgressEvent 阶段 1 最小集（data-contracts §8，C8）。
 * 宿主可忽略该事件流；core 不依赖宿主展示能力。
 * member-retry（阶段 2，D27）：仅在传输重试调用实际发起前发射，
 * 与 provider 调用一一对应；预算闸住导致重试未发起时不发射。
 */

export const ProgressEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run-start"),
    runId: z.string().min(1),
    memberIds: z.array(z.string())
  }),
  z.object({
    type: z.literal("member-retry"),
    runId: z.string().min(1),
    councilId: z.string().min(1),
    memberId: z.string().min(1),
    /** 即将发起的调用序号（≥2；1 为首次调用，不产生本事件）。 */
    attempt: z.number().int().min(2),
    /** 触发本次重试的错误分类（PROVIDER_NETWORK_ERROR 或 PROVIDER_HTTP_ERROR）。 */
    code: ErrorCodeSchema,
    httpStatus: z.number().int().min(100).max(599).optional()
  }),
  z.object({
    type: z.literal("member-end"),
    runId: z.string().min(1),
    councilId: z.string().min(1),
    memberId: z.string().min(1),
    status: MemberStatusSchema,
    latencyMs: z.number().int().min(0)
  }),
  // 阶段 2 新增（C5 落地，data-contracts §8）：组级判定完成后、主持之前逐组发射（含 disabled/insufficient 组）
  z.object({
    type: z.literal("council-end"),
    runId: z.string().min(1),
    councilId: z.string().min(1),
    status: z.enum(["ok", "insufficient"]),
    validMemberCount: z.number().int().min(0)
  }),
  // 阶段 2 新增（C5 落地，data-contracts §8）：每组主持结论后至多一次；
  // skipped = quick 配置跳过或单有效成员跳过；未配置主持 / 组 insufficient / disabled 不发射本事件
  z.object({
    type: z.literal("moderator-end"),
    runId: z.string().min(1),
    councilId: z.string().min(1),
    /** 实际/拟担任主持的 id：useMember → 被复用成员 id；内联主持 → "moderator"。 */
    moderatorMemberId: z.string().min(1),
    status: z.enum(["ok", "failed", "skipped"]),
    latencyMs: z.number().int().min(0)
  }),
  z.object({
    type: z.literal("run-end"),

    runId: z.string().min(1),
    ok: z.boolean(),
    stats: RunStatsSchema
  })
]);

export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
