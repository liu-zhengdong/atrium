/**
 * `npm test` 跑哪些文件（t206）：不带参数跑全部；列出文件只跑这些；
 * `--changed` 按改动文件粗匹配相关测试（文件名 + 直接 import）。
 * 这里只做判定，读 git、读文件在 run-tests.ts。路径一律是仓库相对的 `/` 路径。
 */
import { posix } from "node:path";

export type TestArgs =
  | { mode: "all"; passthrough: string[] }
  | { mode: "files"; files: string[]; passthrough: string[] }
  | { mode: "changed"; passthrough: string[] }
  | { mode: "error"; message: string };

/** 解析 `npm test -- …` 的参数；`--changed` 以外的 `--` 开头参数原样交给 node --test。 */
export function parseTestArgs(argv: readonly string[]): TestArgs {
  const files: string[] = [];
  const passthrough: string[] = [];
  let changed = false;
  for (const arg of argv) {
    if (arg === "--changed") changed = true;
    else if (arg.startsWith("-")) passthrough.push(arg);
    else if (arg.trim()) files.push(arg);
  }
  if (changed && files.length)
    return {
      mode: "error",
      message:
        "--changed 和测试文件只能二选一：npm test -- --changed 或 npm test -- tests/名字.test.ts",
    };
  if (changed) return { mode: "changed", passthrough };
  if (files.length) return { mode: "files", files, passthrough };
  return { mode: "all", passthrough };
}

const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** 文件里直接 import 的相对路径，解析成仓库相对路径；`.js` 按 `.ts` 源文件算。 */
export function importsOf(file: string, source: string): string[] {
  const dir = posix.dirname(file);
  const found = new Set<string>();
  for (const match of source.matchAll(importPattern)) {
    const target = posix.normalize(posix.join(dir, match[1]!));
    found.add(target.replace(/\.js$/, ".ts"));
  }
  return [...found];
}

const codeFile = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

function stemOf(file: string): string {
  return posix
    .basename(file)
    .replace(/\.test\.ts$/, "")
    .replace(codeFile, "");
}

export type Selection = {
  /** 要跑的测试文件，按路径排序。 */
  tests: string[];
  /** 改了代码但没匹配到任何测试的文件。 */
  unmatched: string[];
};

/**
 * 改动文件 → 相关测试。匹配规则（粗匹配，宁多勿漏但不追传递依赖）：
 * - 改的就是测试文件：只跑它；
 * - 测试直接 import 了改动文件（含 tests/ 下的辅助文件）：跑它；
 * - 测试文件名与改动文件同名，或以「同名-」开头（ledger.ts → ledger.test.ts、ledger-tree.test.ts）：跑它。
 * 文档、配置等非代码改动不算没匹配。
 */
export function relatedTests(
  changed: readonly string[],
  testImports: ReadonlyMap<string, readonly string[]>,
): Selection {
  const importers = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  for (const [test, imports] of testImports) {
    for (const target of imports) {
      const list = importers.get(target) ?? [];
      list.push(test);
      importers.set(target, list);
    }
    // 按文件名的每个「-」前缀登记：hosts-check-plan 登记在 hosts、hosts-check、hosts-check-plan 下。
    const parts = stemOf(test).split("-");
    for (let i = 1; i <= parts.length; i++) {
      const key = parts.slice(0, i).join("-");
      const list = byStem.get(key) ?? [];
      list.push(test);
      byStem.set(key, list);
    }
  }
  const tests = new Set<string>();
  const unmatched: string[] = [];
  for (const file of changed) {
    if (testImports.has(file)) {
      tests.add(file);
      continue;
    }
    const hits = new Set<string>();
    for (const test of importers.get(file) ?? []) hits.add(test);
    for (const test of byStem.get(stemOf(file)) ?? []) hits.add(test);
    for (const test of hits) tests.add(test);
    if (!hits.size && codeFile.test(file)) unmatched.push(file);
  }
  return { tests: [...tests].sort(), unmatched };
}
