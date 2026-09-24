const MAX_SUMMARY = 110;

/** Error text is already redacted at the server boundary. Keep its full form in the details panel. */
export function failureSummary(text: string): string {
  const match = text.match(/^\s*(\d{3})\s*:\s*(\{[\s\S]*\})\s*$/);
  let readable = text;
  if (match) {
    try {
      const payload: unknown = JSON.parse(match[2]);
      if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        const error = record.error;
        const message =
          typeof record.message === "string"
            ? record.message
            : error && typeof error === "object"
              ? (error as Record<string, unknown>).message
              : undefined;
        if (typeof message === "string" && message.trim())
          readable = `${match[1]} · ${message}`;
      }
    } catch {
      // Unparseable payload: retain the original text.
    }
  }
  const normalized = readable.replace(/\s+/g, " ").trim();
  if (
    /\b(model|provider|模型|模型服务)\b/i.test(normalized) &&
    /\b(5\d\d|error|unavailable|failed|报错|失败)\b/i.test(normalized)
  )
    return "模型服务报错";
  return normalized.length > MAX_SUMMARY
    ? `${normalized.slice(0, MAX_SUMMARY)}…`
    : normalized;
}
