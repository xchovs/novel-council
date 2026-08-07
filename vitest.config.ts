import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000
    // 阶段 1 纪律（D6）：测试只允许 MockProvider / 注入的 mock fetchImpl，禁止真实网络调用。
  }
});
