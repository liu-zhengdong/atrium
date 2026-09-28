import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { ensureQueueTable, enqueue } from "../server/tasks/queue.ts";
import { OnlineWatch } from "../server/tasks/online-runtime.ts";
import type { Exec } from "../server/tasks/git.ts";
import {
  DEFAULT_VERIFY_WORKERS,
  scrub,
  verdictLine,
  verifyBrief,
  verifyReport,
  verifyWorkers,
  VERIFY_RULES,
} from "../server/tasks/verify.ts";
import {
  isVerifyTask,
  openVerify,
  settleVerifications,
  STRANDED_MS,
  unsentVerify,
  verifyFileOf,
} from "../server/tasks/verify-runtime.ts";
import { verifierCommandGuard } from "../cli/worker-guard.ts";
import { verifiedLines } from "../cli/tasks.ts";
import { eventLine } from "../cli/events.ts";
import { removeTemp } from "./temp-dir.ts";

test("验证执行者配置：缺省、自定义、去重、写错的挑出来", () => {
  assert.deepEqual(verifyWorkers(undefined), {
    workers: [...DEFAULT_VERIFY_WORKERS],
    invalid: [],
  });
  assert.deepEqual(verifyWorkers("  "), {
    workers: [...DEFAULT_VERIFY_WORKERS],
    invalid: [],
  });
  assert.deepEqual(
    verifyWorkers(
      "cursor+auto, opencode+opencode-go/deepseek-v4.1-flash,,cursor+auto",
    ),
    {
      workers: ["cursor+auto", "opencode+opencode-go/deepseek-v4.1-flash"],
      invalid: [],
    },
  );
  assert.deepEqual(verifyWorkers("nope+x,cursor"), {
    workers: ["cursor"],
    invalid: ["nope+x"],
  });
  for (const worker of DEFAULT_VERIFY_WORKERS)
    assert.deepEqual(verifyWorkers(worker).invalid, []);
});

test("写进事件前抹掉疑似凭据并截断", () => {
  const secrets = [
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "sk-abcdefghijklmnop1234",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "Bearer abcdefghijklmnop.qrs",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----",
    "https://user:hunter2secret@example.com/x",
    "password=hunter22",
    '"api_key": "abcdef123456"',
    "Cookie: sessionid123456",
    "Xy9kQ2mN8pR4sT6vW1zA3bC5dE7fG9hJ0kL",
  ];
  for (const secret of secrets) {
    const out = scrub(`输出 ${secret} 结束`, 500);
    assert.match(out, /\*\*\*/, secret);
    for (const piece of [
      "abcdefghijklmnopqrstuvwxyz0123",
      "abcdefghijklmnop1234",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "abcdefghijklmnop.qrs",
      "AAAAB3Nza",
      "hunter2secret",
      "hunter22",
      "abcdef123456",
      "sessionid123456",
      "Xy9kQ2mN8pR4sT6vW1zA3bC5dE7fG9hJ0kL",
    ])
      assert.ok(!out.includes(piece), `${secret} → ${out}`);
  }
  // 提交号、版本号、普通路径不当凭据。
  const plain =
    "提交 0123456789abcdef0123456789abcdef01234567 v0.1.124 /usr/local/bin/atrium t12 [已上线]";
  assert.equal(scrub(plain, 500), plain);
  assert.equal(scrub("x".repeat(20), 10), `${"x".repeat(9)}…`);
  assert.equal(scrub("  a\r\nb  ", 10), "a\nb");
});

test("汇报里最后一个验证结论", () => {
  assert.equal(verdictLine(null), null);
  assert.equal(verdictLine("跑完了"), null);
  assert.equal(verdictLine("验证结论：通过"), "passed");
  assert.equal(verdictLine("验证结论: 没通过"), "failed");
  assert.equal(verdictLine("验证结论：不通过"), "failed");
  assert.equal(verdictLine("验证结论：无法验证"), "unverifiable");
  assert.equal(
    verdictLine("验证结论：通过（草稿）\n……\n验证结论：没通过"),
    "failed",
  );
});

const step = (matched: unknown, extra: Record<string, unknown> = {}) => ({
  command: "atrium task show t1",
  expected: "[已上线]",
  output: "t1 [已上线]",
  matched,
  ...extra,
});
const report = (body: unknown, result: string | null = null, status = "done") =>
  verifyReport({ status, raw: JSON.stringify(body), result });

test("验证结果合成：步骤决定结论，执行者自报只会更严", () => {
  assert.equal(
    report({ verdict: "passed", summary: "都对", steps: [step(true)] }).verdict,
    "passed",
  );
  // 自报通过但有一步不符合：没通过。
  assert.equal(
    report({ verdict: "passed", steps: [step(true), step(false)] }).verdict,
    "failed",
  );
  // 有一步没法验证：无法验证。
  assert.equal(
    report({ verdict: "passed", steps: [step(true), step(null)] }).verdict,
    "unverifiable",
  );
  assert.equal(report({ steps: [step("yes")] }).verdict, "unverifiable");
  // 一步都没有：无法验证。
  const empty = report({ verdict: "passed", steps: [] });
  assert.equal(empty.verdict, "unverifiable");
  assert.match(empty.summary, /没有步骤/);
  // 自报没通过或无法验证照收。
  assert.equal(
    report({ verdict: "failed", steps: [step(true)] }).verdict,
    "failed",
  );
  assert.equal(
    report({ verdict: "unverifiable", steps: [step(true)] }).verdict,
    "unverifiable",
  );
  assert.equal(
    report({ verdict: "passed", steps: [step(true)] }, "验证结论：没通过")
      .verdict,
    "failed",
  );
  // 超出上限没记下的步骤里有不符合的，照样没通过。
  const many = report({
    verdict: "passed",
    steps: [...Array.from({ length: 20 }, () => step(true)), step(false)],
  });
  assert.equal(many.verdict, "failed");
  assert.equal(many.steps.length, 15);
  assert.match(many.summary, /另有 6 步没记下/);
  // 坏字段按空处理；输出截断并抹掉凭据。
  const scrubbed = report({
    verdict: "failed",
    summary: "token=abcdefghijk 泄露",
    steps: [
      "坏",
      step(false, {
        output: `ghp_abcdefghijklmnopqrstuvwxyz0123 ${"长".repeat(900)}`,
      }),
    ],
  });
  assert.equal(scrubbed.steps[0]!.command, "");
  assert.equal(scrubbed.steps[0]!.matched, null);
  assert.ok(scrubbed.steps[1]!.output.startsWith("*** 长"));
  assert.equal(Array.from(scrubbed.steps[1]!.output).length, 500);
  assert.ok(!scrubbed.summary.includes("abcdefghijk"));
});

test("没写结果文件或写坏：只认汇报里的没通过，其余无法验证", () => {
  const none = (status: string, result: string | null) =>
    verifyReport({ status, raw: null, result });
  assert.deepEqual(none("done", "验证结论：没通过"), {
    verdict: "failed",
    summary: "验证执行者没有写 verify.json；汇报说没通过：验证结论：没通过",
    steps: [],
  });
  const claimed = none("done", "验证结论：通过");
  assert.equal(claimed.verdict, "unverifiable");
  assert.match(claimed.summary, /没有写 verify\.json/);
  const failed = none("failed", null);
  assert.equal(failed.verdict, "unverifiable");
  assert.equal(failed.summary, "验证任务失败，没交结果");
  assert.equal(none("cancelled", null).summary, "验证任务已取消，没交结果");
  const big = verifyReport({
    status: "done",
    raw: { error: "verify.json 超过 64 KB" },
    result: null,
  });
  assert.equal(big.verdict, "unverifiable");
  assert.match(big.summary, /超过 64 KB/);
  const bad = verifyReport({ status: "done", raw: "{坏", result: null });
  assert.deepEqual(bad, {
    verdict: "unverifiable",
    summary: "verify.json 不是合法的 JSON",
    steps: [],
  });
  // 带 BOM 的文件照读。
  assert.equal(
    verifyReport({
      status: "done",
      raw: `﻿${JSON.stringify({ steps: [step(true)] })}`,
      result: null,
    }).verdict,
    "passed",
  );
});

test("验证详述与硬规矩", () => {
  const brief = verifyBrief({
    ref: "t7",
    title: "上线",
    version: "0.1.9",
    pr_url: "https://github.com/acme/demo/pull/1",
    steps: "atrium task show t7\n期望：[已上线]",
  });
  assert.match(brief, /t7「上线」已上线（v0\.1\.9）/);
  assert.match(brief, /PR：https:\/\/github\.com\/acme\/demo\/pull\/1/);
  assert.match(brief, /atrium task show t7\n期望：\[已上线\]/);
  assert.match(brief, /verify\.json/);
  const rules = VERIFY_RULES.join("\n");
  for (const must of [
    /凭据不进输出/,
    /钥匙串/,
    /不做真实登录/,
    /不启真实额度读取/,
    /无法验证：需要真实凭据/,
    /不改仓库公开范围/,
    /不花钱/,
    /不动用户个人资料/,
    /不启动、停止、重启、升级 Atrium 服务/,
  ])
    assert.match(rules, must);
});

test("验证执行者的命令行防护：只拦启停、升级、令牌、秘书会话与代理", () => {
  const env = { ATRIUM_VERIFIER: "1" };
  for (const name of [
    undefined,
    "--no-open",
    "stop",
    "restart",
    "update",
    "auth",
    "chat",
    "agent",
  ])
    assert.throws(
      () => verifierCommandGuard(name, env),
      (error: Error & { code?: string }) =>
        error.code === "verifier_scope" && /无法验证/.test(error.message),
    );
  for (const name of ["task", "top", "status", "events", "map", "quota"])
    verifierCommandGuard(name, env);
  verifierCommandGuard("restart", {});
  verifierCommandGuard("restart", { ATRIUM_VERIFIER: "0" });
});

function memory() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureQueueTable(db);
  return db;
}

/** 账本里造一条已上线的任务。 */
function shipped(db: DatabaseSync, stage = "online") {
  const now = Date.now();
  return Number(
    db
      .prepare(
        "INSERT INTO tasks(title,repo,deliver,status,pr_url,delivery_stage,online_wait,created_at,updated_at) VALUES ('上线的活','/repo','pr','done','https://github.com/acme/demo/pull/1',?,?,?,?)",
      )
      .run(stage, stage === "merged" ? 1 : 0, now, now).lastInsertRowid,
  );
}

const events = (db: DatabaseSync, id: number) =>
  (
    db
      .prepare(
        "SELECT kind,detail FROM task_events WHERE task_id=? ORDER BY id",
      )
      .all(id) as { kind: string; detail: string | null }[]
  ).map((row) => ({
    kind: row.kind,
    detail: row.detail
      ? (JSON.parse(row.detail) as Record<string, unknown>)
      : null,
  }));

test("开验证：有步骤建子任务并记账，没有步骤只记「无验证步骤」", () => {
  const db = memory();
  const id = shipped(db);
  const ref = openVerify(db, {
    taskId: id,
    version: "0.1.9",
    steps: "atrium task show t1\n期望：[已上线]",
  })!;
  assert.match(ref, /^t\d+$/);
  const verifyId = Number(ref.slice(1));
  assert.ok(isVerifyTask(db, verifyId));
  assert.ok(!isVerifyTask(db, id));
  const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(verifyId) as {
    parent_id: number;
    deliver: string;
    status: string;
    repo: string | null;
    brief: string;
    title: string;
  };
  assert.equal(row.parent_id, id);
  assert.equal(row.deliver, "none");
  assert.equal(row.status, "todo");
  assert.equal(row.repo, null);
  assert.match(row.title, /^上线验证：t1 上线的活$/);
  assert.match(row.brief, /atrium task show t1\n期望：\[已上线\]/);
  assert.deepEqual(events(db, id).at(-1), {
    kind: "verify_started",
    detail: { verifier: ref },
  });

  const bare = shipped(db);
  assert.equal(
    openVerify(db, { taskId: bare, version: "0.1.9", steps: null }),
    null,
  );
  assert.deepEqual(
    events(db, bare).map((e) => e.kind),
    ["verify_none"],
  );
  assert.equal(
    (
      db
        .prepare("SELECT count(*) n FROM tasks WHERE parent_id=?")
        .get(bare) as { n: number }
    ).n,
    0,
  );
});

test("验证任务结束：读 verify.json 把结论记进原任务，只记一次；排队中与在跑的先不判", (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-verify-"));
  t.after(() => removeTemp(data));
  const db = memory();
  const id = shipped(db);
  const ref = openVerify(db, { taskId: id, version: "0.1.9", steps: "跑 a" })!;
  const verifyId = Number(ref.slice(1));
  const file = verifyFileOf(data, verifyId);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      verdict: "passed",
      summary: "照着跑了",
      steps: [
        step(false, {
          output: "t1 [已合入] GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
        }),
      ],
    }),
  );
  // 还在待办、刚建：不判也不重派。
  assert.deepEqual(settleVerifications(db, data), {
    outcomes: [],
    stranded: [],
  });
  db.prepare(
    "UPDATE tasks SET status='done',result='验证结论：通过' WHERE id=?",
  ).run(verifyId);
  // 在跑（内存里）的先不判。
  assert.deepEqual(
    settleVerifications(db, data, (task) => task === verifyId).outcomes,
    [],
  );
  // 排队中的不判。
  enqueue(db, {
    task_id: verifyId,
    tool: "cursor",
    worker: "cursor",
    risk: "low",
    queued_at: 1,
  });
  assert.deepEqual(settleVerifications(db, data).outcomes, []);
  db.prepare("DELETE FROM task_queue").run();
  const { outcomes } = settleVerifications(db, data);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.task, id);
  assert.equal(outcomes[0]!.verdict, "failed");
  const recorded = events(db, id).at(-1)!;
  assert.equal(recorded.kind, "verified");
  assert.equal(recorded.detail!.verifier, ref);
  assert.equal(recorded.detail!.verdict, "failed");
  assert.equal(recorded.detail!.conclusion, "没通过");
  const steps = recorded.detail!.steps as {
    output: string;
    matched: boolean;
  }[];
  assert.equal(steps[0]!.matched, false);
  assert.ok(!JSON.stringify(recorded.detail).includes("ghp_"));
  assert.match(steps[0]!.output, /GH_TOKEN=\*\*\*/);
  // 只记一次。
  assert.deepEqual(settleVerifications(db, data).outcomes, []);
  assert.equal(events(db, id).filter((e) => e.kind === "verified").length, 1);
  // task show 的人话。
  const lines = verifiedLines(JSON.stringify(recorded.detail)).split("\n");
  assert.equal(lines[0], `${ref} 没通过：照着跑了`);
  assert.match(
    lines[1]!,
    /^ {6}\[不符合\] atrium task show t1 → t1 \[已合入\] GH_TOKEN=\*\*\*$/,
  );
});

test("停在待办太久的验证任务重派；拉不起来标受阻并记无法验证", () => {
  const db = memory();
  const id = shipped(db);
  const ref = openVerify(db, { taskId: id, version: "0.1.9", steps: "跑 a" })!;
  const later = Date.now() + STRANDED_MS + 1;
  assert.deepEqual(
    settleVerifications(db, "/nowhere", undefined, { now: later }),
    {
      outcomes: [],
      stranded: [ref],
    },
  );
  const outcome = unsentVerify(db, ref, "cursor+auto：执行者 cursor 没装");
  assert.equal(outcome!.verdict, "unverifiable");
  assert.equal(
    (
      db
        .prepare("SELECT status FROM tasks WHERE id=?")
        .get(Number(ref.slice(1))) as { status: string }
    ).status,
    "blocked",
  );
  const last = events(db, id).at(-1)!;
  assert.equal(last.kind, "verified");
  assert.equal(last.detail!.conclusion, "无法验证");
  assert.match(
    String(last.detail!.summary),
    /没有可用的验证执行者：cursor\+auto：执行者 cursor 没装/,
  );
  // 已记过结论的不再重派，也不再记。
  assert.deepEqual(
    settleVerifications(db, "/nowhere", undefined, { now: later }),
    {
      outcomes: [],
      stranded: [],
    },
  );
  assert.equal(unsentVerify(db, ref, "再来"), null);
  // 不是验证任务的不管。
  assert.equal(unsentVerify(db, `t${id}`, "x"), null);
});

test("建不起验证任务只记一笔，不连累「已上线」回滚", () => {
  const db = memory();
  const id = shipped(db);
  db.exec(
    "CREATE TRIGGER no_child BEFORE INSERT ON tasks WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT, '造的错'); END",
  );
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE tasks SET result='改动' WHERE id=?").run(id);
  assert.equal(
    openVerify(db, { taskId: id, version: "0.1.9", steps: "跑 a" }),
    null,
  );
  db.exec("COMMIT");
  assert.equal(
    (
      db.prepare("SELECT result FROM tasks WHERE id=?").get(id) as {
        result: string;
      }
    ).result,
    "改动",
  );
  const last = events(db, id).at(-1)!;
  assert.equal(last.kind, "verify_skipped");
  assert.match(String(last.detail!.reason), /建验证任务失败：造的错/);
  assert.equal(
    (
      db.prepare("SELECT count(*) n FROM task_verifications").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test("上线时建验证任务、通知附验证任务短号并在提交后派发；没有验证一节不派人", async () => {
  const db = memory();
  const withSteps = shipped(db, "merged");
  const without = shipped(db, "merged");
  for (const id of [withSteps, without])
    db.prepare("UPDATE tasks SET release_version='0.1.0' WHERE id=?").run(id);
  const bodies: Record<string, string> = {
    [`t${withSteps}`]: "## 端到端验证\natrium task show t1\n期望：[已上线]",
    [`t${without}`]: "## 实现\n改了",
  };
  db.prepare("UPDATE tasks SET pr_url=? WHERE id=?").run(
    `https://github.com/acme/demo/pull/${without}`,
    without,
  );
  const run: Exec = async (command, args) => {
    if (command === "git" && args.includes("get-url"))
      return {
        ok: true,
        stdout: "https://github.com/acme/demo.git\n",
        stderr: "",
      };
    if (command === "gh" && args.includes("body")) {
      const url = args[args.indexOf("view") + 1]!;
      const task = url.endsWith(`/${without}`)
        ? `t${without}`
        : `t${withSteps}`;
      return {
        ok: true,
        stdout: JSON.stringify({ body: bodies[task] }),
        stderr: "",
      };
    }
    return { ok: false, stdout: "", stderr: `unexpected ${command}` };
  };
  const published: {
    id: number;
    kind: string;
    detail: Record<string, unknown>;
  }[] = [];
  const dispatched: string[][] = [];
  let inTransaction: boolean | null = null;
  const watch = new OnlineWatch(db, {
    run,
    version: () => "0.1.0",
    selfUpdate: true,
    selfRepo: "acme/demo",
    busy: () => false,
    deploy: async () => ({ ok: true }),
    publish: (id, kind, detail) => published.push({ id, kind, detail }),
    changed: () => {},
    verify: {
      open: (id, steps, version) =>
        openVerify(db, { taskId: id, version, steps }),
      dispatch: (refs) => {
        inTransaction = db.isTransaction;
        dispatched.push(refs);
      },
    },
  });
  await watch.tick();
  assert.equal(inTransaction, false, "提交后才派发");
  const verifier = (
    db
      .prepare("SELECT verify_id FROM task_verifications WHERE task_id=?")
      .get(withSteps) as {
      verify_id: number;
    }
  ).verify_id;
  assert.deepEqual(dispatched, [[`t${verifier}`]]);
  const online = published.filter((p) => p.kind === "online");
  assert.equal(online.length, 2);
  const first = online.find((p) => p.id === withSteps)!;
  assert.equal(first.detail.verifier, `t${verifier}`);
  assert.equal(
    first.detail.verification,
    "atrium task show t1\n期望：[已上线]",
  );
  assert.equal("steps" in first.detail, false);
  const second = online.find((p) => p.id === without)!;
  assert.equal(second.detail.verifier, undefined);
  assert.deepEqual(
    events(db, without).map((e) => e.kind),
    ["online", "verify_none"],
  );
  assert.deepEqual(
    events(db, withSteps).map((e) => [
      e.kind,
      e.detail?.verification ?? e.detail?.verifier,
    ]),
    [
      ["online", true],
      ["verify_started", `t${verifier}`],
    ],
  );
  // 验证任务是帮手子任务：原任务不变成总任务，状态不按子孙汇总（t190）。
  assert.equal(
    (
      db.prepare("SELECT status FROM tasks WHERE id=?").get(withSteps) as {
        status: string;
      }
    ).status,
    "done",
  );
  assert.equal(
    (
      db.prepare("SELECT helper FROM tasks WHERE id=?").get(verifier) as {
        helper: number;
      }
    ).helper,
    1,
  );
  // 已上线通知里注明验证任务。
  const line = eventLine({
    id: 1,
    task: `t${withSteps}`,
    kind: "online",
    count: 1,
    delivered_at: null,
    acked_at: null,
    updated_at: Date.now(),
    detail: first.detail,
  } as never);
  assert.match(
    line,
    new RegExp(`\\n {2}验证任务：t${verifier}（运行时已派人照着跑`),
  );
});
