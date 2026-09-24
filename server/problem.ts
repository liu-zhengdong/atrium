/** 带 HTTP 状态码的失败；接口层直接转成响应，MCP 层转成工具错误。 */
export class Problem extends Error {
  readonly code: string;
  constructor(
    public statusCode: number,
    message: string,
    code?: string,
    public candidates?: { ref: string; name: string }[],
    public nextCommand?: string,
  ) {
    super(message);
    this.code =
      code ??
      (
        {
          400: "usage",
          404: "not_found",
          403: "conflict",
          409: "conflict",
          503: "service_unavailable",
        } as Record<number, string>
      )[statusCode] ??
      "internal";
  }
}

/** Matches ref first, then name prefix, then edit distance; no SQL wildcard matching. */
export function closest(
  reference: string,
  entries: { ref: string; name: string }[],
) {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++)
        next[j] = Math.min(
          next[j - 1]! + 1,
          row[j]! + 1,
          row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      row = next;
    }
    return row[b.length]!;
  };
  const input = reference.toLowerCase();
  return entries
    .map((entry) => ({
      entry,
      score:
        entry.ref.toLowerCase() === input
          ? -2
          : entry.ref.toLowerCase().startsWith(input) ||
              entry.name.toLowerCase().startsWith(input)
            ? -1
            : Math.min(
                distance(input, entry.name.toLowerCase()),
                distance(input, entry.name.toLowerCase().split(/\s+/)[0]!),
              ),
    }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.ref.localeCompare(b.entry.ref, undefined, { numeric: true }),
    )
    .slice(0, 3)
    .map(({ entry }) => ({ ref: entry.ref, name: entry.name }));
}
