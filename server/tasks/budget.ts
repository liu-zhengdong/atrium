import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Problem } from "../problem.ts";

/** 章程里每个订阅账号须留给用户的额度；缺文件或缺字段时沿用默认值。 */
export const DEFAULT_QUOTA_RESERVE_PERCENT = 20;
export const defaultCharterPath = () => join(homedir(), "Atrium", "charter.md");

export function parseQuotaReservePercent(text: string): number {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)?.[1];
  if (frontmatter === undefined) return DEFAULT_QUOTA_RESERVE_PERCENT;
  let inBudget = false;
  for (const raw of frontmatter.split("\n")) {
    if (/^budget:\s*(?:#.*)?$/.test(raw)) {
      inBudget = true;
      continue;
    }
    if (raw && !/^\s/.test(raw)) inBudget = false;
    if (!inBudget) continue;
    const match = /^\s+quota_reserve_percent:\s*([^#]*?)(?:\s*#.*)?$/.exec(raw);
    if (!match) continue;
    const value = match[1].trim();
    const reserve = Number(value);
    if (!value || !Number.isFinite(reserve) || reserve < 0 || reserve > 100)
      throw new Problem(
        400,
        "章程 budget.quota_reserve_percent 须为 0 到 100 的数字",
        "usage",
      );
    return reserve;
  }
  return DEFAULT_QUOTA_RESERVE_PERCENT;
}

export async function readQuotaReservePercent(
  charterPath = defaultCharterPath(),
): Promise<number> {
  try {
    return parseQuotaReservePercent(await readFile(charterPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return DEFAULT_QUOTA_RESERVE_PERCENT;
    throw error;
  }
}

/** 仅在 OpenQuota 明确给出已用比例时阻止派活；缺数据不猜测额度。 */
export function overReserve(
  usedPercent: number | null | undefined,
  reservePercent: number,
): boolean {
  return (
    usedPercent !== null &&
    usedPercent !== undefined &&
    usedPercent >= 100 - reservePercent
  );
}
