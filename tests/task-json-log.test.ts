import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  abnormalEnding,
  lastAssistantText,
  parseEvents,
} from "../server/tasks/logs/json-log.ts";
import { pollCiOnce } from "../server/tasks/gates/ci-poll.ts";
import { decideExit } from "../server/tasks/gates/outcome.ts";
import { summarize } from "../server/tasks/logs/summary.ts";
import {
  advanceTask,
  createTask,
  getTask,
  ensureTaskTables,
} from "../server/tasks/ledger/ledger.ts";
import type { Exec } from "../server/tasks/git.ts";
import { startApp } from "./task-fixture.ts";

/** 夹具截自夜间实跑日志（runtime-data/tasks/8、11、12），长工具输出已截短。 */
const sample = (name: string) =>
  join(import.meta.dirname, "fixtures", "json-log", name);
const read = (name: string) => readFileSync(sample(name), "utf8");
const ending = (name: string) => abnormalEnding(parseEvents(read(name)));

test("结构化日志摘要：取最后一条助手文本，取不到退回日志末尾", () => {
  assert.match(summarize(read("opencode-stop.jsonl"), true), /^完成。/);
  assert.match(
    summarize(read("claude-stream.jsonl"), true),
    /^I found and fixed the root cause, and opened PR #278/,
  );
  // 最后一条是 claude 的 assistant 文本、没有 result 时也取文本。
  const noResult = read("claude-stream.jsonl").trim().split("\n").slice(0, -1);
  assert.match(
    lastAssistantText(parseEvents(noResult.join("\n")))!,
    /^I found and fixed/,
  );
  // 日志末尾截断在半行 JSON 上不影响取文本。
  assert.match(
    summarize(read("opencode-stop.jsonl").slice(200), true),
    /^完成。/,
  );
  const noText = read("opencode-length.jsonl");
  assert.equal(summarize(noText, true), summarize(noText));
  assert.equal(summarize("a\nb\n", true), "a\nb");
  // 非结构化执行者不按 JSON 取文本。
  const plain = '{"type":"text","part":{"text":"x"}}\nfin';
  assert.equal(summarize(plain), plain);
});

test("异常结束：长度用尽、权限被拒、中途退出；正常收尾不算", () => {
  // 这份夹具最后一步正文为 0，是思考耗尽（task-thinking.test.ts 细测）；有正文的长度结束才是长度用尽。
  assert.equal(ending("opencode-length.jsonl")?.kind, "thinking");
  assert.deepEqual(
    abnormalEnding(
      parseEvents(
        read("opencode-length.jsonl").replace('"output":0', '"output":20000'),
      ),
    ),
    { kind: "length", reason: "上下文或输出长度用尽" },
  );
  assert.deepEqual(ending("opencode-rejected.jsonl"), {
    kind: "permission",
    reason:
      "权限被拒后结束：cat ~/.gitconfig 2>/dev/null; echo ---; git config --global --list 2>/dev/null",
  });
  assert.deepEqual(ending("opencode-midway.jsonl"), {
    kind: "midway",
    reason: "对话中途退出",
  });
  assert.equal(ending("opencode-stop.jsonl"), undefined);
  assert.equal(ending("claude-stream.jsonl"), undefined);
  assert.equal(abnormalEnding([]), undefined);

  // 被拒之后同一步里还有成功的调用（task 11 第一轮）：仍按最后一个出错的调用判。
  const lines = read("opencode-rejected.jsonl").trim().split("\n");
  const later = lines
    .at(-2)!
    .replace('"status":"error"', '"status":"completed"');
  const mixed = [
    ...lines.slice(0, -1),
    lines.at(-2)!.replace("call_3aeae", "call_x"),
    later,
    lines.at(-1)!,
  ];
  assert.equal(
    abnormalEnding(parseEvents(mixed.join("\n")))?.kind,
    "permission",
  );
  // 更早一步里的拒绝不算：最后一步以工具调用结束，判中途退出。
  const earlier = [
    ...lines,
    ...read("opencode-midway.jsonl").trim().split("\n").slice(1),
  ];
  assert.equal(abnormalEnding(parseEvents(earlier.join("\n")))?.kind, "midway");
  // 别的工具错误不算权限被拒。
  const other = lines.map((line) =>
    line.replace(
      "The user rejected permission to use this specific tool call.",
      "boom",
    ),
  );
  assert.equal(abnormalEnding(parseEvents(other.join("\n")))?.kind, "midway");
  // 工具调用那步之后有文本：不算中途退出。
  const text = '{"type":"text","part":{"type":"text","text":"收尾"}}';
  const answered = [...read("opencode-midway.jsonl").trim().split("\n"), text];
  assert.equal(abnormalEnding(parseEvents(answered.join("\n"))), undefined);
});

test("收尾原因：异常结束写在失败与受阻原因前面，通过与被停下的不写", () => {
  const verdict = {
    passed: false,
    awaitingCi: false,
    results: [],
    failed: [{ gate: "finished", ok: false, evidence: "没收尾：PR 没开" }],
  };
  const base = { retried: false, retryAllowed: true };
  assert.equal(
    decideExit({
      ...base,
      exit: { code: 0, signal: null },
      verdict,
      ending: "上下文或输出长度用尽",
    }).reason,
    "上下文或输出长度用尽；关卡不过：finished：没收尾：PR 没开",
  );
  assert.equal(
    decideExit({
      ...base,
      exit: { code: 1, signal: null },
      ending: "对话中途退出",
    }).reason,
    "对话中途退出；执行者退出码 1",
  );
  const passed = decideExit({
    ...base,
    exit: { code: 0, signal: null },
    verdict: { ...verdict, passed: true, failed: [] },
    ending: "对话中途退出",
  });
  assert.equal(passed.publish, "done");
  assert.equal(passed.reason, undefined);
  assert.equal(
    decideExit({
      ...base,
      stop: { kind: "idle", reason: "20 分钟无进展" },
      exit: { code: 0, signal: null },
      ending: "对话中途退出",
    }).reason,
    "20 分钟无进展",
  );
});

test("CI 轮询：已完成或已取消的任务不再查 CI", async () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  const asked: string[] = [];
  const run: Exec = async (_command, args) => {
    asked.push(args[2]!);
    return {
      ok: false,
      stdout: JSON.stringify([{ name: "check", bucket: "fail" }]),
      stderr: "",
    };
  };
  for (const [n, end] of [
    [1, "exit_ok"],
    [2, "cancel"],
    [3, "block"],
  ] as const) {
    createTask(db, { title: `t${n}` });
    advanceTask(db, `t${n}`, { kind: "start" }, { worker: "kimi" });
    advanceTask(
      db,
      `t${n}`,
      { kind: end },
      { pr_url: `https://github.com/o/r/pull/${n}`, ci: "pending" },
    );
  }
  const outcomes = await pollCiOnce(db, 10, run);
  assert.deepEqual(asked, ["https://github.com/o/r/pull/3"]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.task.ref, outcome.ci]),
    [["t3", "failure"]],
  );
  assert.equal(getTask(db, "t1").ci, "pending");
  db.close();
});

test("派活收尾：opencode 权限被拒后退出，受阻原因写明被拒的命令", async (t) => {
  const { fx, data, call } = await startApp(t, (fx) => {
    writeFileSync(
      join(fx.root, "bin", "opencode"),
      `#!/bin/sh\ncat '${sample("opencode-rejected.jsonl")}'\n`,
    );
    writeFileSync(
      join(fx.workers, "harness", "opencode.md"),
      "---\nchecks: [finished]\n---\n",
    );
  });
  await call("POST", "/api/tasks", { title: "rejected", repo: fx.repo });
  await call("POST", "/api/tasks/t1/run", { worker: "opencode" });
  const waited = await call("GET", "/api/tasks/t1/wait?timeout=20");
  assert.equal(waited.body.task.status, "blocked");
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const block = getTask(db, "t1").events.find(
    (event) => event.kind === "block",
  );
  assert.match(
    block!.detail!,
    /权限被拒后结束：cat ~\/\.gitconfig.*；关卡不过：finished：没收尾/,
  );
  const events = await call("GET", "/api/events/wait?as=secretary&timeout=0");
  assert.match(events.body.events[0].detail.reason, /^权限被拒后结束：cat/);
});
