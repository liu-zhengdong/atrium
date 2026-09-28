import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuietWatch } from "../server/tasks/merge/check-quiet-watch.ts";
import { runLocalCheck } from "../server/tasks/merge/local-check.ts";
import { classifyCheck } from "../server/tasks/merge/check-outcome.ts";
import { stillRunningLine } from "./still-running.ts";
import { nodeCommand } from "./portable-shell.ts";
import { removeTemp } from "./temp-dir.ts";

test("QuietWatch：心跳不算输出；从最近一次输出起满时限结束并报卡在哪，只报一次", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-quiet-watch-"));
  try {
    const file = join(root, "local-check.log");
    writeFileSync(file, "抬头（不算这次的输出）\n");
    let now = 0;
    const stalls: (string | null)[] = [];
    const watch = new QuietWatch({
      file,
      stallMs: 10_000,
      pollMs: 60_000,
      now: () => now,
      onStall: (at) => stalls.push(at),
    });
    await watch.start();
    now = 9_000;
    appendFileSync(file, `${stillRunningLine("tests/a.test.ts", 9)}\n`);
    await watch.poll();
    assert.deepEqual(stalls, []);
    // 又有输出：重新计时。
    now = 9_500;
    appendFileSync(file, "✔ 用例 (1ms)\n");
    await watch.poll();
    now = 19_499;
    appendFileSync(file, `${stillRunningLine("tests/b.test.ts", 70)}\n`);
    await watch.poll();
    assert.deepEqual(stalls, []);
    now = 19_500;
    await watch.poll();
    assert.deepEqual(stalls, ["tests/b.test.ts"]);
    // 结束后不再报。
    now = 30_000;
    await watch.poll();
    assert.deepEqual(stalls, ["tests/b.test.ts"]);
  } finally {
    removeTemp(root);
  }
});

test("QuietWatch：一次长出很多、日志被截断重写都算输出；读不到日志按没输出", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-quiet-watch-"));
  try {
    const file = join(root, "local-check.log");
    let now = 0;
    const stalls: (string | null)[] = [];
    const watch = new QuietWatch({
      file,
      stallMs: 1_000,
      pollMs: 60_000,
      now: () => now,
      onStall: (at) => stalls.push(at),
    });
    await watch.start();
    now = 500;
    writeFileSync(file, `${"x".repeat(200_000)}\n`);
    await watch.poll();
    writeFileSync(file, "重写\n");
    now = 1_200;
    await watch.poll();
    now = 2_199;
    await watch.poll();
    assert.deepEqual(stalls, []);
    now = 2_200;
    await watch.poll();
    assert.deepEqual(stalls, ["重写"]);
  } finally {
    removeTemp(root);
  }
});

function checkTree() {
  const root = mkdtempSync(join(tmpdir(), "atrium-quiet-check-"));
  const worktree = join(root, "worktree");
  mkdirSync(join(worktree, ".agents"), { recursive: true });
  return { root, worktree, dir: join(root, "task") };
}

test("检查日志到期没新输出：结束，已查出的失败用例照旧交回（没过）", async () => {
  const { root, worktree, dir } = checkTree();
  try {
    writeFileSync(
      join(worktree, ".agents", "check"),
      nodeCommand(
        "console.log('✖ 已经坏了 (3ms)'); setInterval(() => console.error('仍在跑：tests/hang.test.ts（已 9 秒）'), 50)",
      ),
    );
    const started = Date.now();
    const result = await runLocalCheck({
      worktree,
      taskDir: dir,
      // 时限留足 node 起进程的时间，免得机器忙时第一行输出之前就结束。
      stallMs: 2_500,
      quietPollMs: 50,
    });
    assert.ok(Date.now() - started < 20_000);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.failedTests, ["已经坏了 (3ms)"]);
    assert.deepEqual(result.stalled, { at: "tests/hang.test.ts" });
    assert.equal(result.infra, undefined);
    assert.match(result.detail, /没有新输出，卡在 tests\/hang.test.ts/);
    assert.equal(classifyCheck(result, []).outcome, "failed");
    assert.match(
      readFileSync(result.log, "utf8"),
      /\[atrium\] 日志 .*没有新输出/,
    );
  } finally {
    removeTemp(root);
  }
});

test("检查日志到期没新输出且没有失败用例：结束并算没跑成（卡住），写卡在哪", async () => {
  const { root, worktree, dir } = checkTree();
  try {
    writeFileSync(
      join(worktree, ".agents", "check"),
      nodeCommand("console.log('✔ 好的 (1ms)'); setTimeout(() => {}, 60000)"),
    );
    const result = await runLocalCheck({
      worktree,
      taskDir: dir,
      stallMs: 2_000,
      quietPollMs: 50,
    });
    assert.equal(result.status, "timeout");
    assert.deepEqual(result.failedTests, []);
    assert.deepEqual(result.stalled, { at: "✔ 好的 (1ms)" });
    assert.match(result.infra!, /^检查卡住：/);
    assert.equal(classifyCheck(result, []).outcome, "not_run");
  } finally {
    removeTemp(root);
  }
});

test("一直有输出的检查不结束", async () => {
  const { root, worktree, dir } = checkTree();
  try {
    writeFileSync(
      join(worktree, ".agents", "check"),
      nodeCommand(
        "let n = 0; const t = setInterval(() => { console.log('✔ ' + n); if (++n === 20) { clearInterval(t); } }, 100)",
      ),
    );
    const busy = await runLocalCheck({
      worktree,
      taskDir: dir,
      stallMs: 2_500,
      quietPollMs: 30,
    });
    assert.equal(busy.status, "passed");
    assert.equal(busy.stalled, undefined);
  } finally {
    removeTemp(root);
  }
});
