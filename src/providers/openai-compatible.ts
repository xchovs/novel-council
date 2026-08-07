import { CoreError } from "../contracts/index.js";
import type { ChatRequest, ProviderAdapter, ProviderCallContext } from "./types.js";

/**
 * OpenAI-compatible Chat Completions adapter（D6 / D19）。
 * - baseUrl 为 API 根地址（如 https://api.example.com/v1）；本类负责追加
 *   /chat/completions 并规范化末尾斜杠。
 * - HTTP 走注入的 fetchImpl（默认全局 fetch）；不内建重试（architecture §5）。
 * - 纪律：永不把请求头或 apiKey 写入错误消息（A11；core 侧另有 redactor 兜底）。
 */

export interface OpenAICompatibleOptions {
  /** API 根地址（D19），允许末尾带斜杠，构造时规范化。 */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** 已解析的额外头（值来自 extraHeadersEnv，D18）；构造后即被本类持有，不进入日志。 */
  extraHeaders?: Record<string, string>;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly providerId = "openai-compatible" as const;

  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch;
  readonly #extraHeaders: Record<string, string>;

  constructor(opts: OpenAICompatibleOptions) {
    if (!opts.baseUrl) throw new CoreError("CONFIG_INVALID", "baseUrl 不能为空（应为 API 根地址，D19）");
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#apiKey = opts.apiKey;
    this.#fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.#extraHeaders = { ...(opts.extraHeaders ?? {}) };
  }

  /** 完整 endpoint（根地址 + /chat/completions）。 */
  get endpoint(): string {
    return `${this.#baseUrl}/chat/completions`;
  }

  async chat(req: ChatRequest, ctx: ProviderCallContext): Promise<string> {
    // 核心字段后写，程序控制（D17）：generationParams 不得覆盖 model/messages/stream。
    const body: Record<string, unknown> = {
      ...(req.extraParams ?? {}),
      model: req.model,
      messages: req.messages,
      stream: false
    };
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;

    let res: Response;
    try {
      res = await this.#fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          ...this.#extraHeaders
        },
        body: JSON.stringify(body),
        signal: ctx.signal
      });
    } catch (e) {
      if (isAbortLike(e, ctx.signal)) {
        throw new CoreError("PROVIDER_TIMEOUT", "请求超时或被取消", { cause: e });
      }
      // 传输层故障（无 HTTP 语义）：D27 分类，供 council-runner 有界重试判定
      throw new CoreError("PROVIDER_NETWORK_ERROR", `网络错误：${safeMessage(e)}`, { cause: e });
    }

    if (!res.ok) {
      const snippet = await safeBodySnippet(res);
      throw new CoreError("PROVIDER_HTTP_ERROR", `HTTP ${res.status}${snippet ? `：${snippet}` : ""}`, {
        httpStatus: res.status
      });
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (e) {
      throw new CoreError("PROVIDER_BAD_JSON", "响应信封不是有效 JSON", { cause: e });
    }

    const content = extractContent(data);
    if (content === null) {
      throw new CoreError("PROVIDER_BAD_JSON", "响应缺少 choices[0].message.content");
    }
    return content;
  }
}

function isAbortLike(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return (
    (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) ||
    (e instanceof Error && e.name === "AbortError")
  );
}

function safeMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function safeBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, " ").slice(0, 300);
  } catch {
    return "";
  }
}

function extractContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  // 优先根对象 choices（标准 OpenAI-compatible 信封）
  const direct = contentFromChoices(data);
  if (direct !== null) return direct;
  // 兜底 data 包装层（{ success, data: { choices: [...] } } 形态的网关/代理信封）
  const wrapped = (data as { data?: unknown }).data;
  if (typeof wrapped !== "object" || wrapped === null) return null;
  return contentFromChoices(wrapped);
}

function contentFromChoices(container: unknown): string | null {
  const choices = (container as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: unknown };
  if (typeof first !== "object" || first === null) return null;
  const message = first.message as { content?: unknown } | undefined;
  if (typeof message !== "object" || message === null) return null;
  return typeof message.content === "string" ? message.content : null;
}
