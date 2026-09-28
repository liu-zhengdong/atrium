import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { publishTask } from "../server/tasks/notice.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import type { WakeExit } from "../server/leaders/wake.ts";
import { until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";
import { patrolOverdue } from "../server/tasks/overdue-runtime.ts";

/**
 * leader 层的集成：内存服务 + 假 leader 进程（直接用服务签发的令牌调接口）。
 * 走通：节点设 leader → 任务事件只投 leader → 唤醒 → 越权被拒 → 上交「已上线」→ 秘书只收到一条；
 * 连续失败转交秘书；破坏输入逐条报错。
 */

type Behave = (spec: LeaderRunSpec) => Promise<WakeExit>;

async function open(
  t: { after: (fn: () => unknown) => void },
  extra: { now?: () => number } = {},
) {
  const data = mkdtempSync(join(tmpdir(), "atrium-leaders-"));
  t.after(() => removeTemp(data));
  const runs: LeaderRunSpec[] = [];
  let behave: Behave = async () => "ok";
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      maxFailures: 2,
      ...extra,
      run: async (spec) => {
        runs.push(spec);
        return behave(spec);
      },
    },
  });
  t.after(() => created.app.close());
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
    authorization = user,
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", authorization },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (response.json() as Record<string, any>) : {},
    };
  };
  const ok = async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    assert(
      result.status < 300,
      `${args[0]} ${args[1]} → ${result.status} ${JSON.stringify(result.body)}`,
    );
    return result.body;
  };
  // 组织 o1 → Atrium o2（a1）→ 组织和规矩 o3；OpenQuota o4（没有 leader）。
  await ok("POST", "/api/org/nodes", {
    slug: "org",
    kind: "org",
    name: "组织",
    reason: "建",
  });
  await ok("POST", "/api/org/nodes", {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    reason: "建",
  });
  await ok("POST", "/api/org/nodes", {
    parent: "o2",
    slug: "rules",
    kind: "module",
    name: "组织和规矩",
    reason: "建",
  });
  await ok("POST", "/api/org/nodes", {
    parent: "o1",
    slug: "openquota",
    kind: "project",
    name: "OpenQuota",
    reason: "建",
  });
  return {
    ...created,
    runs,
    call,
    ok,
    set: (next: Behave) => {
      behave = next;
    },
  };
}

const wakeStatus = (db: DatabaseSync) =>
  (
    db.prepare("SELECT wake_status FROM org_leaders WHERE id=1").get() as
      { wake_status: string | null } | undefined
  )?.wake_status;

const idsIn = (prompt: string) =>
  (/atrium events ack ([\d ]+)/.exec(prompt)?.[1] ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);

test("leader 命令行写备注和捎话均记 aN，服务拒绝伪造作者", async (t) => {
  const x = await open(t);
  const url = await x.app.listen({ host: "127.0.0.1", port: 0 });
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "待处理",
    part: "o3",
    deliver: "none",
  });
  let completed = false;
  let failure: unknown;
  x.set(async (spec) => {
    try {
      const env = { ...spec.env, ATRIUM_LEADER_URL: url };
      const bin = join(import.meta.dirname, "..", "bin", "atrium.mjs");
      const run = promisify(execFile);
      await run(
        process.execPath,
        [bin, "task", "note", "t1", "leader 备注", "--as", "a1"],
        { env },
      );
      await run(process.execPath, [bin, "task", "tell", "t1", "leader 捎话"], {
        env,
      });
      const forged = await x.call(
        "POST",
        "/api/tasks/t1/note",
        { text: "伪造", by: "u1" },
        `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`,
      );
      assert.equal(forged.status, 403);
      const forgedTell = await x.call(
        "POST",
        "/api/tasks/t1/tell",
        { text: "伪造", by: "u1" },
        `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`,
      );
      assert.equal(forgedTell.status, 403);
    } catch (error) {
      failure = error;
    } finally {
      completed = true;
    }
    return "ok";
  });
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "待处理" });
  await until(() => completed, 20000);
  if (failure) throw failure;
  const shown = await x.ok("GET", "/api/tasks/t1");
  assert.equal(shown.note_by, "a1");
  assert.equal(shown.note, "leader 备注");
  const tell = shown.events.find(
    (event: { kind: string }) => event.kind === "tell",
  );
  assert.equal(JSON.parse(tell.detail).by, "a1");
});

test("leader：事件只投所属部门的 leader，唤醒后越权被拒、上交「已上线」，秘书只收到一条", async (t) => {
  const x = await open(t);
  // 破坏输入：指派没登记的 aN、登记时执行者不合法。
  const unregistered = await x.call("PATCH", "/api/org/nodes/o2", {
    leader: "a1",
    reason: "指派",
  });
  assert.equal(unregistered.status, 404);
  assert.match(unregistered.body.error, /a1 没有登记为 leader/);
  assert.match(unregistered.body.nextCommand, /atrium leader add .* --id a1/);
  const badWorker = await x.call("POST", "/api/leaders", {
    name: "甲",
    worker: "notatool",
  });
  assert.equal(badWorker.status, 400);
  assert.match(badWorker.body.error, /worker: 未知的执行者工具/);
  const leader = await x.ok("POST", "/api/leaders", {
    name: "Atrium 负责人",
    worker: "claude+opus:high",
  });
  assert.equal(leader.ref, "a1");
  assert.equal((await x.call("GET", "/api/leaders/a9")).status, 404);
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });

  // 秘书建任务：t1 归属 o3（a1 负责）、t2 归属 o4（没 leader）、t3 归属 o3 但指定秘书盯。
  await x.ok("POST", "/api/tasks", {
    title: "改规矩",
    part: "o3",
    deliver: "none",
  });
  await x.ok("POST", "/api/tasks", {
    title: "改额度",
    part: "o4",
    deliver: "none",
  });
  await x.ok("POST", "/api/tasks", {
    title: "秘书自己盯",
    part: "o3",
    owner: "secretary",
    deliver: "none",
  });
  const inbox = x.taskRunner.inbox;

  let stolen = "";
  const secretaryBefore = inbox.list("secretary", { limit: 50 }).events.length;
  x.set(async (spec) => {
    const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
    stolen = token;
    assert.equal(spec.env.ATRIUM_LEADER, "a1");
    assert.equal(spec.env.ATRIUM_WORKER, undefined);
    assert.equal(spec.worker, "claude+opus:high");
    assert.match(spec.prompt, /#\d+ t1 failed 改规矩 · 测试没过/);
    assert.match(spec.prompt, /Atrium/);
    const as = (
      method: Parameters<typeof x.call>[0],
      url: string,
      body?: unknown,
    ) => x.call(method, url, body, token);
    // 可以：看、在自己负责的部门建任务（不写归属默认记到负责的节点）、备注、改阶段、给子节点指派 leader、写备忘。
    assert.equal((await as("GET", "/api/tasks/t1")).status, 200);
    const own = await as("POST", "/api/tasks", {
      title: "a1 拆的活",
      deliver: "none",
    });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal(own.body.part_ref, "o2");
    assert.equal(
      (await as("POST", "/api/tasks/t1/note", { text: "a1 看过" })).status,
      200,
    );
    const stages = await as("PATCH", "/api/map/nodes/o2", {
      stages: [{ id: "s1", result: "leader 层可用", status: "active" }],
    });
    assert.equal(stages.status, 200, JSON.stringify(stages.body));
    assert.equal(
      (
        await as("PATCH", "/api/org/nodes/o3", {
          leader: "none",
          reason: "空着",
          archive: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await as("PATCH", "/api/leaders/a1", {
          memo: "t1 失败过一次，看重派结果",
        })
      ).status,
      200,
    );
    // 不可以：逐条拒绝并提示上交。
    const denied: [Parameters<typeof x.call>[0], string, unknown, RegExp][] = [
      [
        "POST",
        "/api/tasks",
        { title: "越界", part: "o4" },
        /动归属部门 o4：不在你负责的部门里/,
      ],
      [
        "POST",
        "/api/tasks",
        { title: "越界", part: "o3", owner: "secretary" },
        /负责人设为 secretary/,
      ],
      ["POST", "/api/tasks/t2/stop", undefined, /动任务 t2/],
      ["PATCH", "/api/tasks/t1", { part: "o4" }, /归属部门 o4/],
      [
        "PUT",
        "/api/org/limits",
        { quota_reserve_percent: 5 },
        /改给用户留的额度与花费上限/,
      ],
      ["PATCH", "/api/map/nodes/o1", { stages: [] }, /节点 o1/],
      ["POST", "/api/decisions", { text: "x", why: "y" }, /记决定/],
      [
        "PATCH",
        "/api/org/nodes/o2",
        { leader: "none", reason: "卸任" },
        /自己负责的节点/,
      ],
      ["PATCH", "/api/org/nodes/o3", { name: "改名", reason: "改" }, /name/],
      [
        "POST",
        "/api/org/nodes",
        { parent: "o2", slug: "x", kind: "module", name: "x", reason: "建" },
        /新建组织节点/,
      ],
      ["PATCH", "/api/leaders/a1", { worker: "codex" }, /只能改备忘/],
      [
        "POST",
        "/api/leaders",
        { name: "乙", worker: "codex" },
        /登记新的 leader/,
      ],
      ["POST", "/api/quota/claude/clear", undefined, /额度/],
      ["GET", "/api/events?as=secretary", undefined, /以 secretary 的名义/],
    ];
    for (const [method, url, body, message] of denied) {
      const result = await as(method, url, body);
      assert.equal(
        result.status,
        403,
        `${method} ${url} ${JSON.stringify(result.body)}`,
      );
      assert.equal(result.body.code, "leader_scope");
      assert.match(result.body.error, message);
      assert.match(result.body.error, /上交秘书：atrium leader escalate/);
    }
    const memo = await as("PATCH", "/api/leaders/a1", {
      memo: "字".repeat(2001),
    });
    assert.equal(memo.status, 400);
    assert.match(memo.body.error, /超过上限 2000 字；请精简/);
    const kind = await as("POST", "/api/leaders/a1/escalate", {
      kind: "done",
      note: "x",
    });
    assert.equal(kind.status, 400);
    assert.match(kind.body.error, /上交类型只能是/);
    assert.equal(
      (
        await as("POST", "/api/leaders/a2/escalate", {
          kind: "stuck",
          note: "x",
        })
      ).status,
      403,
    );
    // 上交「已上线」。
    const up = await as("POST", "/api/leaders/a1/escalate", {
      kind: "shipped",
      note: "leader 层已上线；端到端：atrium org tree 看到 leader",
      task: "t1",
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.to, "secretary");
    // 确认别人的事件被拒，确认自己的放行。
    const theirs = inbox.list("secretary", { limit: 1 }).events[0]!.id;
    assert.equal(
      (await as("POST", "/api/events/ack", { ids: [theirs] })).status,
      403,
    );
    const acked = await as("POST", "/api/events/ack", {
      ids: idsIn(spec.prompt),
    });
    assert.equal(acked.status, 200, JSON.stringify(acked.body));
    return "ok";
  });

  publishTask(inbox, x.db, 1, "failed", { reason: "测试没过" });
  publishTask(inbox, x.db, 2, "failed", { reason: "别处失败" });
  publishTask(inbox, x.db, 3, "failed", { reason: "秘书盯的" });
  // 过程事件也投 leader，但不唤醒。
  publishTask(inbox, x.db, 1, "merge_returned", { reason: "rebase 冲突" });
  const toLeader = inbox.list("a1", { limit: 10 }).events;
  assert.deepEqual(toLeader.map((e) => e.kind).sort(), [
    "failed",
    "merge_returned",
  ]);
  const routed = (
    toLeader.find((e) => e.kind === "failed")!.detail as {
      routed: { to: string; why: string };
    }
  ).routed;
  assert.equal(routed.to, "a1");
  assert.match(
    routed.why,
    /任务归属 o3「组织和规矩」，最近的 leader 是 o2「Atrium」的 a1/,
  );

  await until(() => wakeStatus(x.db) === "done", 5000);
  assert.equal(x.runs.length, 1);
  assert(
    inbox.list("a1", { limit: 10 }).events.every((e) => e.acked_at !== null),
  );
  const shown = await x.ok("GET", "/api/leaders/a1");
  assert.equal(shown.wake.status, "done");
  assert.equal(shown.wake.count, 1);
  assert.equal(shown.memo, "t1 失败过一次，看重派结果");
  // 令牌随唤醒结束作废。
  assert.equal(
    (await x.call("GET", "/api/tasks/t1", undefined, stolen)).status,
    401,
  );
  assert.equal(
    (
      await x.call(
        "GET",
        "/api/tasks/t1",
        undefined,
        `Bearer a1.${"0".repeat(64)}`,
      )
    ).status,
    401,
  );

  // 秘书：只收到 t2（没 leader）、t3（指定秘书）和一条上交；没有 t1 的过程事件。
  const secretary = inbox
    .list("secretary", { limit: 50 })
    .events.slice(0, -secretaryBefore || undefined);
  const kinds = secretary.map((e) => `${e.task} ${e.kind}`).sort();
  assert.deepEqual(kinds, ["t1 escalated", "t2 failed", "t3 failed"]);
  const escalated = secretary.find((e) => e.kind === "escalated")!;
  assert.equal(escalated.level, "action");
  assert.match(JSON.stringify(escalated.detail), /已上线/);
  // 任务上也记了一笔。
  assert(
    x.db
      .prepare("SELECT 1 FROM task_events WHERE task_id=1 AND kind='escalated'")
      .get(),
  );

  // 视图：org tree、map、top 都带 leader 与最近一次唤醒。
  const tree = (await x.ok("GET", "/api/org/tree")) as unknown as {
    ref: string;
    leader_state?: { name: string; wake: { status: string } };
  }[];
  const o2 = tree.find((n) => n.ref === "o2")!;
  assert.equal(o2.leader_state?.name, "Atrium 负责人");
  assert.equal(o2.leader_state?.wake.status, "done");
  const map = await x.ok("GET", "/api/map/nodes/o2");
  assert.equal(map.leader_state.ref, "a1");
  const top = await x.ok("GET", "/api/tasks/top");
  assert.deepEqual(
    top.leaders.map((l: { ref: string }) => l.ref),
    ["a1"],
  );
  assert.equal(top.leaders[0].wake.summary, "t1 失败");
});

test("leader：连续失败把没确认的事件转交秘书；超时直接转交", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "改规矩",
    part: "o3",
    deliver: "none",
  });
  const inbox = x.taskRunner.inbox;
  x.set(async () => "failed");
  publishTask(inbox, x.db, 1, "blocked", { reason: "缺依赖" });
  await until(
    () =>
      inbox
        .list("secretary", { limit: 5 })
        .events.some((e) => e.kind === "blocked"),
    5000,
  );
  assert.equal(x.runs.length, 2);
  const forwarded = inbox
    .list("secretary", { limit: 5 })
    .events.find((e) => e.kind === "blocked")!;
  const detail = forwarded.detail as {
    handoff: { from: string; note: string };
    routed: { why: string };
  };
  assert.equal(detail.handoff.from, "a1");
  assert.match(detail.handoff.note, /连续 2 次失败，转交/);
  assert.match(detail.routed.why, /给 秘书/);
  assert(
    inbox.list("a1", { limit: 5 }).events.every((e) => e.acked_at !== null),
  );
  await until(() => wakeStatus(x.db) === "handed_off", 5000);
  const shown = await x.ok("GET", "/api/leaders/a1");
  assert.equal(shown.wake.status, "handed_off");

  // 超时：一次就转交。
  x.set(async () => "timeout");
  publishTask(inbox, x.db, 1, "failed", { reason: "又挂了" });
  await until(
    () =>
      inbox
        .list("secretary", { limit: 10 })
        .events.some((e) => e.kind === "failed"),
    5000,
  );
  assert.equal(x.runs.length, 3);
});

test("leader：上层转交下层的上交，秘书只收一条，看得到原文与意见；原事件不再被转交", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", {
    name: "Atrium 负责人",
    worker: "codex",
  });
  await x.ok("POST", "/api/leaders", { name: "规矩负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("PATCH", "/api/org/nodes/o3", { leader: "a2", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "改规矩",
    part: "o3",
    deliver: "none",
  });
  const inbox = x.taskRunner.inbox;
  let forwarded: { status: number; body: Record<string, any> } | undefined;
  let failure: unknown;
  // a1 被唤醒后只转交、不自己确认：转交已替它确认原事件，唤醒照常收尾，不再转交第二份。
  x.set(async (spec) => {
    try {
      assert.equal(spec.leader, "a1");
      assert.match(spec.prompt, /a2 上交：已上线 · 改规矩 · t1 已上线/);
      forwarded = await x.call(
        "POST",
        "/api/leaders/a1/escalate",
        { kind: "shipped", note: "看过，阶段达成", task: "t1" },
        `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`,
      );
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  const up = await x.ok("POST", "/api/leaders/a2/escalate", {
    kind: "shipped",
    note: "t1 已上线；端到端：atrium org tree 看到规矩",
    task: "t1",
  });
  assert.equal(up.to, "a1");
  assert.equal(up.forwarded, null);
  await until(() => !!failure || wakeStatus(x.db) === "done", 5000);
  if (failure) throw failure;
  assert.equal(forwarded?.status, 200, JSON.stringify(forwarded?.body));
  assert.equal(forwarded!.body.to, "secretary");
  assert.equal(forwarded!.body.forwarded, up.event);
  assert.equal(x.runs.length, 1);

  const secretary = inbox
    .list("secretary", { limit: 10 })
    .events.filter((e) => e.kind === "escalated");
  assert.equal(secretary.length, 1);
  const only = secretary[0]!;
  assert.equal(only.id, forwarded!.body.event);
  assert.equal(only.level, "action");
  assert.equal(only.actor, "a1");
  const detail = only.detail as Record<string, any>;
  assert.equal(detail.from, "a2");
  assert.equal(detail.reason, "t1 已上线；端到端：atrium org tree 看到规矩");
  assert.deepEqual(detail.forwarded, [{ by: "a1", note: "看过，阶段达成" }]);
  assert.equal(detail.title, "a2 上交：已上线 · 改规矩（经 a1 转交）");
  assert.equal(detail.forward_of, up.event);
  // a1 手上的原事件已确认，唤醒记为处理完，而不是转交。
  const original = inbox
    .list("a1", { limit: 5 })
    .events.find((e) => e.id === up.event)!;
  assert.notEqual(original.acked_at, null);
  assert.equal((await x.ok("GET", "/api/leaders/a1")).wake.status, "done");

  // 同一件事再转交一次：合并进秘书那一条，不另起。
  const again = await x.ok("POST", "/api/leaders/a1/escalate", {
    kind: "shipped",
    note: "补一句：线上复核过",
    event: `#${up.event}`,
  });
  assert.equal(again.event, only.id);
  assert.equal(again.task, "t1");
  const merged = inbox
    .list("secretary", { limit: 10 })
    .events.filter((e) => e.kind === "escalated");
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.count, 2);

  // 破坏输入：转交不是投给自己的事件、任务对不上、编号不存在。
  await x.ok("POST", "/api/tasks", {
    title: "别的活",
    part: "o3",
    deliver: "none",
  });
  const bad: [unknown, RegExp][] = [
    [{ kind: "stuck", note: "x", event: only.id }, /不是下层投给 a1 的上交/],
    [{ kind: "stuck", note: "x", event: 99999 }, /#99999 不是下层投给 a1/],
    [
      { kind: "shipped", note: "x", event: up.event, task: "t2" },
      new RegExp(`#${up.event} 是 t1 的上交，和 t2 对不上`),
    ],
    [
      { kind: "stuck", note: "x", event: "abc" },
      /--event: 应为要转交的事件编号/,
    ],
  ];
  for (const [body, message] of bad) {
    const result = await x.call("POST", "/api/leaders/a1/escalate", body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.body.error, message, JSON.stringify(result.body));
  }
  // a2 转交 a1 自己发出的上交：不是投给 a2 的，拒绝。
  const reverse = await x.call("POST", "/api/leaders/a2/escalate", {
    kind: "shipped",
    note: "x",
    event: only.id,
  });
  assert.equal(reverse.status, 400);
  assert.match(reverse.body.error, /不是下层投给 a2 的上交/);
});

test("leader：处理期间同一任务又有新结果，确认旧内容不吞掉新结果，下次唤醒再送", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "改规矩",
    part: "o3",
    deliver: "none",
  });
  const inbox = x.taskRunner.inbox;
  const seen: string[] = [];
  x.set(async (spec) => {
    const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
    seen.push(/ t1 (failed|done)/.exec(spec.prompt)?.[1] ?? "?");
    // 第一次处理时重派，执行者很快做完：done 合并进同一条事件。
    if (seen.length === 1)
      publishTask(inbox, x.db, 1, "done", { reason: "重派后完成" });
    const acked = await x.call(
      "POST",
      "/api/events/ack",
      { ids: idsIn(spec.prompt) },
      token,
    );
    assert.equal(acked.status, 200);
    return "ok";
  });
  publishTask(inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => seen.length === 2 && wakeStatus(x.db) === "done", 5000);
  assert.deepEqual(seen, ["failed", "done"]);
  assert(
    inbox.list("a1", { limit: 5 }).events.every((e) => e.acked_at !== null),
  );
  assert.equal(inbox.list("secretary", { limit: 5 }).events.length, 0);
});

test("全景看得到负责人：节点页、负责人页、状态栏字段，leader 派的任务与备注给名字", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", {
    name: "Atrium 负责人",
    worker: "claude+sonnet",
  });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "改规矩",
    part: "o3",
    deliver: "none",
  });
  // 还没唤醒：节点页有负责人（挂在上级 o2），状态栏字段为空。
  const before = await x.ok("GET", "/api/map/nodes/o3");
  assert.equal(before.lead.ref, "a1");
  assert.equal(before.lead.name, "Atrium 负责人");
  assert.equal(before.lead.from.ref, "o2");
  assert.equal(before.lead.wake, null);
  assert.equal((await x.ok("GET", "/api/map/nodes/o2")).lead.from, null);
  assert.equal((await x.ok("GET", "/api/map/nodes/o4")).lead, null);
  assert.deepEqual((await x.ok("GET", "/api/leaders")).busy, []);

  let seen: Record<string, any> = {};
  let failure: unknown;
  x.set(async (spec) => {
    try {
      const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
      const as = (
        method: Parameters<typeof x.call>[0],
        url: string,
        body?: unknown,
      ) => x.call(method, url, body, token);
      // 处理中：节点页、状态栏字段、顶栏都说它在处理什么（人话）。
      seen = {
        node: await x.ok("GET", "/api/map/nodes/o3"),
        busy: (await x.ok("GET", "/api/leaders")).busy,
        now: await x.ok("GET", "/api/map/now"),
        page: await x.ok("GET", "/api/map/leaders/a1"),
      };
      assert.equal(
        (await as("POST", "/api/tasks", { title: "拆出来的活", part: "o3" }))
          .status,
        201,
      );
      await as("POST", "/api/tasks/t1/note", { text: "等重派结果" });
      await as("POST", "/api/tasks/t2/note", { text: "等 t1 再派" });
      await as("POST", "/api/leaders/a1/escalate", {
        kind: "cross",
        note: "要 OpenQuota 出接口",
        task: "t1",
      });
      await as("PATCH", "/api/leaders/a1", {
        memo: "在等：t1 重派\n下次先看：t2",
      });
      await as("POST", "/api/events/ack", { ids: idsIn(spec.prompt) });
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => !!failure || wakeStatus(x.db) === "done", 5000);
  if (failure) throw failure;

  assert.equal(seen.node.lead.wake.status, "running");
  assert.equal(seen.node.lead.wake.summary, "t1 失败");
  assert.deepEqual(
    seen.busy.map((b: { name: string; doing: string }) => [b.name, b.doing]),
    [["Atrium 负责人", "t1 失败"]],
  );
  assert.deepEqual(seen.now.leaders, [
    { ref: "a1", name: "Atrium 负责人", doing: "t1 失败" },
  ]);
  assert.equal(seen.page.events[0].state, "doing");
  assert.equal(seen.page.events[0].what, "失败");
  assert.equal(seen.page.events[0].why, "测试没过");

  // 处理完：负责人页记着处理过的事、上交、备忘；空闲后状态栏字段清空。
  const page = await x.ok("GET", "/api/map/leaders/a1");
  assert.equal(page.wake.status, "done");
  assert.deepEqual(
    page.nodes.map((n: { ref: string }) => n.ref),
    ["o2"],
  );
  assert.equal(page.memo, "在等：t1 重派\n下次先看：t2");
  assert.deepEqual(
    page.events.map((e: { task: { ref: string }; state: string }) => [
      e.task.ref,
      e.state,
    ]),
    [["t1", "done"]],
  );
  assert.equal(page.escalations.length, 1);
  assert.equal(page.escalations[0].label, "需要别的部门配合");
  assert.equal(page.escalations[0].to.name, "秘书");
  assert.equal(page.escalations[0].seen, false);
  assert.deepEqual((await x.ok("GET", "/api/leaders")).busy, []);
  const list = await x.ok("GET", "/api/map/leaders");
  assert.deepEqual(
    list.leaders.map((l: { ref: string; pending: number }) => [
      l.ref,
      l.pending,
    ]),
    [["a1", 0]],
  );

  // 任务行：leader 派的注明是谁，备注作者给名字；用户建的不标。
  const node = await x.ok("GET", "/api/map/nodes/o3");
  const rows = [...node.tasks.todo, ...node.tasks.recent] as {
    ref: string;
    by: { name: string } | null;
    note: { text: string; by: { ref: string; name: string } } | null;
  }[];
  const t1 = rows.find((r) => r.ref === "t1")!;
  const t2 = rows.find((r) => r.ref === "t2")!;
  assert.equal(t1.by, null);
  assert.deepEqual(t1.note?.by, { ref: "a1", name: "Atrium 负责人" });
  assert.equal(t2.by?.name, "Atrium 负责人");
  assert.equal(t2.note?.text, "等 t1 再派");
  const shown = await x.ok("GET", "/api/tasks/t2");
  assert.equal(shown.note_by, "a1");
  assert.equal(shown.note_by_name, "Atrium 负责人");
  await x.ok("POST", "/api/tasks/t1/note", { text: "我来看" });
  assert.equal((await x.ok("GET", "/api/tasks/t1")).note_by_name, null);

  // 破坏输入：没登记、格式不对。
  assert.equal((await x.call("GET", "/api/map/leaders/a9")).status, 404);
  assert.equal((await x.call("GET", "/api/map/leaders/u2")).status, 400);
  // u1 是用户页（只有决定记录，t211）。
  assert.equal((await x.ok("GET", "/api/map/leaders/u1")).kind, "user");
});

test("leader：受阻任务挂在 leader 手里没动，到点再叫醒一次，再不动运行时上交秘书；上游失败的事件列出下游与可选动作（t253）", async (t) => {
  // 时钟跟着真实时间走（攒批按事件入箱时刻判），再往前拨出挂着的时长。
  let skew = 0;
  const x = await open(t, { now: () => Date.now() + skew });
  // 到期巡检（overdue-runtime.ts）在服务里一分钟一轮；这里按拨过的钟直接跑一轮。
  const patrol = () =>
    patrolOverdue(x.db, x.taskRunner.inbox, Date.now() + skew);
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "上游",
    part: "o3",
    deliver: "none",
  });
  await x.ok("POST", "/api/tasks", {
    title: "下游",
    part: "o3",
    deliver: "none",
    after: "t1",
  });
  const inbox = x.taskRunner.inbox;
  const prompts: string[] = [];
  // a1 每次只写一句备注就确认退出：不重派、不改状态、不上交。
  x.set(async (spec) => {
    prompts.push(spec.prompt);
    const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
    await x.call("POST", "/api/tasks/t2/note", { text: "是残留" }, token);
    const acked = await x.call(
      "POST",
      "/api/events/ack",
      { ids: idsIn(spec.prompt) },
      token,
    );
    assert.equal(acked.status, 200);
    return "ok";
  });

  // 上游失败：给 a1 的事件写清下游与三种动作。
  publishTask(inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => prompts.length === 1 && wakeStatus(x.db) === "done", 5000);
  assert.match(prompts[0]!, /上游 t1 没成，下游 t2 在等它/);
  assert.match(prompts[0]!, /atrium task run t1/);
  assert.match(prompts[0]!, /atrium task set t2 --after/);
  assert.match(prompts[0]!, /atrium task set t2 --status cancelled/);
  // 提示词：以动作收尾，备注不算。
  assert.match(prompts[0]!, /每件事以一个动作收尾/);
  assert.match(prompts[0]!, /只写备注、只看不动不算处理完/);
  assert.match(prompts[0]!, /30 分钟没有上面这些动作/);

  // 下游被上游卡住，投给 a1；a1 只写备注。
  x.db
    .prepare(
      "UPDATE tasks SET status='blocked',schedule_state='blocked',schedule_reason='上游 t1 [failed]' WHERE id=2",
    )
    .run();
  x.db
    .prepare(
      "INSERT INTO task_events(task_id,at,kind,detail) VALUES (2,?,'block',?)",
    )
    .run(Date.now(), JSON.stringify({ reason: "上游 t1 [failed]" }));
  publishTask(inbox, x.db, 2, "blocked", { reason: "上游 t1 [failed]" });
  await until(() => prompts.length === 2 && wakeStatus(x.db) === "done", 5000);
  const holder = async () => (await x.ok("GET", "/api/tasks/t2")).holder;
  assert.equal((await holder()).kind, "leader");
  assert.match((await holder()).text, /a1 在处理$/);

  // 挂了 31 分钟：再叫醒 a1 一次，事件写挂了多久与下一步。
  skew += 31 * 60_000;
  assert.deepEqual(patrol().woke, ["t2"]);
  await until(() => prompts.length === 3 && wakeStatus(x.db) === "done", 5000);
  assert.match(prompts[2]!, /t2 到期没动/);
  assert.match(prompts[2]!, /已 31 分钟没动/);
  assert.match(prompts[2]!, /atrium task run t2/);
  assert(
    !inbox
      .list("secretary", { limit: 10 })
      .events.some((e) => e.kind === "overdue"),
  );

  // 叫醒后又只写了备注，再过 30 分钟：运行时上交秘书，持球人变成秘书。
  skew += 30 * 60_000;
  assert.deepEqual(patrol().escalated, ["t2"]);
  const up = inbox
    .list("secretary", { limit: 10 })
    .events.find((e) => e.kind === "overdue")!;
  const detail = up.detail as { step: string; reason: string; who: string };
  assert.equal(up.task, "t2");
  assert.equal(detail.step, "escalate");
  assert.equal(detail.who, "a1");
  assert.match(detail.reason, /leader a1 已 1 小时没动.*上交 secretary/);
  const after = await holder();
  assert.equal(after.kind, "secretary");
  assert.match(after.text, /运行时 上交给秘书$/);
  // 上交之后不再叫醒 a1、不再重复上交。
  skew += 120 * 60_000;
  assert.deepEqual(patrol(), { woke: [], escalated: [] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(prompts.length, 3);
});
