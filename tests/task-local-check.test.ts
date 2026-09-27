import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGates, type Facts } from "../server/tasks/gates.ts";
import {
  checkCommand,
  LocalCheckQueue,
  runLocalCheck,
  type LocalCheck,
} from "../server/tasks/local-check.ts";
import { removeTemp } from "./temp-dir.ts";
import { nodeCommand, sleepCommand } from "./portable-shell.ts";

const facts: Facts = {
  repo: true,
  branch: "task-t1",
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

test("local_check 只按运行时结果判定，失败原因包含用例名", () => {
  const base: LocalCheck = {
    status: "passed",
    command: "npm run check",
    log: "/tmp/local-check.log",
    detail: "检查通过",
    failedTests: [],
  };
  assert.equal(evaluateGates(["local_check"], {}, facts).passed, false);
  assert.equal(
    evaluateGates(["local_check"], {}, { ...facts, localCheck: base }).passed,
    true,
  );
  const failed = evaluateGates(
    ["local_check"],
    {},
    {
      ...facts,
      localCheck: {
        ...base,
        status: "failed",
        detail: "退出码 1",
        failedTests: ["边界用例"],
      },
    },
  );
  assert.match(failed.failed[0]!.evidence, /失败用例：边界用例/);
  assert.equal(failed.awaitingCi, false);
});

test("检查命令优先读取 .agents/check，缺失时读取 package.json", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-local-check-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { check: "true" } }),
    );
    assert.equal(await checkCommand(root), "npm run check");
    mkdirSync(join(root, ".agents"));
    writeFileSync(join(root, ".agents", "check"), "echo checked\n");
    assert.equal(await checkCommand(root), "echo checked");
    writeFileSync(join(root, ".agents", "check"), "");
    await assert.rejects(checkCommand(root), /为空/);
  } finally {
    removeTemp(root);
  }
});

test("拒绝指向工作树外的检查脚本", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-local-path-"));
  try {
    mkdirSync(join(root, "work", ".agents"), { recursive: true });
    writeFileSync(join(root, "outside"), "echo unsafe\n");
    symlinkSync(join(root, "outside"), join(root, "work", ".agents", "check"));
    const result = await runLocalCheck({
      worktree: join(root, "work"),
      taskDir: join(root, "task"),
    });
    assert.equal(result.status, "error");
    assert.match(result.detail, /工作树外/);
  } finally {
    removeTemp(root);
  }
});

test("本地检查输出落任务目录，超时杀进程组并记录失败用例", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-local-check-"));
  const worktree = join(root, "worktree");
  const dir = join(root, "task");
  mkdirSync(join(worktree, ".agents"), { recursive: true });
  try {
    const script = join(worktree, ".agents", "check");
    writeFileSync(
      script,
      nodeCommand(
        "console.log('worker=' + (process.env.ATRIUM_WORKER || '') + ' secret=' + (process.env.PRIVATE_TEST_TOKEN || '')); console.log('not ok 1 - 边界用例'); process.exit(1)",
      ),
    );
    const failed = await runLocalCheck({
      worktree,
      taskDir: dir,
      env: { PATH: process.env.PATH, PRIVATE_TEST_TOKEN: "hidden" },
    });
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.failedTests, ["边界用例"]);
    assert.match(readFileSync(failed.log, "utf8"), /not ok 1/);
    assert.match(readFileSync(failed.log, "utf8"), /worker=1 secret=$/m);

    writeFileSync(script, sleepCommand(10));
    const timed = await runLocalCheck({
      worktree,
      taskDir: dir,
      timeoutMs: 30,
    });
    assert.equal(timed.status, "timeout");
    assert.match(timed.detail, /超过/);
  } finally {
    removeTemp(root);
  }
});

test("多个任务共用队列，后一份等前一份结束再运行", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-local-queue-"));
  const queue = new LocalCheckQueue();
  const events: string[] = [];
  const marker = join(root, "order");
  try {
    for (const name of ["a", "b"]) {
      mkdirSync(join(root, name, ".agents"), { recursive: true });
      writeFileSync(
        join(root, name, ".agents", "check"),
        nodeCommand(
          `const fs = require('fs'); fs.appendFileSync(process.argv[1], '${name}-start\\n'); setTimeout(() => fs.appendFileSync(process.argv[1], '${name}-end\\n'), 100)`,
          marker,
        ),
      );
    }
    const run = (name: string) =>
      runLocalCheck({
        worktree: join(root, name),
        taskDir: join(root, `${name}-task`),
        queue,
        onStatus: (status) => events.push(`${name}:${status}`),
      });
    const [a, b] = await Promise.all([run("a"), run("b")]);
    assert.equal(a.status, "passed");
    assert.equal(b.status, "passed");
    assert.deepEqual(events, ["b:queued", "a:started", "b:started"]);
    assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), [
      "a-start",
      "a-end",
      "b-start",
      "b-end",
    ]);
  } finally {
    removeTemp(root);
  }
});
