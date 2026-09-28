import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDelivery } from "../server/tasks/gates/delivery-gates.ts";
import { collectComments } from "../server/tasks/gates/comment-facts.ts";
import { decideExit } from "../server/tasks/gates/outcome.ts";
import type { Facts } from "../server/tasks/gates/gates.ts";

const start = Date.parse("2026-09-27T10:00:00.000Z");
const end = start + 10_000;
const link =
  "https://github.com/liu-zhengdong/atrium/issues/262#issuecomment-123";
const common = {
  issue: 262,
  startedAt: start,
  endedAt: end,
  checks: ["pr_exists", "ci", "finished"],
  limits: {},
};
const comment = (at: number) => ({
  created_at: new Date(at).toISOString(),
  html_url: link,
});

test("交付关卡按类型判定，评论必须在本轮期间出现", () => {
  const prFacts: Facts = {
    repo: true,
    branch: "task-t1",
    base: "main",
    pr: null,
    ci: null,
    numstat: [],
    functions: [],
    dirty: [],
    ahead: 0,
    pushed: false,
    claims: [],
  };
  assert.equal(
    evaluateDelivery({ ...common, deliver: "pr", facts: prFacts }).passed,
    false,
  );
  assert.equal(
    evaluateDelivery({ ...common, deliver: "pr", facts: prFacts }).failed[0]
      ?.gate,
    "pr_exists",
  );
  assert.deepEqual(
    evaluateDelivery({ ...common, deliver: "none" }).results,
    [],
  );
  for (const [comments, passed] of [
    [[comment(start - 1000)], false],
    [[comment(start)], true],
    [[comment(end + 1000)], false],
    [[], false],
  ] as const) {
    const result = evaluateDelivery({
      ...common,
      deliver: "comment",
      comments: { comments: [...comments] },
    });
    assert.equal(result.passed, passed);
    assert.deepEqual(
      result.results.map((r) => r.gate),
      ["comment"],
    );
    if (passed) assert.match(result.results[0]!.evidence, /#issuecomment-123/);
  }
  assert.equal(
    evaluateDelivery({
      ...common,
      deliver: "comment",
      comments: { comments: [], error: "404" },
    }).passed,
    false,
  );
  assert.equal(
    evaluateDelivery({ ...common, deliver: "comment", issue: null }).passed,
    false,
  );
});

test("评论事实只读 gh 分页输出并保留失败原因", async () => {
  const calls: string[][] = [];
  const facts = await collectComments(
    "/tmp/repo",
    262,
    start,
    async (command, args) => {
      if (command === "git") {
        assert.deepEqual(args, [
          "-C",
          "/tmp/repo",
          "remote",
          "get-url",
          "origin",
        ]);
        return { ok: true, stdout: "git@github.com:o/r.git\n", stderr: "" };
      }
      assert.equal(command, "gh");
      calls.push(args);
      return {
        ok: true,
        stdout: JSON.stringify([[comment(start + 1000)], []]),
        stderr: "",
      };
    },
  );
  assert.deepEqual(facts.comments, [comment(start + 1000)]);
  assert.deepEqual(calls[0]?.slice(0, 2), [
    "api",
    "repos/o/r/issues/262/comments",
  ]);
  assert(calls[0]?.includes("--paginate"));
  assert.equal((await collectComments(null, 262, start)).comments.length, 0);
});

test("无交付物任务按退出码与异常结束识别", () => {
  const verdict = evaluateDelivery({ ...common, deliver: "none" });
  const base = {
    exit: { code: 0, signal: null },
    retried: false,
    retryAllowed: false,
    verdict,
    abnormalFatal: true,
  } as const;
  assert.equal(decideExit(base).publish, "done");
  assert.equal(
    decideExit({ ...base, ending: "上下文或输出长度用尽" }).publish,
    "failed",
  );
  assert.equal(
    decideExit({ ...base, exit: { code: 1, signal: null } }).publish,
    "failed",
  );
  assert.equal(decideExit({ ...base, exit: "unknown" }).publish, "failed");
});
