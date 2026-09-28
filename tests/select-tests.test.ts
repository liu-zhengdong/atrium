/**
 * t206：npm test 只跑指定或相关的测试文件。这里穷举参数解析、import 解析与改动匹配。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { importsOf, parseTestArgs, relatedTests } from "./select-tests.ts";

test("参数：不带跑全部，列文件只跑这些，--changed 按改动，其余 - 开头原样透传", () => {
  assert.deepEqual(parseTestArgs([]), { mode: "all", passthrough: [] });
  assert.deepEqual(
    parseTestArgs(["tests/a.test.ts", "--test-name-pattern=x", "b.test.ts"]),
    {
      mode: "files",
      files: ["tests/a.test.ts", "b.test.ts"],
      passthrough: ["--test-name-pattern=x"],
    },
  );
  assert.deepEqual(parseTestArgs(["--changed", "--test-only"]), {
    mode: "changed",
    passthrough: ["--test-only"],
  });
  assert.deepEqual(parseTestArgs(["--test-only"]), {
    mode: "all",
    passthrough: ["--test-only"],
  });
  assert.deepEqual(parseTestArgs(["  "]), { mode: "all", passthrough: [] });
  const both = parseTestArgs(["--changed", "tests/a.test.ts"]);
  assert.equal(both.mode, "error");
  assert.match(both.mode === "error" ? both.message : "", /二选一/);
});

test("import 解析：from、动态 import、副作用 import 都算，.js 按 .ts 源文件，包名不算", () => {
  const source = [
    'import { a } from "../server/tasks/ledger.ts";',
    'import type { B } from "../server/org/schema.js";',
    'import "./fake-bin.ts";',
    'const m = await import("../cli/main.ts");',
    "import {\n  c,\n} from './temp-dir.ts';",
    'import { test } from "node:test";',
    'import yaml from "yaml";',
  ].join("\n");
  assert.deepEqual(importsOf("tests/x.test.ts", source).sort(), [
    "cli/main.ts",
    "server/org/schema.ts",
    "server/tasks/ledger.ts",
    "tests/fake-bin.ts",
    "tests/temp-dir.ts",
  ]);
  assert.deepEqual(importsOf("tests/x.test.ts", ""), []);
});

const imports = new Map<string, string[]>([
  ["tests/ledger.test.ts", ["server/tasks/ledger.ts", "tests/temp-dir.ts"]],
  ["tests/ledger-tree.test.ts", ["server/tasks/ledger-tree.ts"]],
  ["tests/hosts-check-plan.test.ts", ["server/hosts/check-plan.ts"]],
  ["tests/hosts.test.ts", ["tests/fake-bin.ts"]],
  ["tests/map.test.ts", ["server/map/overview.ts", "tests/temp-dir.ts"]],
]);

test("改动匹配：改测试只跑它（不按名字前缀带上别的），import 了改动文件的跑，同名或同名- 开头的跑", () => {
  assert.deepEqual(relatedTests(["tests/hosts.test.ts"], imports), {
    tests: ["tests/hosts.test.ts"],
    unmatched: [],
  });
  assert.deepEqual(relatedTests(["server/map/overview.ts"], imports), {
    tests: ["tests/map.test.ts"],
    unmatched: [],
  });
  // ledger.ts：直接 import 的 ledger.test.ts + 同名开头的 ledger-tree.test.ts
  assert.deepEqual(relatedTests(["server/tasks/ledger.ts"], imports).tests, [
    "tests/ledger-tree.test.ts",
    "tests/ledger.test.ts",
  ]);
  // 多段前缀：hosts-check → hosts-check-plan，但不带上 hosts.test.ts
  assert.deepEqual(relatedTests(["cli/hosts-check.ts"], imports).tests, [
    "tests/hosts-check-plan.test.ts",
  ]);
  // 同名前缀只按整段算：ledger-tre 不算 ledger-tree
  assert.deepEqual(relatedTests(["server/ledger-tre.ts"], imports), {
    tests: [],
    unmatched: ["server/ledger-tre.ts"],
  });
});

test("改动匹配：测试辅助文件改了跑所有引用它的测试，结果去重排序", () => {
  assert.deepEqual(
    relatedTests(["tests/temp-dir.ts", "server/map/overview.ts"], imports),
    { tests: ["tests/ledger.test.ts", "tests/map.test.ts"], unmatched: [] },
  );
});

test("改动匹配：文档与配置不算没匹配，代码文件没匹配到列出来", () => {
  assert.deepEqual(
    relatedTests(
      [
        "README.md",
        "AGENTS.md",
        "package.json",
        "server/nothing.ts",
        "bin/x.mjs",
      ],
      imports,
    ),
    { tests: [], unmatched: ["server/nothing.ts", "bin/x.mjs"] },
  );
  assert.deepEqual(relatedTests([], imports), { tests: [], unmatched: [] });
});
