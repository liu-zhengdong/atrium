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
import { evaluateGates, type Facts } from "../server/tasks/gates/gates.ts";
import {
  checkCommand,
  runLocalCheck,
  type LocalCheck,
} from "../server/tasks/merge/local-check.ts";
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

test("local_check 关卡交付时不跑全量检查，说明由合入队列在 rebase 后跑", () => {
  const verdict = evaluateGates(["local_check"], {}, facts);
  assert.equal(verdict.passed, true);
  assert.match(verdict.results[0]!.evidence, /合入队列在 rebase 后跑一次/);
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
