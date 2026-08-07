import { describe, expect, it } from "vitest";
import { CoreError } from "../src/contracts/index.js";
import { CallBudget } from "../src/core/budget/budget.js";

describe("CallBudget（D10）", () => {
  it("计数到上限后抛 BUDGET_EXCEEDED 并置 exceeded（A10）", () => {
    const budget = new CallBudget(2);
    budget.consume();
    budget.consume();
    expect(budget.used).toBe(2);
    expect(budget.exceeded).toBe(false);
    const err = (() => {
      try {
        budget.consume();
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).code).toBe("BUDGET_EXCEEDED");
    expect(budget.exceeded).toBe(true);
    expect(budget.used).toBe(2);
  });
});
