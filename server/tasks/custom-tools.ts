import type { DatabaseSync } from "node:sqlite";
import { syncFromRules } from "./adapters/custom.ts";
import { parseProfileSource } from "./profiles.ts";
import { all } from "./ledger-model.ts";

/**
 * 服务启动时把档案登记的通用执行者（t271，`harness/<名字>` 写了 `protocol`）整批登记进 ADAPTERS：
 * 单份写坏只记日志跳过，其余照常。改档案、解析执行者时的按名重登见 adapters/custom.ts 与 profiles.ts。
 */
export function loadCustomTools(
  db: DatabaseSync,
  log: (message: string) => void = console.warn,
) {
  const rows = all<{ name: string; source: string }>(
    db,
    "SELECT name,source FROM worker_profiles WHERE layer='harness' ORDER BY name LIMIT 500",
  );
  for (const row of rows) {
    const problems = syncFromRules(
      row.name,
      parseProfileSource(row.source).rules,
    );
    if (problems.length)
      log(
        `执行者档案 harness/${row.name} 没登记成执行者：${problems.join("；")}`,
      );
  }
}
