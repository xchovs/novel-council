/**
 * ProviderAdapter 统一接口（architecture §5）。
 * - chat(req) → 原始文本（string）；解析与校验由 core/validation 负责。
 * - 构造注入 fetchImpl 等依赖；不内建重试（重试语义在 core/council-runner）。
 * - providers 只依赖 contracts，不依赖 core（依赖方向纪律）。
 */

export interface ChatMessage {
  /** assistant 仅用于修复重试时回显上一轮原文（§11）。 */
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** generationParams 透传（D17：保留字段已在配置校验层拒绝；核心字段由程序控制）。 */
  extraParams?: Record<string, unknown>;
}

export interface ProviderCallContext {
  signal: AbortSignal;
}

export interface ProviderAdapter {
  readonly providerId: "openai-compatible" | "mock";
  chat(req: ChatRequest, ctx: ProviderCallContext): Promise<string>;
}
