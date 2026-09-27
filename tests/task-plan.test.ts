import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admit,
  placement,
  riskRefusal,
  trustRefusal,
  runRequest,
} from "../server/tasks/plan.ts";
import {
  decideExit,
  needsFacts,
  type Exit,
  type Stop,
} from "../server/tasks/outcome.ts";
import { RISKS, TRUSTS, type Risk } from "../server/tasks/profiles.ts";
import { TASK_STATUSES } from "../server/tasks/state.ts";
import type { Verdict } from "../server/tasks/gates.ts";

test("派活计划穷举：状态 × 在跑 × 排队 → 受理或拒绝", () => {
  let cases = 0;
  for (const status of TASK_STATUSES)
    for (const running of [false, true])
      for (const queued of [false, true]) {
        cases++;
        const result = admit({ status, running, queued });
        const want =
          !running && !queued && ["todo", "failed", "blocked"].includes(status);
        assert.equal(
          result.ok,
          want,
          `${status} running=${running} queued=${queued}`,
        );
        if (!result.ok) assert.match(result.reason, /[一-鿿]/);
        if (running)
          assert.equal(
            result.ok || result.reason,
            "正在运行或正在启动，不能重复派",
          );
        else if (queued) assert.equal(result.ok || result.reason, "已在排队");
      }
  assert.equal(cases, 6 * 2 * 2);
  assert.equal(placement(true, true), "queue");
  assert.equal(placement(true, false), "launch");
  assert.equal(placement(false, true), "launch");
  assert.equal(placement(false, false), "launch");
});

test("风险上限穷举：max_risk × 任务 risk", () => {
  for (const max of [undefined, ...RISKS] as (Risk | undefined)[])
    for (const risk of RISKS) {
      const refusal = riskRefusal("kimi", max, risk);
      const refuse =
        max !== undefined && RISKS.indexOf(max) < RISKS.indexOf(risk);
      assert.equal(!!refusal, refuse, `${max} vs ${risk}`);
      if (refusal)
        assert.match(refusal, new RegExp(`max_risk=${max}.*risk=${risk}`));
    }
});

test("额度换人信任等级穷举：缺省 unknown，trust 必须覆盖任务 risk", () => {
  for (const trust of [undefined, ...TRUSTS] as (
    (typeof TRUSTS)[number] | undefined
  )[])
    for (const risk of RISKS)
      assert.equal(
        !!trustRefusal("candidate", trust, risk),
        TRUSTS.indexOf(trust ?? "unknown") <= RISKS.indexOf(risk),
        `${trust} vs ${risk}`,
      );
});

test("run 请求校验：只认 worker、risk", () => {
  assert.deepEqual(runRequest(undefined), {});
  assert.deepEqual(runRequest({ worker: " codex ", risk: "high" }), {
    worker: "codex",
    risk: "high",
  });
  assert.deepEqual(runRequest({ worker: "", risk: null }), {
    worker: undefined,
    risk: undefined,
  });
  assert.throws(() => runRequest([]), /JSON 对象/);
  assert.throws(() => runRequest({ worker: 1 }), /worker: 应为文本/);
  assert.throws(() => runRequest({ risk: "huge" }), /risk: 只能是/);
  assert.throws(() => runRequest({ model: "x" }), /不认识的字段/);
});

const verdicts: Record<string, Verdict> = {
  passed: { results: [], passed: true, awaitingCi: false, failed: [] },
  awaiting: {
    results: [],
    passed: false,
    awaitingCi: true,
    failed: [
      { gate: "ci", ok: false, pending: true, evidence: "CI 还没出结果" },
    ],
  },
  failed: {
    results: [],
    passed: false,
    awaitingCi: false,
    failed: [{ gate: "pr_exists", ok: false, evidence: "没找到 PR" }],
  },
};

test("退出收尾穷举：停止原因 × 退出情况 × 重试 × 关卡结论", () => {
  const stops: (Stop | undefined)[] = [
    undefined,
    { kind: "user" },
    { kind: "stalled", reason: "卡死" },
    { kind: "idle", reason: "空闲" },
  ];
  const exits: Exit[] = [
    { code: 0, signal: null },
    { code: 2, signal: null },
    { code: null, signal: "SIGTERM" },
    "unknown",
  ];
  let cases = 0;
  for (const stop of stops)
    for (const exit of exits)
      for (const retried of [false, true])
        for (const retryAllowed of [false, true])
          for (const [name, verdict] of Object.entries(verdicts)) {
            cases++;
            const got = decideExit({
              stop,
              exit,
              retried,
              retryAllowed,
              verdict,
            });
            const label = `${stop?.kind ?? "none"} ${JSON.stringify(exit)} r=${retried}/${retryAllowed} ${name}`;
            assert.equal(needsFacts(stop), stop === undefined);
            if (stop?.kind === "user")
              assert.deepEqual(
                got,
                {
                  event: "exit_fail",
                  publish: "failed",
                  reason: "人工停止",
                  retry: false,
                },
                label,
              );
            else if (stop?.kind === "stalled")
              assert.deepEqual(
                got,
                {
                  event: "exit_fail",
                  publish: "failed",
                  reason: "卡死",
                  retry: !retried && retryAllowed,
                },
                label,
              );
            else if (stop?.kind === "idle")
              assert.deepEqual(
                got,
                {
                  event: "block",
                  publish: "blocked",
                  reason: "空闲",
                  retry: false,
                },
                label,
              );
            else if (exit !== "unknown" && (exit.code !== 0 || exit.signal)) {
              assert.equal(got.event, "exit_fail", label);
              assert.match(
                got.reason!,
                exit.signal ? /信号 SIGTERM/ : /退出码 2/,
              );
            } else if (name === "passed")
              assert.deepEqual(
                got,
                { event: "exit_ok", publish: "done", retry: false },
                label,
              );
            else {
              assert.equal(got.event, "block", label);
              assert.match(
                got.reason!,
                name === "awaiting"
                  ? /^等 CI：ci：/
                  : /^关卡不过：pr_exists：没找到 PR/,
              );
            }
          }
  assert.equal(cases, 4 * 4 * 2 * 2 * 3);
  assert.throws(
    () =>
      decideExit({
        exit: { code: 0, signal: null },
        retried: false,
        retryAllowed: true,
      }),
    /关卡结论/,
  );
});
