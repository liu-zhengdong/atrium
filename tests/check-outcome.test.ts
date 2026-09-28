import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkSummary,
  classifyCheck,
  isTimingSensitive,
  MAX_CHECK_RERUNS,
  missingCommand,
  notRunText,
  parseTimingSensitive,
  rerunDecision,
  rerunDelayMs,
  testName,
  withOutcome,
  type CheckClass,
} from "../server/tasks/merge/check-outcome.ts";
import {
  runLocalCheck,
  type LocalCheck,
} from "../server/tasks/merge/local-check.ts";
import { tempDir } from "./temp-dir.ts";
import {
  holderDetail,
  holderOf,
  type HolderFacts,
} from "../server/tasks/watch/holder.ts";

const check = (over: Partial<LocalCheck>): LocalCheck => ({
  status: "failed",
  command: "npm run check",
  log: "/tmp/local-check.log",
  detail: "退出码 1",
  failedTests: [],
  ...over,
});

const PATTERNS = ["慢用例", "/service.test.ts"];

test("时长敏感用例登记：去注释与空行、去重、路径分隔统一", () => {
  assert.deepEqual(
    parseTimingSensitive(
      "# 注释\n\n  慢用例  \r\n慢用例\ntests\\service.test.ts\n",
    ),
    ["慢用例", "tests/service.test.ts"],
  );
  assert.deepEqual(parseTimingSensitive(""), []);
  assert.equal(testName("慢用例：等服务 (41599.5147ms)"), "慢用例：等服务");
  assert.equal(testName("跳过的 (1.2ms) # SKIP"), "跳过的");
  assert.equal(
    testName("C:\\repo\\tests\\service.test.ts (1.4ms)"),
    "C:/repo/tests/service.test.ts",
  );
  assert.equal(isTimingSensitive("慢用例：a (1ms)", PATTERNS), true);
  assert.equal(
    isTimingSensitive("C:\\x\\tests\\service.test.ts (1ms)", PATTERNS),
    true,
  );
  // 只是名字里带 service.test.ts 的别的文件不算。
  assert.equal(
    isTimingSensitive("tests/task-service.test.ts (1ms)", PATTERNS),
    false,
  );
  assert.equal(isTimingSensitive("关键用例", PATTERNS), false);
  assert.equal(isTimingSensitive("", PATTERNS), false);
  assert.equal(isTimingSensitive("慢用例", []), false);
});

test("检查结果分三类：状态 × 基础设施原因 × 失败用例是否全是时长敏感，穷举", () => {
  const statuses = ["passed", "failed", "timeout", "error"] as const;
  const failures = {
    none: [] as string[],
    sensitive: ["慢用例：一 (40000ms)", "x\\tests\\service.test.ts (1ms)"],
    mixed: ["慢用例：一 (40000ms)", "关键用例 (3ms)"],
    real: ["关键用例 (3ms)"],
    many: Array.from({ length: 10 }, (_, i) => `慢用例：${i}`),
  };
  const expected = (
    status: (typeof statuses)[number],
    infra: boolean,
    kind: keyof typeof failures,
  ): CheckClass => {
    if (status === "passed") return "passed";
    if (infra) return "not_run";
    const allSensitive = kind === "none" || kind === "sensitive";
    if (status === "timeout") return allSensitive ? "not_run" : "failed";
    if (status === "failed") return kind === "sensitive" ? "not_run" : "failed";
    return "failed";
  };
  for (const status of statuses)
    for (const infra of [false, true])
      for (const kind of Object.keys(failures) as (keyof typeof failures)[]) {
        const got = classifyCheck(
          check({
            status,
            failedTests: failures[kind],
            ...(infra ? { infra: "h3 离线，检查没派过去" } : {}),
          }),
          PATTERNS,
        );
        assert.equal(
          got.outcome,
          expected(status, infra, kind),
          `${status} infra=${infra} ${kind}`,
        );
        assert.ok(got.reason);
      }
  // 没登记任何时长敏感用例：只有基础设施原因和「超时且没有失败用例」算没跑成。
  assert.equal(
    classifyCheck(check({ failedTests: ["慢用例：一"] }), []).outcome,
    "failed",
  );
  assert.equal(
    classifyCheck(check({ status: "timeout", detail: "超过 15 分钟" }), [])
      .outcome,
    "not_run",
  );
  assert.match(
    classifyCheck(check({ failedTests: ["慢用例：一 (1ms)"] }), PATTERNS)
      .reason,
    /都是已知的时长敏感用例（慢用例：一）/,
  );
});

test("09-28 的真实记录：h3 离线、负载高超时算没跑成，执行者自己的问题照旧算没过", () => {
  // 仓库自己登记的时长敏感用例（运行时从 origin/<基础分支> 读同一份文件）。
  const patterns = parseTimingSensitive(
    readFileSync(
      new URL("../.agents/timing-sensitive", import.meta.url),
      "utf8",
    ),
  );
  const cases: [string, Partial<LocalCheck>, CheckClass][] = [
    [
      "t181",
      {
        status: "error",
        detail: "h3 离线超过 60 秒，检查没跑完",
        infra: "h3 离线超过 60 秒，检查没跑完",
      },
      "not_run",
    ],
    [
      "t185",
      {
        status: "error",
        detail: "h3 离线，检查没派过去",
        infra: "h3 离线，检查没派过去",
      },
      "not_run",
    ],
    [
      "t179",
      {
        failedTests: [
          "隔离服务与假 gh/执行者：return_then_merge (41599.5147ms)",
        ],
      },
      "not_run",
    ],
    [
      "t165",
      {
        status: "timeout",
        detail: "超过 15 分钟",
        failedTests: [
          "隔离运行时：份额用尽转 blocked 通知 leader；pace 不可用记事件并允许派活 (532.608916ms)",
        ],
      },
      "not_run",
    ],
    [
      "t186",
      {
        status: "timeout",
        detail: "超过 15 分钟",
        failedTests: [
          "执行者在跑时随时重启：新服务按 pid 接管，重启后立即续派；遗留的待空闲重启记录被丢弃 (109233.1565ms)",
          "停止需要服务凭据及正确来源；不按陈旧 PID 杀进程；崩溃后并发重启 (64682.148ms)",
          "占用端口和非法参数明确失败；前台入口使用相同生命周期 (31183.8259ms)",
          "C:\\Users\\CPCli\\.atrium-agent\\repos\\liu-zhengdong-atrium-check-0\\tests\\service.test.ts (1.4042ms)",
          "隔离服务与假 gh/执行者：merge_failed (45343.6541ms)",
        ],
      },
      "not_run",
    ],
    [
      "t176",
      {
        failedTests: [
          "执行者在跑时随时重启：新服务按 pid 接管，重启后立即续派；遗留的待空闲重启记录被丢弃 (55038.4187ms)",
          "两份数据抢同一端口：报出占用者的数据目录，第二份数据不建表（t71） (50264.3331ms)",
          "排空完成后再次 prepare-restart 仍返回就绪；stopping 中 CLI 给出明确下一步（#231） (29515.0345ms)",
          "排空完成后 supervisor 失联且超过上限：旧服务自动恢复；supervisor 仍在时不抢先恢复（#244） (27070.3449ms)",
          "C:\\Users\\CPCli\\.atrium-agent\\repos\\liu-zhengdong-atrium-check-0\\tests\\service.test.ts (0.9094ms)",
        ],
      },
      "not_run",
    ],
    [
      "改坏了逻辑",
      { failedTests: ["origin 远端解析：https 与 ssh (2.1ms)"] },
      "failed",
    ],
    [
      "没有检查脚本",
      {
        status: "error",
        detail: "没有 .agents/check 或 package.json 的 check 脚本",
      },
      "failed",
    ],
  ];
  for (const [name, over, outcome] of cases)
    assert.equal(classifyCheck(check(over), patterns).outcome, outcome, name);
});

test("没跑成之后：没到上限就重跑，用尽转卡住；过和没过都不重跑", () => {
  for (const outcome of ["passed", "failed", "not_run"] as const)
    for (let reruns = 0; reruns <= MAX_CHECK_RERUNS + 1; reruns++) {
      const got = rerunDecision({ outcome, reruns });
      const want =
        outcome === "not_run" && reruns < MAX_CHECK_RERUNS ? "rerun" : "final";
      assert.equal(got, want, `${outcome} ${reruns}`);
    }
  assert.equal(MAX_CHECK_RERUNS, 3);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(rerunDelayMs),
    [60_000, 60_000, 180_000, 300_000, 300_000],
  );
});

test("一句话：没跑成写明基础设施问题，task show 分清过、没过、没跑成", () => {
  const notRun = withOutcome(
    check({
      status: "error",
      detail: "h3 离线",
      infra: "h3 离线",
    }),
    [],
    3,
  );
  assert.equal(notRun.outcome, "not_run");
  assert.equal(notRun.reason, "h3 离线");
  assert.equal(notRun.reruns, 3);
  assert.equal(
    notRunText(notRun.reason!, notRun.reruns!),
    "基础设施问题：检查没跑成（已自动重跑 3 次）：h3 离线",
  );
  const failed = withOutcome(check({ failedTests: ["关键用例 (1ms)"] }), []);
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.reason, undefined);
  assert.equal(failed.reruns, undefined);

  const summary = (kind: string, detail: Record<string, unknown>) =>
    checkSummary({ kind, detail });
  assert.equal(
    summary("local_check", { outcome: "passed", status: "passed", host: "h2" }),
    "交付后过（h2）",
  );
  assert.equal(
    summary("merge_check", {
      status: "failed",
      detail: "退出码 1",
      failedTests: ["关键用例 (1ms)"],
    }),
    "合入前没过：退出码 1；失败用例：关键用例",
  );
  assert.equal(summary("merge_check", { status: "passed" }), "合入前过");
  assert.equal(
    summary("merge_check_rerun", { attempt: 2, reason: "h3 离线", host: "h3" }),
    "合入前没跑成（h3），已安排重跑（2/3）：h3 离线",
  );
  assert.equal(
    summary("merge_check", {
      outcome: "not_run",
      reason: "h3 离线",
      reruns: 3,
    }),
    "合入前没跑成（基础设施问题，已自动重跑 3 次）：h3 离线",
  );
  assert.equal(summary("local_check", {}), null);
});

test("持球人：合入前等重跑说「检查没跑成，等重跑」，原因全文给 task show", () => {
  const base: HolderFacts = {
    status: "running",
    delivery_stage: null,
    online_wait: 0,
    worker: "claude+opus:high",
    queued: null,
    review_task: null,
    schedule_state: null,
    schedule_reason: null,
    waiting_for: [],
    auto: false,
    block: null,
    returned: null,
    merge_returned: null,
    escalated: null,
    processing_by: null,
    inbox: null,
    route: "a1",
    checking: false,
    rerun: null,
  };
  assert.equal(
    holderOf({
      ...base,
      status: "done",
      delivery_stage: "merge_queued",
      rerun: { attempt: 2, reason: "超时" },
    })?.text,
    "合入前检查没跑成，等重跑（2/3）",
  );
  assert.equal(
    holderOf({ ...base, status: "done", delivery_stage: "merge_queued" })?.text,
    "排队合入",
  );
  assert.equal(
    holderDetail({
      ...base,
      status: "done",
      delivery_stage: "merge_queued",
      rerun: { attempt: 1, reason: "h3 离线" },
    }),
    "h3 离线",
  );
});

test("检查命令找不到（没装依赖）：退出码 127 或 shell 说找不到命令算没跑成；测试自己打印这句不算", () => {
  const cases: [number | null, string, string[], boolean][] = [
    [127, "sh: tsc: command not found\n", [], true],
    [127, "", [], true],
    [1, "sh: tsc: command not found\n", [], true],
    [1, "sh: 1: tsc: not found\n", [], false],
    [
      9009,
      "'tsc' is not recognized as an internal or external command,\n",
      [],
      true,
    ],
    [1, "sh: tsc: command not found\n", ["关键用例"], false],
    [1, "not ok 1 - 关键用例\n", ["关键用例"], false],
    [2, "", [], false],
  ];
  for (const [code, tail, failedTests, want] of cases)
    assert.equal(
      missingCommand({ code, tail, failedTests }) !== null,
      want,
      `${code} ${JSON.stringify(tail)}`,
    );
  assert.match(
    missingCommand({
      code: 127,
      tail: "sh: tsc: command not found",
      failedTests: [],
    })!,
    /^检查命令找不到（工作树可能没装依赖）：sh: tsc: command not found$/,
  );
  // 旧版代理回的结果没有 infra：只凭退出码 127 也算没跑成。
  assert.equal(
    classifyCheck(check({ detail: "退出码 127" }), []).outcome,
    "not_run",
  );
  assert.equal(
    classifyCheck(check({ detail: "退出码 1" }), []).outcome,
    "failed",
  );
});

test("本地检查真跑一个不存在的命令：记 infra，分类为没跑成", async (t) => {
  const worktree = tempDir(t, "atrium-missing-");
  mkdirSync(join(worktree, ".agents"));
  writeFileSync(
    join(worktree, ".agents", "check"),
    "atrium-t204-no-such-command --noEmit",
  );
  const result = await runLocalCheck({
    worktree,
    taskDir: join(worktree, "task"),
  });
  assert.equal(result.status, "failed");
  assert.match(result.infra ?? "", /^检查命令找不到/);
  assert.equal(withOutcome(result, []).outcome, "not_run");
});
