const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(sk-[A-Za-z0-9_-]{16,})/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  // Telegram bot token（数字:字母串），请求 URL 里以 /bot<token>/ 出现。
  /(?<!\d)(\d{5,20}:[A-Za-z0-9_-]{30,})/g,
  /(?<=\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  /(?<=\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"']{6,})/g,
];

/** 抹掉输出里常见的凭据形态（令牌、密钥、Bearer、XXX_TOKEN=值）。 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "***");
  return out;
}
