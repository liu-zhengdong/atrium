import type { Exec } from "../git.ts";
import {
  parseTimingSensitive,
  TIMING_SENSITIVE_FILE,
} from "./check-outcome.ts";

/** 检查没跑成的判定（t204）在 check-outcome.ts，这里是 IO：读仓库基础分支登记的时长敏感用例。 */

/** 从 origin/<基础分支> 读登记的时长敏感用例；执行者分支里改的不算数。读不到为空。 */
export async function timingSensitive(
  repo: string | null | undefined,
  base: string | null | undefined,
  run: Exec,
): Promise<string[]> {
  if (!repo || !base) return [];
  const shown = await run(
    "git",
    ["-C", repo, "show", `origin/${base}:${TIMING_SENSITIVE_FILE}`],
    { timeoutMs: 15_000 },
  );
  return shown.ok ? parseTimingSensitive(shown.stdout) : [];
}
