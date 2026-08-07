/**
 * core/validation：从模型原文中提取首个可解析 JSON（R04 缓解）。
 * 候选顺序：```json 围栏块 → 从首个 '{' 起的字符串感知括号配平块。
 */

export interface ExtractedJson {
  raw: string;
  data: unknown;
}

export function extractJson(text: string): ExtractedJson | null {
  for (const candidate of candidates(text)) {
    try {
      const data: unknown = JSON.parse(candidate);
      if (typeof data === "object" && data !== null) return { raw: candidate, data };
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

function* candidates(text: string): Generator<string> {
  // 1. 围栏代码块（```json ... ``` 或 ``` ... ```）
  const fenceRe = /```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1]?.trim();
    if (body && (body.startsWith("{") || body.startsWith("["))) yield body;
  }
  // 2. 括号配平块（字符串感知，处理转义）；从每个 '{' 位置尝试，容忍前置坏块
  yield* balancedObjects(text);
}

function* balancedObjects(text: string): Generator<string> {
  let from = 0;
  for (;;) {
    const start = text.indexOf("{", from);
    if (start === -1) return;
    from = start + 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}
