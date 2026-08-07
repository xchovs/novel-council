import { parseArgs } from "node:util";
import { CoreError } from "../contracts/index.js";

/**
 * CLI 参数解析：Node 22 内置 util.parseArgs，零新增依赖。
 */

export type CliCommand = "simulate" | "check-config";

export interface CliFlags {
  packet?: string;
  config?: string;
  output?: string;
  /** 执行模式（C4）：quick（缺省）/ standard / deep（显式 CONFIG_INVALID，D24）。合法性由契约 schema 统一判定。 */
  mode?: string;
  allowMock: boolean;
}

export interface ParsedCli {
  command: CliCommand;
  flags: CliFlags;
}

export const USAGE = `novel-council — 多模型小说推演核心 CLI（阶段 2：quick / standard）

用法：
  novel-council simulate     --packet <path> --config <path> [--mode <mode>] [--output <path>] [--allow-mock]
  novel-council check-config --config <path> [--mode <mode>]

说明：
  stdout 只输出机器可读 JSON；进度、警告与错误走 stderr。
  --mode        执行模式：quick（缺省）或 standard；deep 暂不支持（显式 CONFIG_INVALID，阶段 3 开放）。
  --allow-mock  允许运行 provider=mock 的配置（仅供测试，不产生真实推演）。
`;

export function parseCliArgs(argv: string[]): ParsedCli {
  const [commandRaw, ...rest] = argv;
  if (commandRaw !== "simulate" && commandRaw !== "check-config") {
    throw new CoreError("CONFIG_INVALID", `未知命令：${commandRaw ?? "（空）"}`);
  }

  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: {
        packet: { type: "string" },
        config: { type: "string" },
        output: { type: "string" },
        mode: { type: "string" },
        "allow-mock": { type: "boolean", default: false }
      }
    });
    values = parsed.values as Record<string, unknown>;
  } catch (e) {
    throw new CoreError("CONFIG_INVALID", `参数解析失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const flags: CliFlags = {
    allowMock: values["allow-mock"] === true
  };
  if (typeof values["packet"] === "string") flags.packet = values["packet"];
  if (typeof values["config"] === "string") flags.config = values["config"];
  if (typeof values["output"] === "string") flags.output = values["output"];
  if (typeof values["mode"] === "string") flags.mode = values["mode"];

  if (flags.config === undefined) {
    throw new CoreError("CONFIG_INVALID", "缺少必需参数 --config <path>");
  }
  if (commandRaw === "simulate" && flags.packet === undefined) {
    throw new CoreError("CONFIG_INVALID", "simulate 缺少必需参数 --packet <path>");
  }

  return { command: commandRaw, flags };
}
