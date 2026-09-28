import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STALL_RERUNS,
  scanOutput,
  stalledCheck,
  stuckAt,
} from "../server/tasks/check-quiet.ts";
import {
  classifyCheck,
  MAX_CHECK_RERUNS,
  rerunDecision,
  type CheckClass,
} from "../server/tasks/check-outcome.ts";
import { failedTestNames } from "../server/tasks/local-check.ts";
import { stillRunningLine } from "./still-running.ts";

const MIN = 60_000;

test("scanOutput：心跳和空行不算输出，半行心跳留到下次拼，别的半行当场算", () => {
  const beat = stillRunningLine("tests/a.test.ts", 65);
  assert.deepEqual(scanOutput("", ""), { output: false, carry: "" });
  assert.deepEqual(scanOutput("", "\n\n  \n"), { output: false, carry: "" });
  assert.deepEqual(scanOutput("", `${beat}\n${beat}\n`), {
    output: false,
    carry: "",
  });
  assert.equal(scanOutput("", `${beat}\n✔ a (1ms)\n`).output, true);
  // 心跳被切成两半：前半截等下次，拼起来仍是心跳。
  const cut = scanOutput("", `${beat.slice(0, 2)}`);
  assert.deepEqual(cut, { output: false, carry: beat.slice(0, 2) });
  const cut2 = scanOutput("", `${beat.slice(0, 8)}`);
  assert.equal(cut2.output, false);
  assert.deepEqual(scanOutput(cut2.carry, `${beat.slice(8)}\n`), {
    output: false,
    carry: "",
  });
  // 进度点、提示符这类不换行的输出当场算。
  assert.equal(scanOutput("", "....").output, true);
  assert.equal(scanOutput("", "  ").output, false);
  // 已经算过的半行，没有新内容时不再算。
  assert.equal(scanOutput("....", "").output, false);
  // 行首空白不影响认心跳。
  assert.equal(scanOutput("", `  ${beat}\n`).output, false);
  // 超长的半行只留尾部。
  assert.equal(scanOutput("", "x".repeat(10_000)).carry.length, 4096);
});

test("stuckAt：末尾心跳里跑得最久的文件；末尾不是心跳取最后一行；空日志为 null", () => {
  assert.equal(stuckAt(""), null);
  assert.equal(stuckAt("\n  \n"), null);
  assert.equal(stuckAt("✔ a (1ms)\n▶ suite\n"), "▶ suite");
  assert.equal(
    stuckAt(
      [
        stillRunningLine("tests/old.test.ts", 900),
        "✔ b (2ms)",
        stillRunningLine("tests/a.test.ts", 70),
        stillRunningLine("tests/b.test.ts", 400),
        stillRunningLine("tests/a.test.ts", 130),
      ].join("\r\n"),
    ),
    "tests/b.test.ts",
  );
  assert.equal(
    stuckAt(`${stillRunningLine("tests/only.test.ts", 61)}\n`),
    "tests/only.test.ts",
  );
  // 心跳之后又有输出：取那行输出，截到 200 字。
  assert.equal(
    stuckAt(`${stillRunningLine("tests/a.test.ts", 61)}\n${"y".repeat(300)}`),
    "y".repeat(200),
  );
  // 不合格式的「仍在跑」按普通行。
  assert.equal(stuckAt("仍在跑：乱写"), "仍在跑：乱写");
});

test("stalledCheck：有失败用例判没过并交回用例，没有判没跑成（卡住）并写卡在哪", () => {
  const withFailures = stalledCheck({
    failedTests: ["边界用例"],
    at: "tests/a.test.ts",
    stallMs: 10 * MIN,
  });
  assert.equal(withFailures.status, "failed");
  assert.equal(withFailures.infra, undefined);
  assert.deepEqual(withFailures.stalled, { at: "tests/a.test.ts" });
  assert.match(withFailures.detail, /10 分钟没有新输出，卡在 tests\/a.test.ts/);
  const stuck = stalledCheck({
    failedTests: [],
    at: "tests/a.test.ts",
    stallMs: 10 * MIN,
  });
  assert.equal(stuck.status, "timeout");
  assert.match(stuck.infra!, /^检查卡住：.*卡在 tests\/a.test.ts/);
  const nowhere = stalledCheck({
    failedTests: [],
    at: null,
    stallMs: 10 * MIN,
  });
  assert.doesNotMatch(nowhere.detail, /卡在/);

  // 接上 t204 的分类：失败用例交回；只挂在时长敏感用例上仍算没跑成；没有失败用例算没跑成。
  const classify = (failedTests: string[], patterns: string[]) =>
    classifyCheck(
      {
        failedTests,
        ...stalledCheck({
          failedTests,
          at: "tests/a.test.ts",
          stallMs: 10 * MIN,
        }),
      },
      patterns,
    ).outcome;
  assert.equal(classify(["边界用例 (12ms)"], []), "failed");
  assert.equal(classify(["边界用例 (12ms)"], ["边界用例"]), "not_run");
  assert.equal(classify([], []), "not_run");
  assert.equal(classify([], ["边界用例"]), "not_run");
});

test("卡住结束前日志里的失败用例照常认出（spec 与 TAP 两种写法）", () => {
  const log = [
    "✔ 好的 (1ms)",
    "✖ 坏的 (3ms)",
    "not ok 7 - 也坏",
    stillRunningLine("tests/a.test.ts", 600),
  ].join("\n");
  assert.deepEqual(failedTestNames(log), ["坏的 (3ms)", "也坏"]);
});

test("rerunDecision：卡住的没跑成只重跑 MAX_STALL_RERUNS 次，其余照 t204", () => {
  const outcomes: CheckClass[] = ["passed", "failed", "not_run"];
  for (const outcome of outcomes)
    for (let reruns = 0; reruns <= MAX_CHECK_RERUNS; reruns++)
      for (const stalled of [false, true])
        for (let stalledReruns = 0; stalledReruns <= reruns; stalledReruns++) {
          const want =
            outcome === "not_run" &&
            reruns < MAX_CHECK_RERUNS &&
            !(stalled && stalledReruns >= MAX_STALL_RERUNS)
              ? "rerun"
              : "final";
          assert.equal(
            rerunDecision({ outcome, reruns, stalled, stalledReruns }),
            want,
            `${outcome} ${reruns} ${stalled} ${stalledReruns}`,
          );
        }
  // 旧调用不带卡住信息：照 t204。
  assert.equal(rerunDecision({ outcome: "not_run", reruns: 0 }), "rerun");
  // 之前因别的原因重跑过，这次第一次卡住：还能重跑。
  assert.equal(
    rerunDecision({
      outcome: "not_run",
      reruns: 2,
      stalled: true,
      stalledReruns: 0,
    }),
    "rerun",
  );
});
