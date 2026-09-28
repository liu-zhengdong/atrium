import type { DatabaseSync } from "node:sqlite";
import { backfillBriefs } from "./briefs.ts";
import { ensureImportMarks } from "./marks.ts";
import { migrateRules } from "./rules.ts";

/**
 * 启动时把旧状态导入数据库（#355）：Atrium 的状态只在数据目录的库里，换机器只带数据目录。
 * 每类导入幂等（state_imports 记号），单条坏记录记日志跳过，不挡启动。
 */

export { legacyDir, legacyWorkersDir } from "./dirs.ts";

export function importLegacyState(
  db: DatabaseSync,
  options: { log?: (line: string) => void } = {},
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
  step("规矩并进要点", () => migrateRules(db, log));
}
