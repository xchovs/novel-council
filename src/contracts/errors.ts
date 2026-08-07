import { z } from "zod";

/**
 * 错误契约（data-contracts §7）。
 * CoreError 与错误码枚举定义于 contracts 层（C13）：
 * 使 providers 可抛类型化错误而不反向依赖 core。
 */

export const ERROR_CODES = [
  "CONFIG_INVALID",
  "ENV_KEY_MISSING",
  "PACKET_INVALID",
  "PACKET_TOO_LARGE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_NETWORK_ERROR",
  "PROVIDER_BAD_JSON",
  "REPAIR_FAILED",
  "BUDGET_EXCEEDED",
  "INSUFFICIENT_COUNCIL",
  "ALL_COUNCILS_FAILED",
  "MOCK_NOT_ALLOWED",
  "OUTPUT_WRITE_FAILED",
  "INTERNAL"
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const CoreErrorJsonSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  memberId: z.string().optional(),
  councilId: z.string().optional(),
  /** 仅 PROVIDER_HTTP_ERROR 携带：HTTP 状态码（D27，data-contracts §7）。 */
  httpStatus: z.number().int().min(100).max(599).optional()
});
export type CoreErrorJson = z.infer<typeof CoreErrorJsonSchema>;

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly memberId?: string;
  readonly councilId?: string;
  /** 仅 PROVIDER_HTTP_ERROR 携带（D27 有界重试分类依据之一）。 */
  readonly httpStatus?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { memberId?: string; councilId?: string; httpStatus?: number; cause?: unknown }
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CoreError";
    this.code = code;
    if (opts?.memberId !== undefined) this.memberId = opts.memberId;
    if (opts?.councilId !== undefined) this.councilId = opts.councilId;
    if (opts?.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
  }

  toJSON(): CoreErrorJson {
    const json: CoreErrorJson = { code: this.code, message: this.message };
    if (this.memberId !== undefined) json.memberId = this.memberId;
    if (this.councilId !== undefined) json.councilId = this.councilId;
    if (this.httpStatus !== undefined) json.httpStatus = this.httpStatus;
    return json;
  }
}
