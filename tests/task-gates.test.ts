import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addedFunctions,
  ciFromChecks,
  evaluateGates,
  extractClaims,
  parseNumstat,
  type Facts,
} from "../server/tasks/gates/gates.ts";

const baseFacts: Facts = {
  repo: true,
  branch: "task-t1-x",
  base: "main",
  pr: null,
  ci: null,
  numstat: [],
  functions: [],
  dirty: [],
  ahead: 1,
  pushed: true,
  claims: [],
};

test("关卡解析：numstat、CI 汇总、新增函数长度、摘要里的声明", () => {
  assert.deepEqual(parseNumstat("3\t1\ta.ts\n-\t-\tlogo.png\n"), [
    { file: "a.ts", added: 3, removed: 1 },
    { file: "logo.png", added: 0, removed: 0 },
  ]);
  assert.equal(ciFromChecks([]), null);
  assert.equal(
    ciFromChecks([{ bucket: "pass" }, { bucket: "skipping" }]),
    "success",
  );
  assert.equal(
    ciFromChecks([{ bucket: "pass" }, { bucket: "pending" }]),
    "pending",
  );
  assert.equal(
    ciFromChecks([{ bucket: "pending" }, { bucket: "fail" }]),
    "failure",
  );

  const body = Array.from({ length: 90 }, (_, i) => `+  const v${i} = ${i};`);
  const diff = [
    "+++ b/src/big.ts",
    "@@ -0,0 +1,95 @@",
    "+export function huge(a: number) {",
    ...body,
    "+  if (a) {",
    "+    return 1;",
    "+  }",
    "+}",
    "+const small = (x: number) => x + 1;",
    "+++ b/app.py",
    "@@ -0,0 +1,3 @@",
    "+def tiny():",
    "+    return 1",
  ].join("\n");
  assert.deepEqual(addedFunctions(diff), [
    { file: "src/big.ts", name: "huge", lines: 95 },
    { file: "src/big.ts", name: "small", lines: 1 },
    { file: "app.py", name: "tiny", lines: 2 },
  ]);

  assert.deepEqual(
    extractClaims(
      "开了 PR #45（https://github.com/o/r/pull/45），提交 a1b2c3d，Closes #262，数字 1234567 与单词 deadbeef 不算",
    ),
    [
      { kind: "pr", value: "45" },
      { kind: "commit", value: "a1b2c3d" },
    ],
  );
});

test("关卡判定：没 PR 写明原因、不认识的关卡（含 ci）忽略、上帝文件与虚报打回", () => {
  const noPr = evaluateGates(
    ["pr_exists", "ci"],
    {},
    {
      ...baseFacts,
      prError: "none of the git remotes point to a known GitHub host",
    },
  );
  assert.equal(noPr.passed, false);
  assert.deepEqual(
    noPr.results.map((r) => r.gate),
    ["pr_exists"],
  );
  assert.match(
    noPr.failed[0]!.evidence,
    /gh pr list --head task-t1-x 没找到 PR.*GitHub host/,
  );

  // 远端 CI 不挡合入：CI 还在跑或失败都不影响关卡，写错的关卡名也不判不过。
  const pr = { number: 7, url: "https://x/pull/7", state: "OPEN" };
  for (const ci of ["pending", "failure", "unavailable"] as const) {
    const done = evaluateGates(
      ["pr_exists", "ci", "finished", "no_such_gate"],
      {},
      {
        ...baseFacts,
        pr,
        ci,
      },
    );
    assert.equal(done.passed, true, ci);
    assert.deepEqual(
      done.results.map((r) => r.gate),
      ["pr_exists", "finished"],
    );
  }

  const unfinished = evaluateGates(
    ["finished"],
    {},
    {
      ...baseFacts,
      dirty: ["a.ts"],
      pushed: false,
      ahead: 0,
    },
  );
  assert.match(
    unfinished.failed[0]!.evidence,
    /未提交.*没有新提交.*未推送.*PR 没开/,
  );

  const growth = evaluateGates(
    ["file_growth"],
    { max_file_added_lines: 300, max_function_lines: 80 },
    {
      ...baseFacts,
      numstat: [{ file: "god.ts", added: 900, removed: 0 }],
      functions: [{ file: "god.ts", name: "all", lines: 120 }],
    },
  );
  assert.match(
    growth.failed[0]!.evidence,
    /god\.ts 新增 900 行.*all 有 120 行/,
  );

  const lies = evaluateGates(
    ["claims_verified", "bogus"],
    {},
    {
      ...baseFacts,
      claims: [
        {
          kind: "pr",
          value: "99",
          ok: false,
          detail: "no pull requests found",
        },
        { kind: "commit", value: "abc1234", ok: true },
      ],
    },
  );
  assert.equal(lies.failed.length, 1);
  assert.match(lies.failed[0]!.evidence, /PR #99/);
});
