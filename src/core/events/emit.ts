import type { ProgressEvent } from "../../contracts/index.js";

export type ProgressHandler = (event: ProgressEvent) => void;

/** 安全发射 ProgressEvent：宿主回调异常不得拖垮核心（architecture §5）。 */
export function safeEmit(handler: ProgressHandler | undefined, event: ProgressEvent): void {
  if (handler === undefined) return;
  try {
    handler(event);
  } catch {
    // 宿主进度回调属于可选展示能力，异常忽略（R03）
  }
}
