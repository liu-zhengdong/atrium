import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { publishTask } from "../server/tasks/events/notice.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import {
  dateOf,
  decisionLine,
  likePattern,
  nodeAddresses,
  searchTerms,
  validateDecision,
  type Decision,
} from "../server/memos/decisions.ts";
import { ensureMemoTables, memoText } from "../server/memos/store.ts";
import { leaderRule } from "../server/leaders/scope.ts";
import { until } from "./task-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 备忘（每位一份）与决定记录（只记用户拍板的事）：纯函数判定穷举；集成走内存服务，
 * 覆盖追加、推翻、只列有效、按节点与关键词列、分页、leader 不能记决定、唤醒提示词不带决定。
 */

// ---- 纯函数 ----

const NOW = new Date(2026, 8, 27, 12).getTime();

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
      issue: "#352",
      task: "t9",
      node: "o3",
      supersedes: "d2",
    },
    NOW,
  );
  assert.deepEqual(ok, {
    text: "额度读取不依赖 OpenQuota",
    why: "要迁到别的设备",
    date: "2026-09-27",
    issue: 352,
    nodes: ["o3"],
    task: 9,
    supersedes: 2,
  });
  assert.deepEqual(
    validateDecision({ text: "x", why: "y", node: ["o3", " o4 ", "o3"] }, NOW)
      .nodes,
    ["o3", "o4"],
  );
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
    [{ text: "x", why: "y", by: "a1" }, /by: 是未知字段/],
    [{ text: "x", why: "y", principle: true }, /principle: 是未知字段/],
  ];
  for (const [body, message] of cases)
    assert.throws(() => validateDecision(body, NOW), message);
  assert.throws(() => validateDecision([]), /请求体应为对象/);
});

test("挂节点：一个或多个，去重去空白，至多 10 个", () => {
  assert.deepEqual(nodeAddresses(undefined), []);
  assert.deepEqual(nodeAddresses("o3"), ["o3"]);
  assert.deepEqual(nodeAddresses(["o3", "atrium/org", "o3"]), [
    "o3",
    "atrium/org",
  ]);
  assert.throws(
    () => nodeAddresses(Array.from({ length: 11 }, (_, i) => `o${i + 1}`)),
    /至多挂 10 个节点/,
  );
});

test("检索词：按空白拆、去重，至多 5 个、每个 50 字；空的不筛；LIKE 通配符转义", () => {
  assert.deepEqual(searchTerms("  额度  OpenQuota 额度 "), [
    "额度",
    "OpenQuota",
  ]);
  assert.deepEqual(searchTerms(undefined), []);
  assert.deepEqual(searchTerms("  "), []);
  assert.throws(() => searchTerms("a b c d e f"), /至多 5 个/);
  assert.throws(() => searchTerms("字".repeat(51)), /每个至多 50 字/);
  assert.equal(likePattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
});

test("决定一行：日期、谁定的、原因、关联、推翻关系", () => {
  const base: Decision = {
    ref: "d3",
    date: "2026-09-27",
    by: "u1",
    text: "秘书备忘进 Atrium",
    why: "换机器带不走",
    issue: 355,
    nodes: [
      { ref: "o3", name: "组织和规矩" },
      { ref: "o5", name: null },
    ],
    task: "t97",
    superseded_by: null,
    supersedes: ["d1"],
    created_at: 0,
  };
  assert.equal(
    decisionLine(base),
    "d3 09-27 用户定：秘书备忘进 Atrium——换机器带不走（#355 o3 o5 t97）（推翻 d1）",
  );
  assert.equal(
    decisionLine({
      ...base,
      by: "secretary",
      issue: null,
      nodes: [],
      task: null,
      supersedes: [],
      superseded_by: "d5",
    }),
    "d3 09-27 秘书定：秘书备忘进 Atrium——换机器带不走【已被 d5 推翻】",
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

test("leader 权限表：备忘按 ?as= 锁成自己放行；决定记录只有用户令牌能记", () => {
  assert.equal(leaderRule("PUT", "/api/memo"), "self");
  assert.equal(leaderRule("POST", "/api/decisions"), "deny");
  assert.equal(leaderRule("GET", "/api/decisions"), "read");
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
  t.after(() => removeTemp(data));
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

test("决定记录：追加、推翻，缺省只列有效的，--all 全列；按节点、关键词列；分页与破坏输入", async (t) => {
  const x = await open(t);
  const d1 = await x.ok("POST", "/api/decisions", {
    text: "秘书的决定记录作为私人备忘",
    why: "先不做",
    date: "2026-09-26",
  });
  assert.equal(d1.ref, "d1");
  assert.equal(d1.by, "u1", "决定记录只记用户拍板的");
  const d2 = await x.ok("POST", "/api/decisions?as=secretary", {
    text: "额度读取不依赖 OpenQuota",
    why: "要迁到别的设备",
    issue: "352",
    node: "atrium",
  });
  assert.deepEqual(d2.nodes, [{ ref: "o2", name: "Atrium" }]);
  assert.equal(d2.issue, 352);
  const d3 = await x.ok("POST", "/api/decisions", {
    text: "秘书和 leader 的备忘进 Atrium",
    why: "换机器、换秘书带不走",
    issue: 355,
    supersedes: "d1",
  });
  assert.deepEqual(d3.supersedes, ["d1"]);
  // 早先 leader 记的运行流水留在库里，不再列出。
  x.db
    .prepare(
      "INSERT INTO decisions(owner,decided_on,decided_by,text,why,created_at) VALUES('a1','2026-09-27','a1','旧流水','过程',1)",
    )
    .run();

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
  // 按节点：挂在本块及上级的；关键词：决定与原因里全部命中。
  assert.deepEqual(
    (await x.ok("GET", "/api/decisions?node=o2")).decisions.map(
      (d: Decision) => d.ref,
    ),
    ["d2"],
  );
  assert.deepEqual(
    (
      await x.ok("GET", `/api/decisions?q=${encodeURIComponent("备忘 换机器")}`)
    ).decisions.map((d: Decision) => d.ref),
    ["d3"],
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
    [
      "POST",
      "/api/decisions",
      { text: "x", why: "y", supersedes: "d9" },
      404,
      /d9 不存在/,
    ],
    ["POST", "/api/decisions", { text: "x", why: "y", node: "o9" }, 404, /o9/],
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
  const shown = await x.ok("GET", "/api/memo?as=secretary");
  assert.equal(shown.memo, "在等 t97 上线，先看合入队列");
  assert.equal(shown.name, "秘书");
  assert.equal("decisions" in shown, false, "备忘不带决定摘要");
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

  // 网页详情页：秘书页、负责人页与用户页给备忘；没登记的 404。
  const page = await x.ok("GET", "/api/map/leaders/a1");
  assert.equal(page.kind, "leader");
  assert.equal(page.memo, "memo edit 写的");
  assert.equal(typeof page.memo_updated_at, "number");
  assert.equal("decisions" in page, false);
  assert.ok(Array.isArray(page.events));
  const secretary = await x.ok("GET", "/api/map/leaders/secretary");
  assert.equal(secretary.kind, "secretary");
  assert.equal(secretary.memo, "在等 t97 上线，先看合入队列");
  assert.equal((await x.ok("GET", "/api/map/leaders/u1")).kind, "user");
  assert.equal((await x.call("GET", "/api/map/leaders/a9")).status, 404);
});

test("leader 唤醒提示词带自己的备忘，不带决定记录；令牌只能读写自己的备忘，不能记决定", async (t) => {
  const x = await open(t);
  await x.ok("POST", "/api/leaders", { name: "负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "指派" });
  await x.ok("PUT", "/api/memo?as=a1", { memo: "上次在等 t1 的 CI" });
  await x.ok("POST", "/api/decisions", {
    text: "用户的决定",
    why: "不附进提示词",
    node: "o2",
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
      assert.doesNotMatch(spec.prompt, /用户的决定/);
      assert.match(spec.prompt, /atrium task note tN 文字/);
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
      assert.equal(added.status, 403, JSON.stringify(added.body));
      assert.match(added.body.error, /任务备注/);
      // 不能读写秘书的备忘：?as= 锁成自己。
      for (const [method, url, body] of [
        ["GET", "/api/memo?as=secretary", undefined],
        ["PUT", "/api/memo?as=secretary", { memo: "改秘书的" }],
      ] as const) {
        const denied = await x.call(method, url, body, token);
        assert.equal(denied.status, 403, `${method} ${url}`);
        assert.match(denied.body.error, /只能用自己（a1）/);
      }
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
