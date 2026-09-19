/** Human-readable fallback until an Agent has its own name; never expose runtime UUIDs as names. */
export function agentName(cwd: string, used: Iterable<string> = []): string {
  const folder =
    cwd.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "Pi";
  const base =
    Array.from(folder.replace(/[^\p{L}\p{N}_. -]/gu, "-").trim())
      .slice(0, 32)
      .join("") || "Pi";
  const names = new Set(used);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = base.slice(0, 40 - suffix.length) + suffix;
    if (!names.has(candidate)) return candidate;
  }
}
