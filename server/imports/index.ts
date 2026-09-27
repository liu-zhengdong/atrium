import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { backfillBriefs } from "./briefs.ts";
import { importCharterBudget } from "./charter.ts";
import { ensureImportMarks } from "./marks.ts";

/**
 * 启动时把旧状态导入数据库（#355）：Atrium 的状态只在数据目录的库里，换机器只带数据目录。
 * 每类导入幂等（state_imports 记号），单条坏记录记日志跳过，不挡启动。
 */

/**
 * 旧的 `~/Atrium` 目录：ATRIUM_LEGACY_DIR 可改。node:test 派生的服务不去读开发者主目录，
 * 没显式给就不导入。
 */
export function legacyDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.ATRIUM_LEGACY_DIR) return env.ATRIUM_LEGACY_DIR;
  if (env.NODE_TEST_CONTEXT) return undefined;
  return join(homedir(), "Atrium");
}

export function importLegacyState(
  db: DatabaseSync,
  options: { legacyDir?: string; log?: (line: string) => void },
) {
  const log = options.log ?? console.error;
  ensureImportMarks(db);
  const step = (name: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      log(
        `${name}导入失败，下次启动重试：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  step("任务详述", () => backfillBriefs(db, log));
  if (options.legacyDir) {
    const file = join(options.legacyDir, "charter.md");
    step("根章程", () => importCharterBudget(db, file, log));
  }
}
