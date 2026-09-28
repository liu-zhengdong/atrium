import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptedEnd } from "../server/tasks/adopted-exit.ts";
import { decideExit, exitDetail } from "../server/tasks/outcome.ts";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  getTask,
} from "../server/tasks/ledger.ts";
import { TaskRunner } from "../server/tasks/runner.ts";
import {
  discardLegacyIdleRestart,
  readRestartState,
  writeRestartState,
} from "../server/supervisor.ts";
import { until } from "./task-fixture.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { spawnCommand } from "../server/platform/index.ts";
import { removeTemp } from "./temp-dir.ts";

const line = (event: object) => JSON.stringify(event);
const CLAUDE_OK = [
  line({
    type: "assistant",
    message: { content: [{ type: "text", text: "做完了" }] },
  }),
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    result: "做完了，已提交",
  }),
].join("\n");
const CLAUDE_ERROR = [
  line({
    type: "assistant",
    message: { content: [{ type: "text", text: "开始" }] },
  }),
  line({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
  }),
].join("\n");

test("接管后退出按日志收尾结构判结局：各工具穷举", () => {
  const cases: [Parameters<typeof adoptedEnd>[0], string, RegExp?][] = [
    [{ tool: "claude", log: CLAUDE_OK }, "clean", /end_turn/],
    [{ tool: "claude", log: CLAUDE_ERROR }, "error", /error_during_execution/],
    [
      { tool: "claude", log: line({ type: "assistant", message: {} }) },
      "error",
      /没有收尾的 result/,
    ],
    [{ tool: "claude" }, "unknown"],
    [
      {
        tool: "opencode",
        log: [
          line({ type: "step_start", part: {} }),
          line({ type: "text", part: { text: "ok" } }),
          line({ type: "step_finish", part: { reason: "stop" } }),
        ].join("\n"),
      },
      "clean",
      /reason=stop/,
    ],
    [
      {
        tool: "opencode",
        log: [
          line({ type: "step_finish", part: { reason: "stop" } }),
          line({
            type: "error",
            error: { name: "APIError", data: { message: "rate limited" } },
          }),
        ].join("\n"),
      },
      "error",
      /rate limited/,
    ],
    [
      {
        tool: "opencode",
        log: line({ type: "step_finish", part: { reason: "tool-calls" } }),
      },
      "error",
      /reason=tool-calls/,
    ],
    [
      { tool: "opencode", log: line({ type: "step_start", part: {} }) },
      "unknown",
    ],
    [{ tool: "codex", log: "whatever", lastMessage: "最终消息" }, "clean"],
    [{ tool: "codex", log: "whatever", lastMessage: "  " }, "unknown"],
    [{ tool: "codex", log: "whatever" }, "unknown"],
    [{ tool: "kimi", log: "完成" }, "unknown"],
    [{ tool: "grok", log: CLAUDE_OK }, "unknown"],
  ];
  for (const [input, end, evidence] of cases) {
    const got = adoptedEnd(input);
    assert.equal(got.end, end, JSON.stringify(input));
    if (evidence && got.end !== "unknown") assert.match(got.evidence, evidence);
  }
});

test("接管后退出的收尾决定：正常结束过关卡，出错判失败，判不了按原规则", () => {
  const verdict = { results: [], failed: [], passed: true, awaitingCi: false };
  const base = {
    exit: "unknown" as const,
    retried: true,
    retryAllowed: false,
    verdict,
    abnormalFatal: true,
  };
  assert.deepEqual(
    decideExit({ ...base, adopted: { end: "clean", evidence: "x" } }),
    { event: "exit_ok", publish: "done", retry: false },
  );
  const failed = decideExit({
    ...base,
    abnormalFatal: false,
    adopted: { end: "error", evidence: "result 事件 is_error=true" },
  });
  assert.equal(failed.event, "exit_fail");
  assert.match(
    failed.reason!,
    /^接管后退出，退出码不可得；日志显示出错结束：result 事件/,
  );
  const unknown = decideExit({ ...base, adopted: { end: "unknown" } });
  assert.equal(unknown.publish, "failed");
  assert.equal(unknown.reason, "接管后退出，退出码不可得");
  assert.doesNotMatch(unknown.reason!, /服务重启期间/);
  // PR 交付判不了的，仍按关卡（PR 与 CI）走。
  assert.equal(
    decideExit({ ...base, abnormalFatal: false, adopted: { end: "unknown" } })
      .publish,
    "done",
  );
});

function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-adopted-"));
  t.after(() => removeTemp(root));
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const runner = new TaskRunner(db, {
    data: root,
    workersDir: join(root, "workers"),
    env: { PATH: "/usr/bin:/bin" },
    tickMs: 100,
  });
  t.after(() => runner.close());
  /** 建一个 running 任务，日志里写好执行者的输出。 */
  const running = (worker: string, pid: number, log: string) => {
    const task = createTask(db, { title: `${worker} 任务`, deliver: "none" });
    advanceTask(db, task.ref, { kind: "start" }, { worker, pid });
    mkdirSync(join(root, "tasks", String(task.id)), { recursive: true });
    writeFileSync(join(root, "tasks", String(task.id), "log"), `${log}\n`);
    return task;
  };
  return { root, db, runner, running };
}

const DEAD_PID = 2 ** 22 + 12345;
const kinds = (db: DatabaseSync, ref: string) =>
  getTask(db, ref).events.map((event) => event.kind);
/** 状态转移事件的 detail 是 { from, to, detail }。 */
const transition = (event: { detail: string | null }) =>
  JSON.parse(event.detail!).detail;

test("重启窗口内已经退出：接管后补做收尾，按日志判正常结束或出错，事件照投", async (t) => {
  const { root, db, runner, running } = setup(t);
  const ok = running("claude", DEAD_PID, CLAUDE_OK);
  const bad = running("claude", DEAD_PID + 1, CLAUDE_ERROR);
  await runner.recover();

  const done = getTask(db, ok.ref);
  assert.equal(done.status, "done");
  assert.equal(done.result, "做完了，已提交");
  assert.deepEqual(kinds(db, ok.ref).slice(-3), [
    "adopted",
    "gates",
    "exit_ok",
  ]);
  assert.match(
    done.events.at(-3)!.detail!,
    /服务重启时执行者已退出，接管后补做收尾/,
  );
  const okLog = readFileSync(join(root, "tasks", String(ok.id), "log"), "utf8");
  assert.match(
    okLog,
    /\[atrium\] .* 接管后退出，退出码不可得；按日志判为正常结束（result 事件 stop_reason=end_turn）/,
  );
  // 判定依据同样写进事件，task show 能看到。
  const judgedOk = {
    exit: "unknown",
    judged: "按日志判为正常结束（result 事件 stop_reason=end_turn）",
  };
  assert.deepEqual(transition(done.events.at(-1)!), judgedOk);
  const gates = JSON.parse(done.events.at(-2)!.detail!);
  assert.equal(gates.exit, judgedOk.exit);
  assert.equal(gates.judged, judgedOk.judged);

  const failed = getTask(db, bad.ref);
  assert.equal(failed.status, "failed");
  assert.match(
    failed.events.at(-1)!.detail!,
    /接管后退出，退出码不可得；日志显示出错结束：result 事件 subtype=error_during_execution/,
  );
  assert.doesNotMatch(failed.events.at(-1)!.detail!, /服务重启期间/);
  assert.equal(
    transition(failed.events.at(-1)!).judged,
    "按日志判为异常结束（result 事件 subtype=error_during_execution stop_reason=无 is_error=true）",
  );

  const { events } = await runner.inbox.wait("secretary", 0);
  assert.deepEqual(events.map((event) => [event.key, event.kind]).sort(), [
    [`${ok.ref}:outcome`, "done"],
    [`${bad.ref}:outcome`, "failed"],
  ]);
});

test("档案解析不出的执行者无从收尾：置 failed 并说明原因", async (t) => {
  const { db, runner } = setup(t);
  const task = createTask(db, { title: "orphan" });
  advanceTask(
    db,
    task.ref,
    { kind: "start" },
    { worker: "nope", pid: DEAD_PID },
  );
  await runner.recover();
  const got = getTask(db, task.ref);
  assert.equal(got.status, "failed");
  assert.match(got.events.at(-1)!.detail!, /执行者档案解析不出/);
});

test("接管的执行者后来退出：看门狗发现后按日志收尾（正常结束、出错）", async (t) => {
  const { root, db, runner, running } = setup(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // 名字叫 claude 的假执行者：ownsPid 按命令行里的可执行名认领。
  const fake = writeFakeBin(join(bin, "claude"), '#!/bin/sh\nsleep "$1"\n');
  const start = (seconds: string) => {
    const child = spawnCommand(fake, [seconds], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    t.after(() => {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    });
    return child.pid!;
  };
  // 等接管完成后主动结束进程，避免机器忙时自然退出抢在状态断言前。
  const okPid = start("30");
  const badPid = start("30");
  const ok = running("claude", okPid, CLAUDE_OK);
  const bad = running("claude", badPid, CLAUDE_ERROR);
  runner.start();
  await until(
    () =>
      kinds(db, ok.ref).includes("adopted") &&
      kinds(db, bad.ref).includes("adopted"),
    10_000,
  );
  // 接管时进程还在跑：状态不变，不立即收尾。
  assert.equal(getTask(db, ok.ref).status, "running");
  assert.match(
    getTask(db, ok.ref).events.at(-1)!.detail!,
    /服务重启后按 pid 接管/,
  );
  process.kill(okPid, "SIGKILL");
  process.kill(badPid, "SIGKILL");
  await until(
    () =>
      getTask(db, ok.ref).status !== "running" &&
      getTask(db, bad.ref).status !== "running",
    15_000,
  );
  const done = getTask(db, ok.ref);
  assert.equal(done.status, "done");
  assert.equal(done.events.at(-1)!.kind, "exit_ok");
  assert.deepEqual(transition(done.events.at(-1)!), {
    exit: "unknown",
    judged: "按日志判为正常结束（result 事件 stop_reason=end_turn）",
  });
  const failed = getTask(db, bad.ref);
  assert.equal(failed.status, "failed");
  assert.match(
    failed.events.at(-1)!.detail!,
    /接管后退出，退出码不可得；日志显示出错结束/,
  );
  assert.match(
    transition(failed.events.at(-1)!).judged,
    /^按日志判为异常结束（result 事件 subtype=error_during_execution/,
  );
});

test("退出情况写进事件：接管后退出带判定依据，有退出码的不带", () => {
  assert.deepEqual(exitDetail({ code: 0, signal: null }), {
    code: 0,
    signal: null,
  });
  assert.deepEqual(exitDetail("unknown"), { exit: "unknown" });
  assert.deepEqual(
    exitDetail("unknown", {
      end: "clean",
      evidence: "result 事件 subtype=success",
    }),
    {
      exit: "unknown",
      judged: "按日志判为正常结束（result 事件 subtype=success）",
    },
  );
  assert.deepEqual(exitDetail("unknown", { end: "error", evidence: "e" }), {
    exit: "unknown",
    judged: "按日志判为异常结束（e）",
  });
  assert.deepEqual(exitDetail("unknown", { end: "unknown" }), {
    exit: "unknown",
    judged: "日志判不出正常或异常结束",
  });
  assert.deepEqual(
    exitDetail("unknown", { end: "error", evidence: "e" }, true),
    {
      exit: "unknown",
      judged: "按日志判为异常结束（e）；PR 在且 CI 通过，照常过关卡",
    },
  );
});

test("旧版遗留的待空闲重启记录：丢弃并记日志，不再挡派活", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-legacy-idle-"));
  t.after(() => removeTemp(root));
  for (const status of ["waiting_idle", "idle_timeout"] as const) {
    writeRestartState(root, {
      id: `rst-${status}`,
      status,
      supervisorPid: 0,
      startedAt: Date.now(),
      fromVersion: "0.1.38",
      data: root,
    });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      assert.equal(discardLegacyIdleRestart(root), true);
    } finally {
      console.warn = warn;
    }
    assert.equal(existsSync(join(root, "restart-state.json")), false);
    assert.match(
      warnings.join("\n"),
      new RegExp(`丢弃旧版待空闲重启记录（rst-${status}`),
    );
  }
  // 旧版写的 waiting_idle 带 idleDeadline，缺了也照样认出来丢弃，不当坏记录挪开。
  writeFileSync(
    join(root, "restart-state.json"),
    JSON.stringify({
      id: "rst-old",
      status: "waiting_idle",
      supervisorPid: 0,
      startedAt: 1,
      fromVersion: "0.1.30",
      data: root,
    }),
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(discardLegacyIdleRestart(root), true);
  } finally {
    console.warn = warn;
  }
  // 其余状态不动。
  const success = {
    id: "rst-ok",
    status: "success" as const,
    supervisorPid: 0,
    startedAt: Date.now(),
    fromVersion: "0.1.38",
    data: root,
  };
  writeRestartState(root, success);
  assert.equal(discardLegacyIdleRestart(root), false);
  assert.deepEqual(readRestartState(root), success);
});
