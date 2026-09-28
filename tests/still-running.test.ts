import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyStep,
  dueFiles,
  runStep,
  stillRunningLine,
  STILL_RUNNING_MS,
  type FileRun,
} from "./still-running.ts";
import { scanOutput, stuckAt } from "../server/tasks/merge/check-quiet.ts";
import { removeTemp } from "./temp-dir.ts";

test("runStep：文件级的开始与结束、用例结束，其余事件不管", () => {
  const file = "/r/tests/a.test.ts";
  const cases: [string, Record<string, unknown> | null, unknown][] = [
    [
      "test:dequeue",
      { file, name: file, nesting: 0 },
      { kind: "file_start", file },
    ],
    [
      "test:complete",
      { file, name: file, nesting: 0 },
      { kind: "file_end", file },
    ],
    [
      "test:complete",
      { file, name: "用例", nesting: 0 },
      { kind: "test_done", file },
    ],
    [
      "test:complete",
      { file, name: file, nesting: 1 },
      { kind: "test_done", file },
    ],
    ["test:dequeue", { file, name: "用例", nesting: 0 }, null],
    ["test:enqueue", { file, name: file, nesting: 0 }, null],
    ["test:pass", { file, name: "用例", nesting: 0 }, null],
    ["test:complete", { name: "没有文件", nesting: 0 }, null],
    ["test:complete", { file: "", name: "", nesting: 0 }, null],
    ["test:summary", null, null],
  ];
  for (const [type, data, want] of cases)
    assert.deepEqual(
      runStep({ type, data }),
      want,
      `${type} ${JSON.stringify(data)}`,
    );
});

test("applyStep 与 dueFiles：一个文件久没有用例结束才打印，之后每隔一段再打印", () => {
  const files = new Map<string, FileRun>();
  const q = STILL_RUNNING_MS;
  applyStep(files, { kind: "file_start", file: "a" }, 0);
  applyStep(files, { kind: "file_start", file: "b" }, 10_000);
  // 不在跑的文件的用例结束不建记录。
  applyStep(files, { kind: "test_done", file: "z" }, 10_000);
  assert.deepEqual([...files.keys()], ["a", "b"]);
  assert.deepEqual(dueFiles(files, q - 1), []);
  assert.deepEqual(dueFiles(files, q), [{ file: "a", seconds: 60 }]);
  // a 有用例结束：重新计。
  applyStep(files, { kind: "test_done", file: "a" }, q);
  assert.deepEqual(dueFiles(files, q + 10_000), [{ file: "b", seconds: 60 }]);
  files.get("b")!.printedAt = q + 10_000;
  assert.deepEqual(dueFiles(files, q + 20_000), []);
  // 两个都到点：跑得久的在前。
  assert.deepEqual(
    dueFiles(files, 2 * q + 10_000),
    [
      { file: "b", seconds: 120 },
      { file: "a", seconds: 130 },
    ].sort((x, y) => y.seconds - x.seconds),
  );
  applyStep(files, { kind: "file_end", file: "a" }, 2 * q);
  assert.deepEqual([...files.keys()], ["b"]);
  // 自定义时长。
  assert.deepEqual(dueFiles(files, q + 12_000, 1_000), [
    { file: "b", seconds: 62 },
  ]);
});

test("心跳行格式：检查的没输出检测不算它，卡在哪能从它读出文件", () => {
  const line = stillRunningLine("tests/a.test.ts", 125);
  assert.equal(line, "仍在跑：tests/a.test.ts（已 125 秒）");
  assert.equal(scanOutput("", `${line}\n`).output, false);
  assert.equal(stuckAt(`${line}\n`), "tests/a.test.ts");
});

test("run-tests 挂住的文件会打印「仍在跑」，spec 输出照旧", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // 放在仓库里被忽略的目录（run-tests 只收仓库内的文件；全量只扫 tests/ 顶层，不会捡到它）。
  const dir = join(root, `.atrium-still-running-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "slow.test.ts");
    writeFileSync(
      file,
      'import test from "node:test";\ntest("慢", async () => { await new Promise((r) => setTimeout(r, 1500)); });\n',
    );
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve("tsx/cli")),
        join(root, "tests", "run-tests.ts"),
        file,
      ],
      {
        cwd: root,
        encoding: "utf8",
        // 去掉 NODE_TEST_CONTEXT：不然里面那层 node --test 以为自己嵌在测试里，不跑文件。
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name !== "NODE_TEST_CONTEXT",
            ),
          ),
          ATRIUM_TEST_STILL_RUNNING_MS: "300",
        },
        timeout: 60_000,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stderr,
      /仍在跑：\.atrium-still-running-\d+\/slow\.test\.ts（已 \d+ 秒）/,
    );
    assert.match(run.stdout, /✔ 慢/);
  } finally {
    removeTemp(dir);
  }
});
