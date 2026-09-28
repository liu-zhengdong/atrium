import type { DatabaseSync } from "node:sqlite";
import { all } from "../ledger-model.ts";
import { parseProfileSource } from "../profiles.ts";
import { acpAdapter } from "./acp.ts";
import { parseToolSpec } from "./acp-spec.ts";
import { ADAPTERS } from "./index.ts";
import { isBuiltinTool, type Adapter } from "./types.ts";

/**
 * 档案接入的新工具登记（#418）：按库里的工具层档案（harness/<名字>，写了 protocol）重建 ADAPTERS 里的新工具。
 * 服务启动时与 `workers edit` 改了工具层档案后调用；内置工具不动。写坏的档案跳过并记日志，其余照常登记。
 */
export function syncCustomTools(
  db: DatabaseSync,
  log: (message: string) => void = console.warn,
) {
  const rows = all<{ name: string; source: string }>(
    db,
    "SELECT name,source FROM worker_profiles WHERE layer='harness' ORDER BY name LIMIT 500",
  );
  const next = new Map<string, Adapter>();
  for (const row of rows) {
    if (isBuiltinTool(row.name)) continue;
    const { spec, problems } = parseToolSpec(
      row.name,
      parseProfileSource(row.source).rules,
    );
    if (spec) next.set(row.name, acpAdapter(spec));
    else log(`执行者档案 harness/${row.name} 没登记：${problems.join("；")}`);
  }
  for (const name of Object.keys(ADAPTERS))
    if (!isBuiltinTool(name) && !next.has(name)) delete ADAPTERS[name];
  for (const [name, adapter] of next) ADAPTERS[name] = adapter;
  return [...next.keys()];
}
