/**
 * 思考耗尽单次输出（#262）：识别 opencode 最后一步 reason=length、正文为 0 的结束，
 * 收尾原因写明思考耗尽，并换一个执行者重跑一次；再没交付就留在受阻。
 * 夹具截自 runtime-data/tasks/11/log-1790450366110 最后几行（json-log/opencode-length.jsonl）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  abnormalEnding,
  parseEvents,
  thinkingExhausted,
  type JsonEvent,
} from "../server/tasks/json-log.ts";
import { decideExit, type ExitDecision } from "../server/tasks/outcome.ts";
import {
  routeAfterThinking,
  thinkingAttempts,
} from "../server/tasks/thinking.ts";
import { getTask } from "../server/tasks/ledger.ts";
import { startApp } from "./task-fixture.ts";

const sample = join(
  import.meta.dirname,
  "fixtures",
  "json-log",
  "opencode-length.jsonl",
);
const log = readFileSync(sample, "utf8");
const finishes = parseEvents(log).filter(
  (event) => event.type === "step_finish",
);
/** 实测最后一步：reason length，reasoning 32000，output 0。 */
const exhausted = finishes.at(-1)!;

/** 改最后一步的 reason 与 token 数，其余照抄实测行。 */
function variant(reason: string, tokens: Record<string, number>): JsonEvent {
  const part = exhausted.part as Record<string, unknown>;
  return {
    ...exhausted,
    part: {
      ...part,
      reason,
      tokens: { ...(part.tokens as object), ...tokens },
    },
  };
}

test("识别思考耗尽：reason=length 且正文 0 或极少；有正文、正常 stop 不算", () => {
  assert.deepEqual(thinkingExhausted(exhausted), {
    reasoning: 32000,
    output: 0,
    limit: 32000,
  });
  assert.deepEqual(abnormalEnding(parseEvents(log)), {
    kind: "thinking",
    reason: "思考耗尽单次输出（reasoning 32000 / 上限 32000，正文 0）",
  });
  // 正文极少（一两句）仍算。
  assert.deepEqual(
    thinkingExhausted(variant("length", { reasoning: 31980, output: 20 })),
    { reasoning: 31980, output: 20, limit: 32000 },
  );
  // reason=length 但有正文：是长度用尽，不是思考耗尽。
  const withText = variant("length", { reasoning: 12000, output: 20000 });
  assert.equal(thinkingExhausted(withText), undefined);
  assert.deepEqual(abnormalEnding([withText]), {
    kind: "length",
    reason: "上下文或输出长度用尽",
  });
  // 没有思考 token（不支持思考的模型）：也是长度用尽。
  assert.equal(
    thinkingExhausted(variant("length", { reasoning: 0, output: 0 })),
    undefined,
  );
  // 正常 stop、tool-calls 不算。
  assert.equal(thinkingExhausted(variant("stop", {})), undefined);
  assert.equal(thinkingExhausted(finishes[0]!), undefined);
  assert.equal(abnormalEnding([variant("stop", {})]), undefined);
  // 缺 tokens 或不是 step_finish：不猜。
  assert.equal(
    thinkingExhausted({ type: "step_finish", part: { reason: "length" } }),
    undefined,
  );
  assert.equal(thinkingExhausted({ type: "text", part: {} }), undefined);
});

test("收尾原因：思考耗尽写在关卡原因前面；非 PR 交付转受阻而不是失败", () => {
  const ending = "思考耗尽单次输出（reasoning 32000 / 上限 32000，正文 0）";
  const exit = { code: 0, signal: null };
  const pr = decideExit({
    exit,
    retried: false,
    retryAllowed: true,
    ending,
    thinking: true,
    verdict: {
      passed: false,
      awaitingCi: false,
      results: [],
      failed: [{ gate: "pr_exists", ok: false, evidence: "没找到 PR" }],
    },
  });
  assert.equal(pr.event, "block");
  assert.equal(pr.reason, `${ending}；关卡不过：pr_exists：没找到 PR`);
  const comment = decideExit({
    exit,
    retried: false,
    retryAllowed: true,
    ending,
    thinking: true,
    abnormalFatal: true,
  });
  assert.deepEqual(comment, {
    event: "block",
    publish: "blocked",
    reason: ending,
    retry: false,
  });
  // 普通长度用尽照旧失败。
  assert.equal(
    decideExit({
      exit,
      retried: false,
      retryAllowed: true,
      ending: "上下文或输出长度用尽",
      abnormalFatal: true,
    }).event,
    "exit_fail",
  );
});

test("换执行者重跑的去向：第一次换人，换过一次就放弃；已交付、被停下、非思考耗尽不重跑", () => {
  const blocked: ExitDecision = {
    event: "block",
    publish: "blocked",
    reason: "x",
    retry: false,
  };
  const base = { thinking: true, decision: blocked, attempts: 0 };
  assert.deepEqual(routeAfterThinking(base), { kind: "switch" });
  assert.deepEqual(routeAfterThinking({ ...base, attempts: 1 }), {
    kind: "give_up",
    why: "思考耗尽后已换过一次执行者",
  });
  const none = { kind: "none" };
  assert.deepEqual(routeAfterThinking({ ...base, thinking: false }), none);
  assert.deepEqual(
    routeAfterThinking({ ...base, stop: { kind: "user" } }),
    none,
  );
  assert.deepEqual(
    routeAfterThinking({
      ...base,
      decision: { event: "exit_ok", publish: "done", retry: false },
    }),
    none,
  );
  assert.deepEqual(
    routeAfterThinking({
      ...base,
      decision: { ...blocked, publish: "ci_unavailable" },
    }),
    none,
  );
  assert.deepEqual(
    routeAfterThinking({
      ...base,
      verdict: { passed: false, awaitingCi: true, results: [], failed: [] },
    }),
    none,
  );
  // 次数从最后一次非重试的拉起往后数；人工再派重新计数。
  const start = (retry: boolean) => ({
    kind: "start",
    detail: JSON.stringify({ detail: retry ? { retry: true } : {} }),
  });
  const retry = { kind: "thinking_retry", detail: "{}" };
  assert.equal(thinkingAttempts([start(false)]), 0);
  assert.equal(thinkingAttempts([start(false), retry, start(true)]), 1);
  assert.equal(
    thinkingAttempts([start(false), retry, start(true), start(false)]),
    0,
  );
});

test("派活：opencode 思考耗尽后换 kimi 重跑一次，仍没交付就留在受阻", async (t) => {
  const { fx, data, call } = await startApp(t, (fx) => {
    const bin = join(fx.root, "bin");
    writeFileSync(
      join(bin, "opencode"),
      `#!/bin/sh\ncat '${sample}'\nexit 0\n`,
    );
    rmSync(join(bin, "grok"), { force: true });
    const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    if (!existsSync(join(bin, "git"))) symlinkSync(git, join(bin, "git"));
    fx.env.PATH = `${bin}:/usr/bin:/bin`;
    writeFileSync(
      join(fx.workers, "harness", "opencode.md"),
      "---\nchecks: [pr_exists]\n---\n",
    );
  });
  await call("POST", "/api/tasks", { title: "thinking", repo: fx.repo });
  await call("POST", "/api/tasks/t1/run", { worker: "opencode" });
  const task = (await call("GET", "/api/tasks/t1/wait?timeout=30")).body.task;
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const events = getTask(db, "t1").events;
  const kinds = events.map((event) => event.kind);
  const details = (kind: string) =>
    events
      .filter((event) => event.kind === kind)
      .map((event) => JSON.parse(event.detail!));
  assert.equal(task.status, "blocked", JSON.stringify(kinds));
  assert.equal(task.worker, "kimi");
  const [retry, ...more] = details("thinking_retry");
  assert.equal(more.length, 0);
  assert.equal(retry.retry, "switch");
  assert.equal(retry.from, "opencode+opencode-go/mimo-v2.6-flash");
  assert.equal(retry.to, "kimi");
  assert.match(
    retry.reason,
    /^思考耗尽单次输出（reasoning 32000 \/ 上限 32000，正文 0）；关卡不过：pr_exists/,
  );
  const blocks = details("block");
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].detail.reason, /^思考耗尽单次输出/);
  assert.doesNotMatch(blocks[1].detail.reason, /思考耗尽/);
  assert.equal(details("start")[1].detail.retry, true);
  // 同一任务的结局通知按键合并：未读的换人通知被最终的受阻覆盖，历史留在 task_events。
  const inbox = await call("GET", "/api/events/wait?as=secretary&timeout=0");
  assert.deepEqual(
    inbox.body.events.map((event: { kind: string }) => event.kind),
    ["blocked"],
  );
});
