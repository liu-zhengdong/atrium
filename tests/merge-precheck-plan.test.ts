import assert from "node:assert/strict";
import test from "node:test";
import {
  globalFile,
  MAX_PRECHECKS,
  pickPrechecks,
  precheckSlots,
  reuseDecision,
  type Precheck,
  type PrecheckCandidate,
  type ReuseInput,
} from "../server/tasks/merge-precheck-plan.ts";

const B = "b".repeat(40);
const M = "m".repeat(40);
const H = "h".repeat(40);

const input = (over: Partial<ReuseInput> = {}): ReuseInput => ({
  precheck: { head: H, base: B, outcome: "passed" },
  head: H,
  main: M,
  ancestor: true,
  taskFiles: ["server/a.ts", "tests/a.test.ts"],
  mainFiles: ["server/b.ts"],
  ...over,
});

test("复用判定：穷举提前检查结果 × main 动没动 × 祖先 × 文件", () => {
  const outcomes: Precheck["outcome"][] = ["passed", "failed", "not_run"];
  const fileSets: {
    name: string;
    taskFiles: string[] | null;
    mainFiles: string[] | null;
  }[] = [
    { name: "不相干", taskFiles: ["a.ts"], mainFiles: ["b.ts"] },
    { name: "同一文件", taskFiles: ["a.ts"], mainFiles: ["a.ts", "b.ts"] },
    { name: "依赖", taskFiles: ["a.ts"], mainFiles: ["package-lock.json"] },
    { name: "取不到", taskFiles: null, mainFiles: ["b.ts"] },
    { name: "main 没改文件", taskFiles: ["a.ts"], mainFiles: [] },
  ];
  for (const outcome of outcomes)
    for (const moved of [false, true])
      for (const ancestor of [false, true])
        for (const files of fileSets)
          for (const sameHead of [false, true]) {
            const decision = reuseDecision(
              input({
                precheck: { head: H, base: B, outcome },
                head: sameHead ? H : "x".repeat(40),
                main: moved ? M : B,
                ancestor,
                taskFiles: files.taskFiles,
                mainFiles: files.mainFiles,
              }),
            );
            const label = `${outcome}/${moved ? "main 前进" : "main 没动"}/${ancestor}/${files.name}/${sameHead}`;
            let expected: string;
            if (!sameHead || outcome === "not_run") expected = "recheck";
            else if (outcome === "failed")
              expected = moved ? "recheck" : "hand_back";
            else if (!moved) expected = "reuse";
            else if (!ancestor) expected = "recheck";
            else
              expected =
                files.name === "不相干" || files.name === "main 没改文件"
                  ? "reuse"
                  : "recheck";
            assert.equal(decision.kind, expected, label);
            assert.ok(decision.reason.length > 0, label);
          }
});

test("复用判定：没有提前检查就重跑，原因写清", () => {
  assert.deepEqual(reuseDecision(input({ precheck: null })), {
    kind: "recheck",
    reason: "没有提前检查",
  });
  assert.match(
    reuseDecision(input({ mainFiles: ["server/a.ts", "x.ts"] })).reason,
    /main 改了同一批文件：server\/a\.ts/,
  );
  assert.match(
    reuseDecision(input({ mainFiles: ["tsconfig.json"] })).reason,
    /依赖或检查配置：tsconfig\.json/,
  );
  assert.match(
    reuseDecision(input({ mainFiles: ["docs/x.md", "docs/y.md"] })).reason,
    /不相干的改动（2 个文件）/,
  );
  // 同一批文件多了只列前五个。
  const many = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
  assert.match(
    reuseDecision(input({ taskFiles: many, mainFiles: many })).reason,
    /f4\.ts 等 8 个$/,
  );
});

test("会影响整个仓库检查的文件", () => {
  for (const path of [
    "package.json",
    "package-lock.json",
    "sub/package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "tsconfig.build.json",
    ".agents/check",
    ".agents\\timing-sensitive",
    ".nvmrc",
  ])
    assert.equal(globalFile(path), true, path);
  for (const path of [
    "server/package.ts",
    "tsconfig.ts",
    "docs/tsconfig.md",
    ".agents/README.md",
    "README.md",
  ])
    assert.equal(globalFile(path), false, path);
});

test("提前检查几件：留一个名额给队首，至多 3 件；显式配置与写错", () => {
  const live: NodeJS.ProcessEnv = {};
  for (const [max, slots] of [
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
    [8, MAX_PRECHECKS],
  ] as const)
    assert.deepEqual(precheckSlots({ maxChecks: max, env: live }), {
      slots,
      problem: null,
    });
  // 测试进程没显式设置时关掉。
  assert.equal(
    precheckSlots({ maxChecks: 8, env: { NODE_TEST_CONTEXT: "child" } }).slots,
    0,
  );
  for (const [raw, slots] of [
    ["0", 0],
    ["off", 0],
    ["OFF", 0],
    ["2", 2],
    ["12", 12],
    [" 5 ", 5],
    ["", 3],
  ] as const)
    assert.deepEqual(
      precheckSlots({
        maxChecks: 8,
        env: { ATRIUM_MERGE_PRECHECKS: raw, NODE_TEST_CONTEXT: "child" },
      }),
      { slots: raw === "" ? 0 : slots, problem: null },
      raw,
    );
  for (const raw of ["-1", "abc", "1.5", "100"]) {
    const planned = precheckSlots({
      maxChecks: 4,
      env: { ATRIUM_MERGE_PRECHECKS: raw },
    });
    assert.equal(planned.slots, 3, raw);
    assert.match(planned.problem!, /ATRIUM_MERGE_PRECHECKS=.*看不懂/);
  }
});

const c = (
  id: number,
  over: Partial<PrecheckCandidate> = {},
): PrecheckCandidate => ({
  id,
  local: true,
  done: false,
  running: false,
  ...over,
});

test("挑哪几件提前检查：只看窗口内、跳过远程与做过的、在跑的占名额", () => {
  const queued = [c(1), c(2), c(3), c(4)];
  const pick = (
    list: PrecheckCandidate[],
    slots: number,
    over: { running?: number; paused?: boolean } = {},
  ) =>
    pickPrechecks({
      queued: list,
      slots,
      running: over.running ?? list.filter((item) => item.running).length,
      paused: over.paused ?? false,
    });
  assert.deepEqual(pick(queued, 2), [1, 2]);
  assert.deepEqual(pick(queued, 1), [1]);
  assert.deepEqual(pick(queued, 0), []);
  assert.deepEqual(pick(queued, -1), []);
  assert.deepEqual(pick(queued, 2, { paused: true }), []);
  assert.deepEqual(pick([], 2), []);
  // 窗口里的做过了、是远程：不往窗口外找。
  assert.deepEqual(
    pick([c(1, { done: true }), c(2, { local: false }), c(3)], 2),
    [],
  );
  // 在跑的占名额，也不重复开。
  assert.deepEqual(pick([c(1, { running: true }), c(2), c(3)], 2), [2]);
  assert.deepEqual(
    pick([c(1, { running: true }), c(2, { running: true }), c(3)], 2),
    [],
  );
  // 窗口外还在跑的（队首换人前开的、队首接手在等的）也占名额。
  assert.deepEqual(pick([c(1), c(2), c(3)], 2, { running: 1 }), [1]);
  assert.deepEqual(pick([c(1), c(2), c(3)], 2, { running: 3 }), []);
});
