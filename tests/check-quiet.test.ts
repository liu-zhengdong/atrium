import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STALL_RERUNS,
  QUIET_MINUTES,
  STALL_MINUTES,
  quietLimits,
  quietMinutes,
  quietStep,
  quietText,
  scanOutput,
  stalledCheck,
  stuckAt,
  type QuietLimits,
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

test("quietLimits：缺省 5 分钟提醒、10 分钟结束；可配、可关结束、写错照缺省并报出", () => {
  assert.deepEqual(quietLimits({}), {
    limits: { warnMs: QUIET_MINUTES * MIN, stallMs: STALL_MINUTES * MIN },
    problems: [],
  });
  assert.deepEqual(
    quietLimits({
      ATRIUM_QUIET_MINUTES: "3",
      ATRIUM_CHECK_STALL_MINUTES: "7.5",
    }).limits,
    { warnMs: 3 * MIN, stallMs: 7.5 * MIN },
  );
  for (const off of ["0", "off", "OFF", "none", "false"])
    assert.equal(
      quietLimits({ ATRIUM_CHECK_STALL_MINUTES: off }).limits.stallMs,
      null,
    );
  // 提醒不能关：写 off 算写错。
  for (const bad of ["off", "0", "-1", "abc", "99999"]) {
    const read = quietLimits({
      ATRIUM_QUIET_MINUTES: bad,
      ATRIUM_CHECK_STALL_MINUTES: bad === "off" || bad === "0" ? "" : bad,
    });
    assert.equal(read.limits.warnMs, QUIET_MINUTES * MIN, bad);
    assert.match(read.problems[0]!, /ATRIUM_QUIET_MINUTES=.* 看不懂/);
  }
  const wrong = quietLimits({ ATRIUM_CHECK_STALL_MINUTES: "十" });
  assert.equal(wrong.limits.stallMs, STALL_MINUTES * MIN);
  assert.match(wrong.problems[0]!, /ATRIUM_CHECK_STALL_MINUTES=十 看不懂/);
  // 空白按没写。
  assert.deepEqual(
    quietLimits({ ATRIUM_QUIET_MINUTES: " ", ATRIUM_CHECK_STALL_MINUTES: "" })
      .problems,
    [],
  );
});

test("quietStep：按安静时长 × 是否提醒过 × 结束线开关穷举", () => {
  const limits: QuietLimits = { warnMs: 5 * MIN, stallMs: 10 * MIN };
  const noStall: QuietLimits = { warnMs: 5 * MIN, stallMs: null };
  const cases: [number, boolean, QuietLimits, string][] = [
    [0, false, limits, "ok"],
    [5 * MIN - 1, false, limits, "ok"],
    [5 * MIN, false, limits, "warn"],
    [5 * MIN, true, limits, "ok"],
    [9 * MIN, false, limits, "warn"],
    [9 * MIN, true, limits, "ok"],
    [10 * MIN - 1, true, limits, "ok"],
    [10 * MIN, true, limits, "stall"],
    // 没提醒过（比如轮询间隔比提醒线长）到结束线也直接结束。
    [10 * MIN, false, limits, "stall"],
    [60 * MIN, true, limits, "stall"],
    [60 * MIN, false, noStall, "warn"],
    [60 * MIN, true, noStall, "ok"],
    // 结束线不晚于提醒线：到点直接结束。
    [5 * MIN, false, { warnMs: 5 * MIN, stallMs: 5 * MIN }, "stall"],
  ];
  for (const [quiet, warned, lim, want] of cases)
    assert.equal(
      quietStep({ lastOutputAt: 1_000, warned }, lim, 1_000 + quiet),
      want,
      `${quiet} ${warned} ${lim.stallMs}`,
    );
});

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

test("quietText 与 quietMinutes：整分钟往下取，不够一分钟按秒", () => {
  assert.equal(quietMinutes(5 * MIN), "5 分钟");
  assert.equal(quietMinutes(5 * MIN + 59_000), "5 分钟");
  assert.equal(quietMinutes(45_000), "45 秒");
  assert.equal(quietMinutes(200), "1 秒");
  assert.equal(
    quietText(5 * MIN + 3_000, "tests/task-usage-budget.test.ts"),
    "检查 5 分钟没输出：卡在 tests/task-usage-budget.test.ts",
  );
  assert.equal(quietText(5 * MIN, null), "检查 5 分钟没输出");
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
