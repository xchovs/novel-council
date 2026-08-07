import { CoreError, type ErrorCode } from "../../contracts/index.js";

/**
 * core/errors：CoreError 辅助函数。
 * 类与错误码枚举定义于 contracts/errors.ts（C13），此处只放工具。
 */

export function isCoreError(e: unknown): e is CoreError {
  return e instanceof CoreError;
}

/** 把未知异常包装为 CoreError；已是 CoreError 时原样返回。 */
export function toCoreError(
  e: unknown,
  fallbackCode: ErrorCode = "INTERNAL",
  ctx?: { memberId?: string; councilId?: string }
): CoreError {
  if (e instanceof CoreError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new CoreError(fallbackCode, message, { ...ctx, cause: e });
}

/**
 * 错误码 → CLI 退出码（data-contracts §9）：
 * 1 = 配置/packet/输入类错误；2 = 运行失败。
 */
export function exitCodeFor(code: ErrorCode): 1 | 2 {
  switch (code) {
    case "CONFIG_INVALID":
    case "PACKET_INVALID":
    case "PACKET_TOO_LARGE":
    case "MOCK_NOT_ALLOWED":
    case "OUTPUT_WRITE_FAILED":
      return 1;
    default:
      return 2;
  }
}
