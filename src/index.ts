/**
 * novel-council 库入口（未来 Pi Extension 经此 import，D5-A）。
 * core 为纯计算：不做文件 IO；stdout/写文件由 CLI 层负责（D7）。
 */
export * from "./contracts/index.js";
export {
  simulateScene,
  checkCouncilShape,
  type SimulateInput,
  type SimulateResult
} from "./core/orchestrator/simulate-scene.js";
export {
  getCouncilKind,
  knownCouncilIds,
  type CouncilKind,
  type CouncilReportBucket
} from "./core/council-kinds/council-kinds.js";
export {
  checkConfig,
  type ConfigCheckResult,
  type ConfigCheckOk,
  type ConfigCheckFailed,
  type ConfigCheckMember
} from "./core/orchestrator/check-config.js";
export {
  estimateCalls,
  type CallEstimate,
  type CallEstimateBreakdown,
  type BudgetCoverage
} from "./core/budget/estimate.js";
export {
  DEEP_MODE_UNSUPPORTED_MESSAGE,
  moderatorFailedWarning,
  moderatorSkippedQuickWarning
} from "./core/orchestrator/execution-modes.js";

export {
  validateScenePacket,
  validateCouncilConfig,
  type ValidationOutcome
} from "./core/validation/validate.js";
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./providers/openai-compatible.js";
export { MockProvider, type MockStep } from "./providers/mock.js";
export type { ProviderAdapter, ChatRequest, ChatMessage } from "./providers/types.js";
export { createRedactor, type Redactor } from "./core/redaction/redact.js";
export { exitCodeFor, toCoreError, isCoreError } from "./core/errors/core-error.js";
