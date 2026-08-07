/**
 * core/redaction（architecture §5；D12 / D18）。
 * 两道防线之一：所有进入 MemberReport / 报告 / CLI 输出的 message 统一过 redactor。
 * 另一道防线是 provider 纪律：不把请求头/密钥写入错误（A11 验证）。
 */

export type Redactor = (text: string) => string;

const MASK = "***";

/** 认证头与常见密钥字段模式（值部分替换为 ***）。 */
const PATTERNS: RegExp[] = [
  // Authorization: Bearer <token> / authorization=<token>
  /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"',}]+/gi,
  // api-key / apikey / x-api-key / access-token / auth-token / secret 等 key: value 形态
  /((?:x-[\w-]*-)?(?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token|secret[-_]?key)\s*[:=]\s*"?)[^"',\s}]+/gi
];

/**
 * 创建脱敏器。
 * @param secretLiterals 本次运行解析出的密钥字面量（API Key、extraHeadersEnv 值等）；
 *   长度 < 4 的字面量忽略，避免误替换常见短词。
 */
export function createRedactor(secretLiterals: Iterable<string> = []): Redactor {
  const literals = [...new Set([...secretLiterals].filter((s) => typeof s === "string" && s.length >= 4))];
  return (text: string): string => {
    let out = text;
    for (const secret of literals) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (_m, prefix: string) => `${prefix}${MASK}`);
    }
    return out;
  };
}
