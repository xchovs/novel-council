import { CoreError } from "../../contracts/index.js";

/**
 * core/budget：maxTotalCalls 计数闸（D10）。
 * 每次实际 provider 调用前 consume()；超限置 exceeded 并抛 BUDGET_EXCEEDED（A10）。
 */
export class CallBudget {
  readonly #max: number;
  #used = 0;
  #exceeded = false;

  constructor(maxTotalCalls: number) {
    this.#max = maxTotalCalls;
  }

  get used(): number {
    return this.#used;
  }

  get exceeded(): boolean {
    return this.#exceeded;
  }

  consume(): void {
    if (this.#used >= this.#max) {
      this.#exceeded = true;
      throw new CoreError("BUDGET_EXCEEDED", `调用预算已用尽（maxTotalCalls=${this.#max}）`);
    }
    this.#used += 1;
  }
}
