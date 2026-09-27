import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { publishTask } from "../server/tasks/notice.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import {
  dateOf,
  deciderOf,
  decisionLine,
  promptDecisions,
  supersedeVerdict,
  validateDecision,
  type Decision,
} from "../server/memos/decisions.ts";
import { ensureMemoTables, memoText } from "../server/memos/store.ts";
import { leaderRule } from "../server/leaders/scope.ts";
import { until } from "./task-fixture.ts";

/**
 * 秘书与 leader 的备忘和决定记录（t97）：纯函数判定穷举；集成走内存服务，
 * 覆盖追加、推翻、只列有效、分页、leader 令牌只能动自己的、唤醒提示词、网页接口与旧列迁移。
 */

// ---- 纯函数 ----

const NOW = new Date(2026, 8, 27, 12).getTime();

test("谁拍板：缺省是记录的主人；u1、secretary、秘书、aN 可用，其余报 --by", () => {
  assert.equal(deciderOf(undefined, "secretary"), "secretary");
  assert.equal(deciderOf("", "a1"), "a1");
  assert.equal(deciderOf("u1", "secretary"), "u1");
  assert.equal(deciderOf("秘书", "a1"), "secretary");
  assert.equal(deciderOf("secretary", "a1"), "secretary");
  assert.equal(deciderOf(" a12 ", "secretary"), "a12");
  for (const bad of ["u2", "a0", "老板", 3])
    assert.throws(() => deciderOf(bad, "secretary"), /--by: 谁拍板/);
});

test("日期：缺省本地今天；只认真实存在、不在将来的 YYYY-MM-DD", () => {
  assert.equal(dateOf(undefined, NOW), "2026-09-27");
  assert.equal(dateOf("2026-09-26", NOW), "2026-09-26");
  for (const bad of ["2026-9-26", "2026-02-30", "2026-13-01", "昨天", 20260926])
    assert.throws(() => dateOf(bad, NOW), /--date: 日期应为/);
  assert.throws(() => dateOf("2026-09-28", NOW), /不能是将来/);
});

test("决定字段校验：必填、上限、关联格式与未知字段，报命令行参数名", () => {
  const ok = validateDecision(
    {
      text: " 额度读取不依赖 OpenQuota ",
      why: "要迁到别的设备",
      by: "u1",
      issue: "#352",
      task: "t9",
      node: "o3",
      supersedes: "d2",
    },
    "secretary",
    NOW,
  );
  assert.deepEqual(ok, {
    text: "额度读取不依赖 OpenQuota",
    why: "要迁到别的设备",
    by: "u1",
    date: "2026-09-27",
    issue: 352,
    node: "o3",
    task: 9,
    supersedes: 2,
  });
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ why: "x" }, /决定: 决定不能为空/],
    [{ text: "x" }, /--why: 原因不能为空/],
    [{ text: "x", why: "  " }, /--why: 原因不能为空/],
    [{ text: "字".repeat(301), why: "x" }, /决定: 决定不能超过 300 字/],
    [{ text: "x", why: "字".repeat(1001) }, /--why: 原因不能超过 1000 字/],
    [{ text: "x", why: "y", issue: "abc" }, /--issue: 应为 issue 号/],
    [{ text: "x", why: "y", task: "task9" }, /--task: 任务短号/],
    [{ text: "x", why: "y", supersedes: "k1" }, /--supersedes: 决定短号/],
    [{ text: "x", why: "y", node: 3 }, /--node: 应为组织节点/],
    [{ text: "x", why: "y", owner: "a1" }, /owner: 是未知字段/],
  ];
  for (const [body, message] of cases)
    assert.throws(() => validateDecision(body, "secretary", NOW), message);
  assert.throws(() => validateDecision([], "secretary"), /请求体应为对象/);
});

test("推翻判定：同一份记录、旧的有效、新的有效且不是同一条", () => {
  const d = (id: number, owner = "secretary", by: number | null = null) => ({
    id,
    owner,
    superseded_by: by,
  });
  assert.equal(supersedeVerdict("secretary", d(1), d(2)), null);
  assert.match(supersedeVerdict("secretary", d(1), d(1))!, /不能推翻自己/);
  assert.match(
    supersedeVerdict("secretary", d(1, "a1"), d(2))!,
    /d1 是 a1 的决定记录，不在 秘书 的记录里（用 --as a1）/,
  );
  assert.match(
    supersedeVerdict("a1", d(1, "a1"), d(2))!,
    /d2 是 秘书 的决定记录/,
  );
  assert.match(
    supersedeVerdict("secretary", d(1, "secretary", 3), d(2))!,
    /d1 已被 d3 推翻/,
  );
  assert.match(
    supersedeVerdict("secretary", d(1), d(2, "secretary", 4))!,
    /d2 自己已被 d4 推翻/,
  );
});

test("唤醒附的决定：按顺序取，条数与总字数都有上限，不截半条", () => {
  const list = Array.from({ length: 5 }, (_, i) => ({
    text: `决定${i}`,
    why: "字".repeat(80),
  }));
  assert.deepEqual(promptDecisions(list, 3, 10_000).shown, list.slice(0, 3));
  assert.equal(promptDecisions(list, 3, 10_000).omitted, 2);
  // 每条约 103 字：上限 250 只放得下两条。
  const capped = promptDecisions(list, 10, 250);
  assert.equal(capped.shown.length, 2);
  assert.equal(capped.omitted, 3);
  assert.deepEqual(promptDecisions([], 10, 100), { shown: [], omitted: 0 });
});

test("决定一行：日期、谁定的、原因、关联、推翻关系", () => {
  const base: Decision = {
    ref: "d3",
    owner: "secretary",
    date: "2026-09-27",
    by: "u1",
    text: "秘书备忘进 Atrium",
    why: "换机器带不走",
    issue: 355,
    node: "o3",
    node_name: "组织和规矩",
    task: "t97",
    superseded_by: null,
    supersedes: ["d1"],
    created_at: 0,
  };
  assert.equal(
    decisionLine(base),
    "d3 09-27 u1 定：秘书备忘进 Atrium——换机器带不走（#355 o3 t97）（推翻 d1）",
  );
  assert.equal(
    decisionLine({
      ...base,
      by: "secretary",
      issue: null,
      node: null,
      node_name: null,
      task: null,
      supersedes: [],
      superseded_by: "d5",
    }),
    "d3 09-27 秘书 定：秘书备忘进 Atrium——换机器带不走【已被 d5 推翻】",
  );
});

test("备忘正文：去首尾空白，超上限报错并给看现状的命令", () => {
  assert.equal(memoText("  在等 t5  "), "在等 t5");
  assert.throws(() => memoText(3), /memo: 应为文本/);
  assert.throws(
    () => memoText("字".repeat(2001), "atrium memo show"),
    /备忘 2001 字，超过上限 2000 字/,
  );
});

test("leader 权限表：备忘与决定记录的写接口按 ?as= 锁成自己放行", () => {
  assert.equal(leaderRule("PUT", "/api/memo"), "self");
  assert.equal(leaderRule("POST", "/api/decisions"), "self");
  assert.equal(leaderRule("POST", "/api/decisions/:id/supersede"), "self");
  assert.equal(leaderRule("GET", "/api/decisions"), "read");
  assert.equal(leaderRule("DELETE", "/api/decisions/:id"), "deny");
});

test("早先 org_leaders.memo 里的 leader 备忘启动时迁到 memos，已有的不覆盖；带旧运行时的表照常", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE org_leaders (id INTEGER PRIMARY KEY, name TEXT NOT NULL, worker TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO org_leaders VALUES (1,'甲','codex','旧备忘',1,5),(2,'乙','codex','',1,1),(3,'丙','codex','旧的丙',1,1);`);
  db.exec(
    "CREATE TABLE memos (owner TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO memos VALUES ('a3','新的丙',9)",
  );
  ensureMemoTables(db);
  ensureMemoTables(db);
  assert.deepEqual(
    db
      .prepare("SELECT owner,body,updated_at FROM memos ORDER BY owner")
      .all()
      .map((r) => ({ ...r })),
    [
      { owner: "a1", body: "旧备忘", updated_at: 5 },
      { owner: "a3", body: "新的丙", updated_at: 9 },
    ],
  );
});

// ---- 集成 ----

async function open(t: { after: (fn: () => unknown) => void }) {
  const data = mkdtempSync(join(tmpdir(), "atrium-memos-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const runs: LeaderRunSpec[] = [];
  let behave: (spec: LeaderRunSpec) => Promise<"ok"> = async () => "ok";
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: { pace: async () => undefined },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      run: async (spec) => {
        runs.push(spec);
        return behave(spec);
      },
    },
  });
  t.after(() => created.app.close());
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
  return {
    ...created,
    runs,
    call,
    ok,
    set: (next: typeof behave) => {
      behave = next;
    },
  };
}

test("决定记录：追加三条、推翻一条，缺省只列有效的，--all 全列；分页与破坏输入", async (t) => {
  const x = await open(t);
  const d1 = await x.ok("POST", "/api/decisions", {
    text: "秘书的决定记录作为私人备忘",
    why: "先不做",
    by: "u1",
    date: "2026-09-26",
  });
  assert.equal(d1.ref, "d1");
  assert.equal(d1.owner, "secretary");
  const d2 = await x.ok("POST", "/api/decisions?as=secretary", {
    text: "额度读取不依赖 OpenQuota",
    why: "要迁到别的设备",
    by: "u1",
    issue: "352",
    node: "atrium",
  });
  assert.equal(d2.node, "o2");
  assert.equal(d2.node_name, "Atrium");
  assert.equal(d2.issue, 352);
  const d3 = await x.ok("POST", "/api/decisions", {
    text: "秘书和 leader 的备忘进 Atrium",
    why: "换机器、换秘书带不走",
    by: "u1",
    issue: 355,
  });
  const superseded = await x.ok("POST", "/api/decisions/d1/supersede", {
    by: "d3",
  });
  assert.equal(superseded.old.superseded_by, "d3");
  assert.deepEqual(superseded.next.supersedes, ["d1"]);

  const active = await x.ok("GET", "/api/decisions");
  assert.deepEqual(
    active.decisions.map((d: Decision) => d.ref),
    [d3.ref, d2.ref],
  );
  assert.equal(active.active, 2);
  assert.equal(active.superseded, 1);
  const everything = await x.ok("GET", "/api/decisions?all=1");
  assert.deepEqual(
    everything.decisions.map((d: Decision) => d.ref),
    ["d3", "d2", "d1"],
  );
  // 分页：按 (日期, 编号) 倒序接着取。
  const first = await x.ok("GET", "/api/decisions?all=1&limit=2");
  assert.equal(first.next_before, "d2");
  const second = await x.ok("GET", "/api/decisions?all=1&limit=2&before=d2");
  assert.deepEqual(
    second.decisions.map((d: Decision) => d.ref),
    ["d1"],
  );
  assert.equal(second.next_before, null);

  // 破坏输入：逐条报错，不落库。
  const bad: [string, string, unknown, number, RegExp][] = [
    ["POST", "/api/decisions", { text: "x" }, 400, /--why: 原因不能为空/],
    [
      "POST",
      "/api/decisions",
      { text: "x", why: "y", task: "t99" },
      404,
      /--task: 任务 t99 不存在/,
    ],
    [
      "POST",
      "/api/decisions",
      { text: "x", why: "y", supersedes: "d1" },
      409,
      /d1 已被 d3 推翻/,
    ],
    ["POST", "/api/decisions/d2/supersede", { by: "d2" }, 409, /不能推翻自己/],
    [
      "POST",
      "/api/decisions/d2/supersede",
      { by: "d1" },
      409,
      /d1 自己已被 d3 推翻/,
    ],
    ["POST", "/api/decisions/d9/supersede", { by: "d2" }, 404, /d9 不存在/],
    ["POST", "/api/decisions/x1/supersede", { by: "d2" }, 400, /决定短号/],
    [
      "POST",
      "/api/decisions?as=a7",
      { text: "x", why: "y" },
      404,
      /a7 没有登记/,
    ],
    ["POST", "/api/decisions?as=u1", { text: "x", why: "y" }, 400, /--as/],
    ["GET", "/api/decisions?limit=500", undefined, 400, /--limit/],
  ];
  for (const [method, url, body, status, message] of bad) {
    const result = await x.call(method as "POST", url, body);
    assert.equal(result.status, status, `${url} ${JSON.stringify(body)}`);
    assert.match(result.body.error, message);
  }
  const after = await x.ok("GET", "/api/decisions?all=1");
  assert.equal(after.decisions.length, 3);
});

test("备忘：秘书 memo edit 后 memo show 可见；leader edit --memo 与 memo --as aN 同一份", async (t) => {
  const x = await open(t);
  const empty = await x.ok("GET", "/api/memo");
  assert.equal(empty.owner, "secretary");
  assert.equal(empty.memo, "");
  await x.ok("PUT", "/api/memo", { memo: "  在等 t97 上线，先看合入队列  " });
  await x.ok("POST", "/api/decisions", { text: "甲", why: "乙", by: "u1" });
  const shown = await x.ok("GET", "/api/memo?as=secretary");
  assert.equal(shown.memo, "在等 t97 上线，先看合入队列");
  assert.equal(shown.name, "秘书");
  assert.deepEqual(
    shown.decisions.map((d: Decision) => d.text),
    ["甲"],
  );
  const tooLong = await x.call("PUT", "/api/memo", { memo: "字".repeat(2001) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /超过上限 2000 字/);
  assert.equal(
    (await x.call("PUT", "/api/memo", { memo: "x", extra: 1 })).status,
    400,
  );

  await x.ok("POST", "/api/leaders", {
    name: "Atrium 负责人",
    worker: "claude+opus",
    memo: "登记时写的",
  });
  assert.equal((await x.ok("GET", "/api/memo?as=a1")).memo, "登记时写的");
  await x.ok("PATCH", "/api/leaders/a1", { memo: "leader edit 写的" });
  assert.equal((await x.ok("GET", "/api/memo?as=a1")).memo, "leader edit 写的");
  await x.ok("PUT", "/api/memo?as=a1", { memo: "memo edit 写的" });
  assert.equal((await x.ok("GET", "/api/leaders/a1")).memo, "memo edit 写的");
  assert.equal(
    (await x.ok("GET", "/api/leaders")).leaders[0].memo,
    "memo edit 写的",
  );
  // 秘书的备忘没被动。
  assert.equal(
    (await x.ok("GET", "/api/memo")).memo,
    "在等 t97 上线，先看合入队列",
  );

  // 网页详情页：秘书页与负责人页（含已推翻的决定）；没登记的 404。
  const old = await x.ok("POST", "/api/decisions?as=a1", {
    text: "旧做法",
    why: "当时够用",
  });
  await x.ok("POST", "/api/decisions?as=a1", {
    text: "新做法",
    why: "旧的不够",
    supersedes: old.ref,
  });
  const page = await x.ok("GET", "/api/map/leaders/a1");
  assert.equal(page.kind, "leader");
  assert.equal(page.memo, "memo edit 写的");
  assert.equal(typeof page.memo_updated_at, "number");
  assert.deepEqual(
    page.decisions.map((d: { text: string }) => d.text).sort(),
    ["新做法", "旧做法"].sort(),
  );
  assert.ok(Array.isArray(page.events));
  const secretary = await x.ok("GET", "/api/map/leaders/secretary");
  assert.equal(secretary.kind, "secretary");
  assert.equal(secretary.memo, "在等 t97 上线，先看合入队列");
  assert.ok(
    secretary.decisions.every(
      (d: { owner: string }) => d.owner === "secretary",
    ),
  );
  assert.equal((await x.call("GET", "/api/map/leaders/a9")).status, 404);
});

test("leader 唤醒提示词带自己的备忘与最近的有效决定；令牌只能读写自己的记录", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("PUT", "/api/memo?as=a1", { memo: "上次在等 t1 的 CI" });
  await x.ok("POST", "/api/decisions?as=a1", {
    text: "旧取舍",
    why: "当时这么想",
  });
  await x.ok("POST", "/api/decisions?as=a1", {
    text: "t1 改派 codex",
    why: "claude 连续超时",
    supersedes: "d1",
  });
  await x.ok("POST", "/api/decisions", {
    text: "秘书的决定",
    why: "不给 a1 看",
  });
  await x.ok("POST", "/api/tasks", {
    title: "待处理",
    part: "o2",
    deliver: "none",
  });
  let checked = false;
  let failure: unknown;
  x.set(async (spec) => {
    if (checked || failure) return "ok";
    try {
      assert.match(spec.prompt, /上次在等 t1 的 CI/);
      assert.match(
        spec.prompt,
        /d2 \d\d-\d\d a1 定：t1 改派 codex——claude 连续超时（推翻 d1）/,
      );
      assert.doesNotMatch(spec.prompt, /旧取舍/);
      assert.doesNotMatch(spec.prompt, /秘书的决定/);
      assert.match(spec.prompt, /atrium decision add 决定 --why 原因/);
      const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
      const own = await x.call(
        "PUT",
        "/api/memo",
        { memo: "这次处理完了" },
        token,
      );
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.equal(own.body.owner, "a1");
      const added = await x.call(
        "POST",
        "/api/decisions",
        { text: "不重派", why: "等依赖" },
        token,
      );
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.equal(added.body.owner, "a1");
      assert.equal(
        (await x.call("GET", "/api/memo", undefined, token)).body.memo,
        "这次处理完了",
      );
      // 不能读写秘书的：?as= 锁成自己。
      for (const [method, url, body] of [
        ["GET", "/api/memo?as=secretary", undefined],
        ["PUT", "/api/memo?as=secretary", { memo: "改秘书的" }],
        ["POST", "/api/decisions?as=secretary", { text: "x", why: "y" }],
        ["POST", "/api/decisions/d3/supersede?as=secretary", { by: "d2" }],
      ] as const) {
        const denied = await x.call(method, url, body, token);
        assert.equal(denied.status, 403, `${method} ${url}`);
        assert.match(denied.body.error, /只能用自己（a1）/);
      }
      // 秘书的决定不在 a1 的记录里。
      const cross = await x.call(
        "POST",
        "/api/decisions/d3/supersede",
        { by: "d2" },
        token,
      );
      assert.equal(cross.status, 409);
      assert.match(cross.body.error, /d3 是 秘书 的决定记录/);
      checked = true;
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => checked || failure !== undefined, 20000);
  if (failure) throw failure;
  assert.equal((await x.ok("GET", "/api/memo")).memo, "");
  assert.equal((await x.ok("GET", "/api/memo?as=a1")).memo, "这次处理完了");
});
