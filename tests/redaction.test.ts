import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/core/redaction/redact.js";

describe("redaction（D12/D18）", () => {
  it("脱敏 Authorization Bearer 头", () => {
    const redact = createRedactor();
    expect(redact("Authorization: Bearer sk-abcdef123456")).toBe("Authorization: Bearer ***");
    expect(redact("authorization=bearer tok_12345")).toBe("authorization=bearer ***");
  });

  it("脱敏 api-key 类字段", () => {
    const redact = createRedactor();
    expect(redact('api-key: "XYZ123456"')).toBe('api-key: "***"');
    expect(redact("X-API-Key=some-secret-value")).toBe("X-API-Key=***");
  });

  it("A11：注册的密钥字面量在任何文本中都被替换", () => {
    const redact = createRedactor(["FAKE-KEY-lorem-ipsum-987"]);
    const msg = "HTTP 500：上游回显了 FAKE-KEY-lorem-ipsum-987 请检查";
    expect(redact(msg)).not.toContain("FAKE-KEY-lorem-ipsum-987");
    expect(redact(msg)).toContain("***");
  });

  it("extraHeadersEnv 解析值注册后同样脱敏（D18）", () => {
    const redact = createRedactor(["header-secret-abcde"]);
    expect(redact("错误中包含 header-secret-abcde")).toBe("错误中包含 ***");
  });

  it("长度 <4 的字面量被忽略，避免误伤", () => {
    const redact = createRedactor(["abc"]);
    expect(redact("abc 保留原样")).toBe("abc 保留原样");
  });

  it("无密钥时模式仍生效，普通文本不受影响", () => {
    const redact = createRedactor();
    expect(redact("普通错误信息")).toBe("普通错误信息");
  });
});
