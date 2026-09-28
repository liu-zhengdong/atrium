import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { publishTask } from "../server/tasks/notice.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import type { WakeExit } from "../server/leaders/wake.ts";
import { until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * leader 分身（t275）的集成：内存服务 + 假 leader 进程（等测试放行才退出）。
 * 走通：日常事件与大事同时起两个分身 → 状态显示「2 件」→ 动别的分身认领的任务被拒 →
 * 备忘各写各的段 → 只剩一个分身时合并；上限改成 1 退回一次一个。
 */

type Gate = { spec: LeaderRunSpec; release: (exit?: WakeExit) => void };

async function open(t: { after: (fn: () => unknown) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-clones-"));
  t.after(() => removeTemp(data));
  const gates: Gate[] = [];
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      run: (spec) =>
        new Promise<WakeExit>((resolve) => {
          gates.push({ spec, release: (exit = "ok") => resolve(exit) });
        }),
    },
  });
  t.after(async () => {
    for (const gate of gates) gate.release("ok");
    await created.app.close();
  });
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH" | "PUT",
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
  await ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  // t1 是总任务（下有 t2），t3 是独立的任务。
  await ok("POST", "/api/tasks", {
    title: "大功能",
    part: "o2",
    deliver: "none",
  });
  await ok("POST", "/api/tasks", {
    title: "大功能的一块",
    parent: "t1",
    deliver: "none",
  });
  await ok("POST", "/api/tasks", {
    title: "零活",
    part: "o2",
    deliver: "none",
  });
  return { ...created, gates, call, ok };
}

const tokenOf = (gate: Gate) => `Bearer ${gate.spec.env.ATRIUM_LEADER_TOKEN}`;
const idsIn = (prompt: string) =>
  (/atrium events ack ([\d ]+)/.exec(prompt)?.[1] ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);

test("分身：日常与大事同时处理，互不越界，备忘分段后合并", async (t) => {
  const x = await open(t);
  const inbox = x.taskRunner.inbox;
  inbox.publish({
    subscriber: "a1",
    taskId: 1,
    source: "runner",
    kind: "plan_ready",
    key: "t1:plan",
    detail: { title: "大功能", plan: "t4" },
  });
  publishTask(inbox, x.db, 3, "blocked", { reason: "缺依赖" });
  await until(() => x.gates.length === 2, 5000);
  const big = x.gates.find((g) => /处理 t1 的分身/.test(g.spec.prompt))!;
  const routine = x.gates.find((g) => /处理日常的分身/.test(g.spec.prompt))!;
  assert(big && routine, "一个大事分身、一个日常分身");
  assert.notEqual(big.spec.slot, routine.spec.slot);
  assert.notEqual(big.spec.dir, routine.spec.dir);
  assert.match(big.spec.prompt, /t1 plan_ready/);
  assert.doesNotMatch(big.spec.prompt, /t3 blocked/);
  assert.match(routine.spec.prompt, /t3 blocked/);
  assert.match(big.spec.prompt, /此刻另有分身在处理：日常/);

  // 状态：正在处理 2 件。
  const shown = await x.ok("GET", "/api/leaders/a1");
  assert.equal(shown.clones.length, 2);
  assert.equal(shown.clone_limit, 3);
  assert.equal(shown.wake.status, "running");
  assert.equal(shown.wake.clones, 2);
  assert.match(shown.wake.summary, /^2 件：/);
  const listed = await x.ok("GET", "/api/leaders");
  assert.equal(listed.busy[0].clones, 2);

  // 同一任务同一时刻只归一个分身：日常分身动 t1 树里的 t2 被拒，动自己的 t3 放行；记备注不拦。
  const denied = await x.call(
    "PATCH",
    "/api/tasks/t2",
    { title: "改个名" },
    tokenOf(routine),
  );
  assert.equal(denied.status, 409);
  assert.match(JSON.stringify(denied.body), /t2 属于 t1/);
  await x.ok(
    "PATCH",
    "/api/tasks/t3",
    { title: "零活（改）" },
    tokenOf(routine),
  );
  await x.ok("PATCH", "/api/tasks/t2", { title: "一块（改）" }, tokenOf(big));
  await x.ok(
    "POST",
    "/api/tasks/t2/note",
    { text: "日常分身记一笔" },
    tokenOf(routine),
  );
  // 分身改不了自己的并发上限。
  const limit = await x.call(
    "PATCH",
    "/api/leaders/a1",
    { clones: 5 },
    tokenOf(big),
  );
  assert.equal(limit.status, 403);

  // 备忘：各写各的段，主备忘不动。
  const part = await x.ok(
    "PUT",
    "/api/memo",
    { memo: "t3 等依赖" },
    tokenOf(routine),
  );
  assert.equal(part.written_to, "日常");
  await x.ok("PUT", "/api/memo", { memo: "t1 清单待采纳" }, tokenOf(big));
  let memo = await x.ok("GET", "/api/memo?as=a1");
  assert.equal(memo.memo, "");
  assert.deepEqual(
    memo.memo_parts.map((p: { part: string; body: string }) => [
      p.part,
      p.body,
    ]),
    [
      ["日常", "t3 等依赖"],
      ["t1", "t1 清单待采纳"],
    ],
  );

  // 日常分身处理完退出；大事分身只剩自己，写备忘即合并：它开始后别人新写的段留着。
  await x.ok(
    "POST",
    "/api/events/ack",
    { ids: idsIn(routine.spec.prompt) },
    tokenOf(routine),
  );
  routine.release("ok");
  await until(
    () =>
      (
        x.db.prepare("SELECT COUNT(*) AS n FROM leader_clones").get() as {
          n: number;
        }
      ).n === 1,
    5000,
  );
  const merged = await x.ok(
    "PUT",
    "/api/memo",
    { memo: "合并：t1 待采纳；t3 等依赖" },
    tokenOf(big),
  );
  assert.equal(merged.written_to, undefined);
  memo = await x.ok("GET", "/api/memo?as=a1");
  assert.equal(memo.memo, "合并：t1 待采纳；t3 等依赖");
  assert.deepEqual(
    memo.memo_parts.map((p: { part: string }) => p.part),
    ["日常"],
    "大事分身开始后日常分身才写的段留着，下次合并",
  );
  await x.ok(
    "POST",
    "/api/events/ack",
    { ids: idsIn(big.spec.prompt) },
    tokenOf(big),
  );
  big.release("ok");
  await until(
    () =>
      (
        x.db
          .prepare("SELECT wake_status FROM org_leaders WHERE id=1")
          .get() as {
          wake_status: string;
        }
      ).wake_status === "done",
    5000,
  );
  const after = await x.ok("GET", "/api/leaders/a1");
  assert.equal(after.clones.length, 0);
  assert.equal(after.wake.clones, 0);
});

test("分身上限改成 1：同一 leader 一次一个唤醒，事件一起送；破坏输入报 --clones", async (t) => {
  const x = await open(t);
  for (const bad of [0, 9, "两个"]) {
    const result = await x.call("PATCH", "/api/leaders/a1", { clones: bad });
    assert.equal(result.status, 400);
    assert.match(JSON.stringify(result.body), /分身并发上限应为 1～8/);
  }
  const edited = await x.ok("PATCH", "/api/leaders/a1", { clones: "1" });
  assert.equal(edited.clone_limit, 1);
  const inbox = x.taskRunner.inbox;
  inbox.publish({
    subscriber: "a1",
    taskId: 1,
    source: "runner",
    kind: "plan_ready",
    key: "t1:plan",
    detail: { title: "大功能" },
  });
  publishTask(inbox, x.db, 3, "blocked", { reason: "缺依赖" });
  await until(() => x.gates.length === 1, 5000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(x.gates.length, 1, "上限 1 时不起第二个");
  const only = x.gates[0]!;
  assert.match(only.spec.prompt, /t1 plan_ready/);
  assert.match(only.spec.prompt, /t3 blocked/);
  assert.match(only.spec.prompt, /此刻没有别的分身在跑/);
  only.release("ok");
});
