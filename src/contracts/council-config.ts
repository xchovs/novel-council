import { z } from "zod";

/**
 * CouncilConfig v1（data-contracts §4）与 SimulateOptions（§3）。
 * - 配置只存环境变量名，永不存密钥值（§1.3）。
 * - generationParams 保留字段禁令（D17 / §4.2）。
 * - extraHeadersEnv：Header 名 → 环境变量名（D18 / §4.3）。
 * - mock provider 仅供测试（D16 / §4.4）。
 */

/** D17：禁止出现在 generationParams 中的保留字段（核心字段由程序控制）。 */
export const RESERVED_GENERATION_PARAMS = ["model", "messages", "stream", "tools", "tool_choice"] as const;

export const MemberConfigSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().default(""),
    provider: z.enum(["openai-compatible", "mock"]),
    model: z.string().default(""),
    baseUrlEnv: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    extraHeadersEnv: z.record(z.string(), z.string()).default({}),
    rolePromptPath: z.string().min(1),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    generationParams: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().positive().default(120000),
    enabled: z.boolean().default(true),
    // 仅 mock 成员使用：按调用顺序消费的脚本化返回（D16）
    mockResponses: z.array(z.string()).optional()
  })
  .superRefine((m, ctx) => {
    for (const key of RESERVED_GENERATION_PARAMS) {
      if (Object.hasOwn(m.generationParams, key)) {
        ctx.addIssue({
          code: "custom",
          path: ["generationParams", key],
          message: `generationParams 含保留字段 "${key}"（D17：核心字段由程序控制）`
        });
      }
    }
    if (m.provider === "openai-compatible") {
      if (m.baseUrlEnv === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["baseUrlEnv"],
          message: "openai-compatible 成员必须配置 baseUrlEnv（API 根地址的环境变量名，D19）"
        });
      }
      if (m.apiKeyEnv === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["apiKeyEnv"],
          message: "openai-compatible 成员必须配置 apiKeyEnv"
        });
      }
    }
  });

/**
 * 组内主持配置（D25/D31，C5；data-contracts §4）：
 * - rolePromptPath 必填（主持提示词不复用成员的 rolePromptPath，键 `${councilId}:moderator`）；
 * - useMember 复用同组某启用成员的连接配置，与内联连接字段互斥；缺省（整个 moderator 缺省）= 无主持；
 * - generationParams 受 D17 保留字段禁令；mock 主持允许（受 D16 门禁）。
 */
export const ModeratorConfigSchema = z
  .strictObject({
    rolePromptPath: z.string().min(1),
    /** 复用同组某启用成员的 provider/model/密钥等连接配置（D25）；与内联连接字段互斥。 */
    useMember: z.string().min(1).optional(),
    provider: z.enum(["openai-compatible", "mock"]).optional(),
    model: z.string().default(""),
    baseUrlEnv: z.string().min(1).optional(),
    apiKeyEnv: z.string().min(1).optional(),
    extraHeadersEnv: z.record(z.string(), z.string()).default({}),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    generationParams: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().positive().default(120000),
    /** 仅 mock 主持使用：按调用顺序消费的脚本化返回（D16） */
    mockResponses: z.array(z.string()).optional()
  })
  .superRefine((m, ctx) => {
    for (const key of RESERVED_GENERATION_PARAMS) {
      if (Object.hasOwn(m.generationParams, key)) {
        ctx.addIssue({
          code: "custom",
          path: ["generationParams", key],
          message: `generationParams 含保留字段 "${key}"（D17：核心字段由程序控制）`
        });
      }
    }
    if (m.useMember !== undefined) {
      // 互斥（D25）：useMember 与任何内联连接字段不得同现
      // （timeoutMs 有默认值，显式传默认值无法与缺省区分，不参与互斥判定）
      const inline: string[] = [];
      if (m.provider !== undefined) inline.push("provider");
      if (m.model !== "") inline.push("model");
      if (m.baseUrlEnv !== undefined) inline.push("baseUrlEnv");
      if (m.apiKeyEnv !== undefined) inline.push("apiKeyEnv");
      if (Object.keys(m.extraHeadersEnv).length > 0) inline.push("extraHeadersEnv");
      if (m.temperature !== undefined) inline.push("temperature");
      if (m.maxTokens !== undefined) inline.push("maxTokens");
      if (Object.keys(m.generationParams).length > 0) inline.push("generationParams");
      if (m.mockResponses !== undefined) inline.push("mockResponses");
      if (inline.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["useMember"],
          message: `moderator.useMember 与内联连接字段互斥（D25），不得同现：${inline.join(", ")}`
        });
      }
      return;
    }
    if (m.provider === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: "未配置 useMember 的主持必须内联 provider 连接配置（D25）"
      });
      return;
    }
    if (m.provider === "openai-compatible") {
      if (m.baseUrlEnv === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["baseUrlEnv"],
          message: "openai-compatible 主持必须配置 baseUrlEnv（API 根地址的环境变量名，D19）"
        });
      }
      if (m.apiKeyEnv === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["apiKeyEnv"],
          message: "openai-compatible 主持必须配置 apiKeyEnv"
        });
      }
    }
  });

export const CouncilEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    enabled: z.boolean().default(true),
    minValidMembers: z.number().int().min(1).default(1),
    /** 组内主持（D25/D31）：可选；useMember 与内联连接配置二选一；缺省 = 无主持（规则化合并）。 */
    moderator: ModeratorConfigSchema.optional(),
    members: z.array(MemberConfigSchema).default([])
  })
  .superRefine((c, ctx) => {
    const useMember = c.moderator?.useMember;
    if (useMember === undefined) return;
    const target = c.members.find((m) => m.id === useMember);
    if (target === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["moderator", "useMember"],
        message: `moderator.useMember 指向的成员不存在于同组：${useMember}`
      });
    } else if (!target.enabled) {
      ctx.addIssue({
        code: "custom",
        path: ["moderator", "useMember"],
        message: `moderator.useMember 必须指向同组已启用成员：${useMember} 未启用`
      });
    }
  });


export const CouncilConfigSchema = z.strictObject({
  configVersion: z.literal("1.0"),
  councils: z.array(CouncilEntrySchema).min(1),
  limits: z
    .strictObject({
      maxInputChars: z.number().int().positive().default(50000),
      maxReportChars: z.number().int().positive().default(20000)
    })
    .prefault({}),
  budget: z
    .strictObject({
      maxTotalCalls: z.number().int().positive().default(4),
      maxRetriesPerCall: z.number().int().min(0).default(1),
      /** 每成员传输重试总次数上限（D27）；与 maxRetriesPerCall 独立计数，硬上限 3。 */
      maxTransportRetries: z.number().int().min(0).max(3).default(1),
      concurrency: z.number().int().positive().default(2)
    })
    .prefault({})
});

/**
 * 执行模式（D24，C4）：schema 接受 quick/standard/deep 三值（契约前向稳定）。
 * quick/standard 可运行；deep 由 orchestrator 显式 CONFIG_INVALID（阶段 3 开放），
 * 禁止静默降级或伪装支持。
 */
export const ExecutionModeSchema = z.enum(["quick", "standard", "deep"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const SimulateOptionsSchema = z
  .strictObject({
    mode: ExecutionModeSchema.default("quick")
  })
  .prefault({});

export type MemberConfig = z.infer<typeof MemberConfigSchema>;
export type ModeratorConfig = z.infer<typeof ModeratorConfigSchema>;
export type CouncilEntry = z.infer<typeof CouncilEntrySchema>;

export type CouncilConfig = z.infer<typeof CouncilConfigSchema>;
export type SimulateOptions = z.infer<typeof SimulateOptionsSchema>;
