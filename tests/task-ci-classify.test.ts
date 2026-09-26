import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  actionJob,
  classifyCi,
  type Check,
  type Job,
  type Annotation,
} from "../server/tasks/ci-classify.ts";
import { readCi } from "../server/tasks/facts.ts";
import { evaluateGates, type Facts } from "../server/tasks/gates.ts";
import { decideExit } from "../server/tasks/outcome.ts";
import type { Exec } from "../server/tasks/git.ts";

const sample = JSON.parse(
  readFileSync(
    new URL("./fixtures/ci-unavailable.json", import.meta.url),
    "utf8",
  ),
) as {
  checks: Check[];
  jobs: { jobs: Job[] };
  annotations: Annotation[];
};

test("真实 Actions 样本：零步骤与计费注解归入 CI 未运行", async () => {
  const calls: string[] = [];
  const run: Exec = async (command, args) => {
    assert.equal(command, "gh");
    calls.push(args.join(" "));
    const value =
      args[0] === "pr"
        ? sample.checks
        : args[1]?.includes("/jobs?")
          ? sample.jobs
          : sample.annotations;
    return { ok: args[0] !== "pr", stdout: JSON.stringify(value), stderr: "" };
  };
  const result = await readCi(
    "https://github.com/liu-zhengdong/atrium/pull/270",
    run,
  );
  assert.equal(result.ci, "unavailable");
  assert.match(
    result.detail!,
    /^The job was not started because recent account payments/,
  );
  assert.deepEqual(calls, [
    "pr checks https://github.com/liu-zhengdong/atrium/pull/270 --json name,bucket,link",
    "api repos/example/atrium/actions/runs/123456789/jobs?per_page=100",
    "api repos/example/atrium/check-runs/987654321/annotations?per_page=100",
  ]);
  const facts: Facts = {
    repo: true,
    branch: "task-x",
    base: "main",
    pr: {
      number: 270,
      url: "https://github.com/liu-zhengdong/atrium/pull/270",
      state: "OPEN",
    },
    ci: result.ci,
    ciDetail: result.detail,
    numstat: [],
    functions: [],
    dirty: [],
    ahead: 1,
    pushed: true,
    claims: [],
  };
  const verdict = evaluateGates(["ci"], {}, facts);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.awaitingCi, false);
  const decision = decideExit({
    exit: { code: 0, signal: null },
    retried: false,
    retryAllowed: true,
    verdict,
  });
  assert.equal(decision.event, "block");
  assert.equal(decision.publish, "ci_unavailable");
  assert.match(
    decision.reason!,
    /^CI 未运行：The job was not started.*需人工处理或本地验证$/,
  );
});

test("CI 判定：执行失败优先；仅零步骤或基础设施注解才算未运行", () => {
  const [check] = sample.checks;
  assert.deepEqual(actionJob(check!.link), {
    repo: "example/atrium",
    run: "123456789",
    job: 987654321,
  });
  assert.equal(actionJob("https://evil.example/actions/runs/1/job/2"), null);
  assert.equal(classifyCi([], []).ci, null);
  assert.equal(classifyCi([{ bucket: "pass" }], []).ci, "success");
  assert.equal(classifyCi([{ bucket: "pending" }], []).ci, "pending");
  assert.equal(
    classifyCi([check!], [{ check: check!, job: sample.jobs.jobs[0] }]).ci,
    "unavailable",
  );
  const executed = {
    ...sample.jobs.jobs[0]!,
    steps: [{ name: "npm test", conclusion: "failure" }],
  };
  assert.equal(
    classifyCi([check!], [{ check: check!, job: executed }]).ci,
    "failure",
  );
  assert.equal(
    classifyCi(
      [check!],
      [{ check: check!, job: executed, annotations: sample.annotations }],
    ).ci,
    "unavailable",
  );
  assert.equal(
    classifyCi([check!], []).ci,
    "failure",
    "查不到 job 不臆测未运行",
  );
  assert.match(
    classifyCi(
      [check!],
      [{ check: check!, job: { id: 987654321, status: "queued" } }],
    ).detail!,
    /仍在队列/,
  );
  const other = { name: "unit tests", bucket: "fail" };
  assert.equal(
    classifyCi([check!, other], [{ check: check!, job: sample.jobs.jobs[0] }])
      .ci,
    "failure",
  );
  assert.equal(
    classifyCi(
      [check!, { bucket: "pending" }],
      [{ check: check!, job: sample.jobs.jobs[0] }],
    ).ci,
    "unavailable",
  );
  for (const message of [
    "The job was not started because of queue timeout",
    "Billing quota exceeded",
    "No runners available",
    "付款失败，作业未开始",
  ])
    assert.equal(
      classifyCi(
        [other],
        [
          {
            check: other,
            annotations: [{ annotation_level: "failure", message }],
          },
        ],
      ).ci,
      "unavailable",
      message,
    );
  assert.equal(
    classifyCi(
      [other],
      [
        {
          check: other,
          annotations: [
            { annotation_level: "notice", message: "Billing quota exceeded" },
          ],
        },
      ],
    ).ci,
    "failure",
  );
});
