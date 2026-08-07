#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CoreError } from "../contracts/index.js";
import { exitCodeFor } from "../core/errors/core-error.js";
import { parseCliArgs, USAGE, type CliFlags } from "./args.js";
import { runSimulate } from "./cmd-simulate.js";
import { runCheckConfig } from "./cmd-check-config.js";

/**
 * CLI 入口（D21）：
 * - stdout 只输出最终机器可读 JSON；
 * - stderr 用于进度、警告与人类可读错误；
 * - 退出码：0 成功（含 degraded）；1 配置/packet/输入类错误；2 运行失败。
 */

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export type { CliFlags };

export async function main(argv: string[], io?: Partial<CliIo>): Promise<number> {
  const realIo: CliIo = {
    stdout: io?.stdout ?? ((text) => process.stdout.write(text)),
    stderr: io?.stderr ?? ((text) => process.stderr.write(text)),
    env: io?.env ?? process.env,
    cwd: io?.cwd ?? process.cwd()
  };

  try {
    const { command, flags } = parseCliArgs(argv);
    if (command === "simulate") return await runSimulate(flags, realIo);
    return await runCheckConfig(flags, realIo);
  } catch (e) {
    const err =
      e instanceof CoreError ? e : new CoreError("INTERNAL", e instanceof Error ? e.message : String(e));
    realIo.stderr(`错误 [${err.code}] ${err.message}\n\n${USAGE}\n`);
    return exitCodeFor(err.code);
  }
}

// 作为可执行入口运行时（node dist/cli/bin.js 或 tsx src/cli/bin.ts）
const invokedAsMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
