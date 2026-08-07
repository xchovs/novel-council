import { z } from "zod";
import {
  CouncilConfigSchema,
  ScenePacketSchema,
  type CouncilConfig,
  type ScenePacket
} from "../../contracts/index.js";

/** core/validation：zod 校验封装（architecture §6 的 ValidationOutcome）。 */

export type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; issues: string };

export function validateWith<S extends z.ZodType>(schema: S, data: unknown): ValidationOutcome<z.output<S>> {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, issues: summarizeIssues(r.error) };
}

export function validateScenePacket(data: unknown): ValidationOutcome<ScenePacket> {
  return validateWith(ScenePacketSchema, data);
}

export function validateCouncilConfig(data: unknown): ValidationOutcome<CouncilConfig> {
  return validateWith(CouncilConfigSchema, data);
}

/** zod 错误摘要：只含路径与消息，供错误信息与修复重试回显（§11）。 */
export function summarizeIssues(error: z.ZodError, max = 8): string {
  return error.issues
    .slice(0, max)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
