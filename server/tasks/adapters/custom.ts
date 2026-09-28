import type { FrontValue } from "../workers/frontmatter.ts";
import { cliAdapter } from "./cli.ts";
import { parseCliSpec } from "./cli-spec.ts";
import { dropAdapter, isBuiltinTool, registerAdapter } from "./index.ts";

/**
 * 按一份 harness 档案的规则登记或撤下通用执行者（t271）：写了 protocol 且写对了就登记，否则撤下。
 * 只动登记表、不读库；读库的批量登记在 custom-tools.ts。返回毛病，没毛病为空。
 */
export function syncFromRules(
  name: string,
  rules: Record<string, FrontValue | undefined> | undefined,
): string[] {
  if (isBuiltinTool(name)) return [];
  if (rules?.protocol === undefined) {
    dropAdapter(name);
    return [];
  }
  const { spec, problems } = parseCliSpec(name, rules);
  if (!spec) {
    dropAdapter(name);
    return problems;
  }
  registerAdapter(cliAdapter(name, spec));
  return [];
}
