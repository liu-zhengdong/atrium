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
import {
  QuietWatch,
  type QuietEvent,
} from "../server/tasks/check-quiet-watch.ts";
import { runLocalCheck } from "../server/tasks/local-check.ts";
import { classifyCheck } from "../server/tasks/check-outcome.ts";
import { stillRunningLine } from "./still-running.ts";
import { nodeCommand } from "./portable-shell.ts";
import { removeTemp } from "./temp-dir.ts";

test("QuietWatch：心跳不算输出；到提醒线报一次，又有输出报恢复，到结束线报卡在哪", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-quiet-watch-"));
  try {
    const file = join(root, "local-check.log");
    writeFileSync(file, "抬头（不算这次的输出）\n");
    let now = 0;
    const events: QuietEvent[] = [];
    const stalls: (string | null)[] = [];
    const watch = new QuietWatch({
      file,
      limits: { warnMs: 5_000, stallMs: 10_000 },
      pollMs: 60_000,
      now: () => now,
      onEvent: (event) => events.push(event),
      onStall: (at) => stalls.push(at),
    });
    await watch.start();
    now = 4_000;
    appendFileSync(file, `${stillRunningLine("tests/a.test.ts", 4)}\n`);
    await watch.poll();
    assert.deepEqual(events, []);
    now = 5_000;
    await watch.poll();
    assert.deepEqual(events, [
      { kind: "quiet", quietMs: 5_000, at: "tests/a.test.ts" },
    ]);
    // 同一段安静只提醒一次。
    now = 6_000;
    await watch.poll();
    assert.equal(events.length, 1);
    // 又有输出：报恢复，重新计时。
    now = 7_000;
    appendFileSync(file, "✔ 用例 (1ms)\n");
    await watch.poll();
    assert.deepEqual(events.at(-1), { kind: "resumed" });
    now = 16_999;
    appendFileSync(file, `${stillRunningLine("tests/b.test.ts", 70)}\n`);
    await watch.poll();
    assert.deepEqual(events.at(-1), {
      kind: "quiet",
      quietMs: 9_999,
      at: "tests/b.test.ts",
    });
    assert.deepEqual(stalls, []);
    now = 17_000;
    await watch.poll();
    assert.deepEqual(stalls, ["tests/b.test.ts"]);
    // 结束后不再报。
    now = 30_000;
    await watch.poll();
    assert.deepEqual(stalls, ["tests/b.test.ts"]);
    assert.equal(events.length, 3);
  } finally {
    removeTemp(root);
  }
});

test("QuietWatch：一次长出很多、日志被截断重写都算输出；读不到日志按没输出", async () => {
  const root = mkdtempSync(join(tmpdir(), "atrium-quiet-watch-"));
  try {
    const file = join(root, "local-check.log");
    let now = 0;
    const events: QuietEvent[] = [];
    const watch = new QuietWatch({
      file,
      limits: { warnMs: 1_000, stallMs: null },
      pollMs: 60_000,
      now: () => now,
      onEvent: (event) => events.push(event),
    });
    await watch.start();
    now = 1_000;
    await watch.poll();
    assert.deepEqual(events, [{ kind: "quiet", quietMs: 1_000, at: null }]);
    writeFileSync(file, `${"x".repeat(200_000)}\n`);
    now = 1_500;
    await watch.poll();
    assert.deepEqual(events.at(-1), { kind: "resumed" });
    writeFileSync(file, "重写\n");
    now = 2_000;
    await watch.poll();
    now = 2_999;
    await watch.poll();
    assert.equal(events.length, 2);
    // 不结束：安静多久都只提醒。
    now = 1_000_000;
    await watch.poll();
    assert.deepEqual(events.at(-1), {
      kind: "quiet",
      quietMs: 998_000,
      at: "重写",
    });
    watch.stop();
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

test("检查日志太久没新输出：提醒后结束，已查出的失败用例照旧交回（没过）", async () => {
  const { root, worktree, dir } = checkTree();
  try {
    writeFileSync(
      join(worktree, ".agents", "check"),
      nodeCommand(
        "console.log('✖ 已经坏了 (3ms)'); setInterval(() => console.error('仍在跑：tests/hang.test.ts（已 9 秒）'), 50)",
      ),
    );
    const events: QuietEvent[] = [];
    const started = Date.now();
    const result = await runLocalCheck({
      worktree,
      taskDir: dir,
      // 提醒线留足 node 起进程的时间，免得机器忙时第一行输出之前就提醒。
      quiet: { warnMs: 1_500, stallMs: 2_500 },
      quietPollMs: 50,
      onQuiet: (event) => events.push(event),
    });
    assert.ok(Date.now() - started < 20_000);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.failedTests, ["已经坏了 (3ms)"]);
    assert.deepEqual(result.stalled, { at: "tests/hang.test.ts" });
    assert.equal(result.infra, undefined);
    assert.match(result.detail, /没有新输出，卡在 tests\/hang.test.ts/);
    assert.equal(classifyCheck(result, []).outcome, "failed");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "quiet");
    assert.equal(
      events[0]!.kind === "quiet" ? events[0]!.at : null,
      "tests/hang.test.ts",
    );
    assert.match(
      readFileSync(result.log, "utf8"),
      /\[atrium\] 日志 .*没有新输出/,
    );
  } finally {
    removeTemp(root);
  }
});

test("检查日志太久没新输出且没有失败用例：结束并算没跑成（卡住），写卡在哪", async () => {
  const { root, worktree, dir } = checkTree();
  try {
    writeFileSync(
      join(worktree, ".agents", "check"),
      nodeCommand("console.log('✔ 好的 (1ms)'); setTimeout(() => {}, 60000)"),
    );
    const result = await runLocalCheck({
      worktree,
      taskDir: dir,
      quiet: { warnMs: 1_000, stallMs: 2_000 },
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

test("一直有输出的检查不提醒也不结束；关掉结束线只提醒", async () => {
  const { root, worktree, dir } = checkTree();
  try {
    writeFileSync(
      join(worktree, ".agents", "check"),
      nodeCommand(
        "let n = 0; const t = setInterval(() => { console.log('✔ ' + n); if (++n === 20) { clearInterval(t); } }, 100)",
      ),
    );
    const events: QuietEvent[] = [];
    const busy = await runLocalCheck({
      worktree,
      taskDir: dir,
      quiet: { warnMs: 1_500, stallMs: 2_500 },
      quietPollMs: 30,
      onQuiet: (event) => events.push(event),
    });
    assert.equal(busy.status, "passed");
    assert.equal(busy.stalled, undefined);
    assert.equal(events.length, 0);

    writeFileSync(
      join(worktree, ".agents", "check"),
      nodeCommand("setTimeout(() => {}, 900)"),
    );
    const warnOnly = await runLocalCheck({
      worktree,
      taskDir: dir,
      quiet: { warnMs: 200, stallMs: null },
      quietPollMs: 30,
      onQuiet: (event) => events.push(event),
    });
    assert.equal(warnOnly.status, "passed");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "quiet");
  } finally {
    removeTemp(root);
  }
});
