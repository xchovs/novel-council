import { CoreError } from "../contracts/index.js";
import type { ChatRequest, ProviderAdapter, ProviderCallContext } from "./types.js";

/**
 * MockProvider（D6 / D16）：仅供开发与自动化测试，不产生真实模型推演结果。
 * - 脚本化响应：按调用顺序消费 steps；耗尽后重复最后一个 step；空脚本默认返回 "{}"。
 * - 支持延迟、错误注入与"挂起直到超时"步骤；所有延迟可被 AbortSignal 打断。
 * - 记录全部调用（calls）供测试断言。
 */

export type MockStep =
  | { kind: "text"; text: string; delayMs?: number }
  | { kind: "error"; error: CoreError; delayMs?: number }
  | { kind: "timeout" };

export class MockProvider implements ProviderAdapter {
  readonly providerId = "mock" as const;
  readonly calls: ChatRequest[] = [];

  #steps: MockStep[];
  #index = 0;

  constructor(steps: MockStep[] = []) {
    this.#steps = [...steps];
  }

  chat(req: ChatRequest, ctx: ProviderCallContext): Promise<string> {
    this.calls.push(JSON.parse(JSON.stringify(req)) as ChatRequest);
    const step =
      this.#index < this.#steps.length
        ? this.#steps[this.#index++]
        : (this.#steps[this.#steps.length - 1] ?? ({ kind: "text", text: "{}" } as const));
    return runStep(step, ctx.signal);
  }
}

function runStep(step: MockStep, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const failTimeout = () =>
      reject(new CoreError("PROVIDER_TIMEOUT", "成员调用超时（mock）"));

    if (signal.aborted) {
      failTimeout();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      failTimeout();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    if (step.kind === "timeout") {
      // 永不自行 settle，等待 abort（确定性超时测试）
      return;
    }

    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      if (step.kind === "text") resolve(step.text);
      else reject(step.error);
    }, step.delayMs ?? 0);
  });
}
