import { describe, expect, it, vi } from "vitest";
import { CoreError } from "../src/contracts/index.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { ChatRequest } from "../src/providers/types.js";

/** 全部用例注入 mock fetchImpl，禁止真实网络（D6）。 */

const FAKE_KEY = "FAKE-KEY-adapter-test-123";

function makeReq(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function makeProvider(fetchImpl: typeof fetch, extra?: { extraHeaders?: Record<string, string>; baseUrl?: string }) {
  return new OpenAICompatibleProvider({
    baseUrl: extra?.baseUrl ?? "https://api.example.com/v1/",
    apiKey: FAKE_KEY,
    fetchImpl,
    extraHeaders: extra?.extraHeaders
  });
}

describe("OpenAICompatibleProvider", () => {
  it("规范化 baseUrl 末尾斜杠并追加 /chat/completions（D19）", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ choices: [{ message: { content: "{}" } }] }));
    const provider = makeProvider(fetchImpl);
    expect(provider.endpoint).toBe("https://api.example.com/v1/chat/completions");
    await provider.chat(makeReq(), { signal: new AbortController().signal });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("发送 Authorization 与 extraHeaders，核心字段由程序控制（D17）", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const provider = makeProvider(fetchImpl, { extraHeaders: { "X-Custom": "v1" } });
    await provider.chat(
      makeReq({ temperature: 0.4, maxTokens: 100, extraParams: { top_p: 0.9, model: "evil-override", stream: true } }),
      { signal: new AbortController().signal }
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers["X-Custom"]).toBe("v1");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("test-model"); // extraParams 不得覆盖核心字段
    expect(body["stream"]).toBe(false);
    expect(body["top_p"]).toBe(0.9);
    expect(body["temperature"]).toBe(0.4);
    expect(body["max_tokens"]).toBe(100);
  });

  it("非 2xx → PROVIDER_HTTP_ERROR 携带 httpStatus，且不内建重试（D27）", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "bad" }, 500));
    const provider = makeProvider(fetchImpl);
    const err = await provider.chat(makeReq(), { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).code).toBe("PROVIDER_HTTP_ERROR");
    expect((err as CoreError).message).toContain("HTTP 500");
    expect((err as CoreError).httpStatus).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("HTTP 429 / 4xx 均携带 httpStatus（重试分类依据，D27）", async () => {
    for (const status of [429, 400, 401]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "x" }, status));
      const provider = makeProvider(fetchImpl);
      const err = await provider.chat(makeReq(), { signal: new AbortController().signal }).catch((e: unknown) => e);
      expect((err as CoreError).code).toBe("PROVIDER_HTTP_ERROR");
      expect((err as CoreError).httpStatus).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // provider 不内建重试
    }
  });

  it("响应信封非法或缺 content → PROVIDER_BAD_JSON", async () => {
    const badEnvelope = vi.fn<typeof fetch>(async () => jsonResponse({ nope: 1 }));
    const provider = makeProvider(badEnvelope);
    const err = await provider.chat(makeReq(), { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect((err as CoreError).code).toBe("PROVIDER_BAD_JSON");

    const notJson = vi.fn<typeof fetch>(async () => new Response("not-json", { status: 200 }));
    const provider2 = makeProvider(notJson);
    const err2 = await provider2.chat(makeReq(), { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect((err2 as CoreError).code).toBe("PROVIDER_BAD_JSON");
  });

  it("signal 中止 → PROVIDER_TIMEOUT", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const provider = makeProvider(fetchImpl);
    const controller = new AbortController();
    const promise = provider.chat(makeReq(), { signal: controller.signal });
    controller.abort();
    const err = await promise.catch((e: unknown) => e);
    expect((err as CoreError).code).toBe("PROVIDER_TIMEOUT");
  });

  it("回归：标准根对象 choices 正常读取 content", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => jsonResponse({ choices: [{ message: { content: "正文内容" } }] })
    );
    const provider = makeProvider(fetchImpl);
    const content = await provider.chat(makeReq(), { signal: new AbortController().signal });
    expect(content).toBe("正文内容");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("回归：data 包装层 choices 正常读取（网关/代理信封兼容）", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        jsonResponse({ success: true, data: { choices: [{ message: { content: "包装正文" } }] } })
    );
    const provider = makeProvider(fetchImpl);
    const content = await provider.chat(makeReq(), { signal: new AbortController().signal });
    expect(content).toBe("包装正文");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("回归：无 choices 的错误信封（success:false）仍然失败", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => jsonResponse({ success: false, error: { message: "upstream error" } })
    );
    const provider = makeProvider(fetchImpl);
    const err = await provider.chat(makeReq(), { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).code).toBe("PROVIDER_BAD_JSON");
  });

  it("网络层抛错 → PROVIDER_NETWORK_ERROR（D27 正名），错误消息不含 apiKey（A11 纪律）", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("socket hang up");
    });
    const provider = makeProvider(fetchImpl);
    const err = await provider.chat(makeReq(), { signal: new AbortController().signal }).catch((e: unknown) => e);
    expect((err as CoreError).code).toBe("PROVIDER_NETWORK_ERROR");
    expect((err as CoreError).httpStatus).toBeUndefined();
    expect((err as CoreError).message).not.toContain(FAKE_KEY);
  });
});
