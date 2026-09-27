import assert from "node:assert/strict";
import { test } from "node:test";
import { memoProblem, MEMO_MAX } from "../server/leaders/model.ts";
import {
  deliveryRoutes,
  escalationRoute,
  routeTaskEvent,
  type ChainNode,
} from "../server/leaders/route.ts";
import {
  ackVerdict,
  asVerdict,
  denyReason,
  escalateVerdict,
  leaderEditVerdict,
  leaderRule,
  mapEditVerdict,
  nodeEditVerdict,
  ownerVerdict,
  scopeOf,
  scopeVerdict,
} from "../server/leaders/scope.ts";
import { LeaderTokens } from "../server/leaders/tokens.ts";
import {
  afterWake,
  escalateInput,
  leaderPrompt,
  wakeSummary,
  type WakeExit,
} from "../server/leaders/wake.ts";

/** leader 层的纯判定：事件路由、上交目标、权限边界、唤醒收尾、上交输入。 */

const node = (ref: string, leader: string | null, name = ref): ChainNode => ({
  ref,
  name,
  leader,
});

test("上线和上线失败同时投 leader 与秘书，普通完成只投原路由", () => {
  for (const subscriber of ["a1", "secretary", "u1"])
    for (const kind of [
      "online",
      "online_failed",
      "done",
      "failed",
      "merged",
    ]) {
      const route = { subscriber, why: "原路由", via: "o2" };
      const targets = deliveryRoutes(kind, route);
      assert.deepEqual(
        targets.map((target) => target.subscriber),
        kind === "online" || kind === "online_failed"
          ? subscriber === "secretary"
            ? ["secretary"]
            : [subscriber, "secretary"]
          : [subscriber],
      );
      assert.equal(targets[0], route);
    }
});

test("任务事件：写了负责人按负责人投；没写从归属部分向上找最近的已登记 leader，找不到投秘书", () => {
  const registered = new Set(["a1", "a2"]);
  // 组织 o1（u1）→ Atrium o2（a1）→ 组织和规矩 o3（无）→ 专员 o4（a2）
  const o1 = node("o1", "u1", "组织");
  const o2 = node("o2", "a1", "Atrium");
  const o3 = node("o3", null, "组织和规矩");
  const o4 = node("o4", "a2", "安全");
  const cases: {
    owner: string | null;
    chain: ChainNode[];
    to: string;
    via: string | null;
    why: RegExp;
  }[] = [
    {
      owner: "secretary",
      chain: [o3, o2, o1],
      to: "secretary",
      via: null,
      why: /指定了负责人/,
    },
    {
      owner: "a2",
      chain: [o3, o2, o1],
      to: "a2",
      via: null,
      why: /指定了负责人 a2/,
    },
    { owner: "u1", chain: [], to: "u1", via: null, why: /指定了负责人/ },
    { owner: null, chain: [], to: "secretary", via: null, why: /没有归属部分/ },
    {
      owner: null,
      chain: [o3, o2, o1],
      to: "a1",
      via: "o2",
      why: /最近的 leader 是 o2「Atrium」的 a1/,
    },
    {
      owner: null,
      chain: [o2, o1],
      to: "a1",
      via: "o2",
      why: /由它的 leader a1 处理/,
    },
    {
      owner: null,
      chain: [o4, o3, o2, o1],
      to: "a2",
      via: "o4",
      why: /由它的 leader a2/,
    },
    // 根上的 u1 不是 leader 身份，不投给用户。
    {
      owner: null,
      chain: [o1],
      to: "secretary",
      via: null,
      why: /上级都没有 leader/,
    },
    // 没登记的 aN 跳过，继续往上找，并写明跳过了谁。
    {
      owner: null,
      chain: [node("o5", "a9", "别处"), o2, o1],
      to: "a1",
      via: "o2",
      why: /a9（o5） 没有登记为 leader，跳过/,
    },
    {
      owner: null,
      chain: [node("o5", "a9"), o1],
      to: "secretary",
      via: null,
      why: /投秘书；a9（o5） 没有登记/,
    },
  ];
  for (const c of cases) {
    const route = routeTaskEvent({
      owner: c.owner,
      chain: c.chain,
      registered,
    });
    assert.equal(route.subscriber, c.to, JSON.stringify(c));
    assert.equal(route.via, c.via, JSON.stringify(c));
    assert.match(route.why, c.why);
  }
});

test("上交：从负责节点的上一层找另一位 leader，跳过自己与未登记的，找不到投秘书", () => {
  const registered = new Set(["a1", "a2"]);
  const up = [node("o2", "a1", "Atrium"), node("o1", "u1")];
  assert.deepEqual(
    escalationRoute({ leader: "a2", chains: [up], registered }).subscriber,
    "a1",
  );
  // 自己也负责上层时跳过自己。
  assert.equal(
    escalationRoute({ leader: "a1", chains: [up], registered }).subscriber,
    "secretary",
  );
  assert.equal(
    escalationRoute({ leader: "a2", chains: [], registered }).subscriber,
    "secretary",
  );
  assert.equal(
    escalationRoute({
      leader: "a2",
      chains: [[node("o2", "a7"), node("o1", "u1")]],
      registered,
    }).subscriber,
    "secretary",
  );
  // 负责多个节点：取第一个找得到的。
  const route = escalationRoute({
    leader: "a2",
    chains: [[node("o1", "u1")], up],
    registered,
  });
  assert.equal(route.subscriber, "a1");
  assert.match(route.why, /a2 上交，上一层的 leader 是 o2「Atrium」的 a1/);
});

test("权限表：读接口放行，写接口只认列出的，其余一律拒绝并提示上交", () => {
  const allowed: [string, string, string][] = [
    ["GET", "/api/tasks/:id", "read"],
    ["HEAD", "/api/map/tree", "read"],
    ["GET", "/api/events/wait", "read"],
    ["POST", "/api/tasks", "task-create"],
    ["PATCH", "/api/tasks/:id", "task-patch"],
    ["POST", "/api/tasks/:id/run", "task"],
    ["POST", "/api/tasks/:id/tell", "task"],
    ["POST", "/api/tasks/:id/stop", "task"],
    ["POST", "/api/tasks/:id/note", "task"],
    ["POST", "/api/reviews", "review-create"],
    ["POST", "/api/events/ack", "events-ack"],
    ["POST", "/api/org/nodes/:id/points", "point"],
    ["PATCH", "/api/org/points/:id", "point"],
    ["DELETE", "/api/org/points/:id", "point"],
    ["PUT", "/api/org/nodes/:id/stages", "stages"],
    ["PATCH", "/api/org/nodes/:id", "node-edit"],
    ["PATCH", "/api/map/nodes/:id", "map-edit"],
    ["PATCH", "/api/leaders/:id", "leader-edit"],
    ["POST", "/api/leaders/:id/escalate", "escalate"],
  ];
  for (const [method, route, rule] of allowed)
    assert.equal(leaderRule(method, route), rule, `${method} ${route}`);
  const deniedRoutes: [string, string, RegExp][] = [
    ["PUT", "/api/org/nodes/:id/docs/:doc", /改章程、边界与预算/],
    ["POST", "/api/org/nodes/:id/revert", /改章程/],
    ["POST", "/api/reviews/:id/decide", /拍板/],
    ["POST", "/api/org/nodes", /新建组织节点/],
    ["POST", "/api/map/nodes", /新建组织节点/],
    ["POST", "/api/quota/:provider/clear", /额度/],
    ["PUT", "/api/skills/:slug", /技能/],
    ["POST", "/api/leaders", /登记新的 leader/],
    ["POST", "/api/org/import", /调用 POST \/api\/org\/import/],
    ["POST", "/api/events/deliver", /调用/],
    ["POST", "/api/auth/rotate", /调用/],
    ["DELETE", "/api/tasks/:id", /调用/],
  ];
  for (const [method, route, reason] of deniedRoutes) {
    assert.equal(leaderRule(method, route), "deny", `${method} ${route}`);
    const text = denyReason("a1", method, route);
    assert.match(text, reason);
    assert.match(text, /^a1 无权.*上交秘书：atrium leader escalate/);
  }
});

test("作用范围：负责的未归档节点及全部子节点；引用逐条落在范围里才放行", () => {
  const list = [
    { id: 1, parent_id: null, leader: "u1", archived_at: null },
    { id: 2, parent_id: 1, leader: "a1", archived_at: null },
    { id: 3, parent_id: 2, leader: null, archived_at: null },
    { id: 4, parent_id: 3, leader: "a2", archived_at: null },
    { id: 5, parent_id: 1, leader: null, archived_at: null },
    { id: 6, parent_id: 1, leader: "a1", archived_at: 1 },
    { id: 7, parent_id: 6, leader: null, archived_at: null },
  ];
  const a1 = scopeOf(list, "a1");
  assert.deepEqual([...a1.led], [2]);
  assert.deepEqual([...a1.scope].sort(), [2, 3, 4]);
  const a2 = scopeOf(list, "a2");
  assert.deepEqual([...a2.scope], [4]);
  assert.deepEqual([...scopeOf(list, "a3").scope], []);
  assert.equal(scopeVerdict("a1", a1.scope, []), null);
  assert.equal(
    scopeVerdict("a1", a1.scope, [
      { what: "任务 t1", node: 3 },
      { what: "归属部分 o4", node: 4 },
    ]),
    null,
  );
  assert.match(
    scopeVerdict("a1", a1.scope, [
      { what: "任务 t1", node: 3 },
      { what: "任务 t2", node: 5 },
    ])!,
    /a1 无权动任务 t2：不在你负责的部分里/,
  );
  assert.match(
    scopeVerdict("a1", a1.scope, [{ what: "任务 t3", node: null }])!,
    /任务 t3/,
  );
  assert.match(
    scopeVerdict("a2", a2.scope, [{ what: "节点 o3", node: 3 }])!,
    /o3/,
  );
});

test("订阅者、负责人、改节点、改全景、改登记、上交、确认事件的逐项判定", () => {
  assert.equal(asVerdict("a1", undefined), null);
  assert.equal(asVerdict("a1", ""), null);
  assert.equal(asVerdict("a1", "a1"), null);
  assert.match(asVerdict("a1", "secretary")!, /以 secretary 的名义/);
  assert.match(asVerdict("a1", "u1")!, /只能用自己（a1）/);

  for (const ok of [undefined, null, "", "a1"])
    assert.equal(ownerVerdict("a1", ok), null);
  assert.match(ownerVerdict("a1", "secretary")!, /负责人设为 secretary/);

  const led = new Set([2]);
  const scope = new Set([2, 3, 4]);
  const edit = (keys: string[], n: number) =>
    nodeEditVerdict({ leader: "a1", keys, node: n, led, scope });
  assert.equal(edit(["leader", "reason"], 3), null);
  assert.equal(edit(["leader"], 4), null);
  assert.match(edit(["leader"], 2)!, /自己负责的节点/);
  assert.match(edit(["leader"], 5)!, /不在你负责部分/);
  assert.match(edit(["name", "leader"], 3)!, /name/);
  assert.match(edit(["reason"], 3)!, /只能给子节点指派 leader/);
  assert.match(edit(["archive"], 3)!, /archive/);

  assert.equal(mapEditVerdict("a1", ["what", "now", "next"]), null);
  assert.match(mapEditVerdict("a1", ["what", "detail"])!, /章程正文/);
  assert.match(mapEditVerdict("a1", ["rev"])!, /章程正文/);

  assert.equal(leaderEditVerdict("a1", "a1", ["memo"]), null);
  assert.equal(leaderEditVerdict("a1", "a1", []), null);
  assert.match(leaderEditVerdict("a1", "a2", ["memo"])!, /改 a2 的登记/);
  assert.match(leaderEditVerdict("a1", "a1", ["worker", "memo"])!, /worker/);
  assert.match(leaderEditVerdict("a1", "a1", ["name"])!, /只能改备忘/);

  assert.equal(escalateVerdict("a1", "a1"), null);
  assert.match(escalateVerdict("a1", "a2")!, /替 a2 上交/);

  assert.equal(ackVerdict("a1", []), null);
  assert.equal(ackVerdict("a1", ["a1", "a1"]), null);
  assert.match(
    ackVerdict("a1", ["a1", "secretary", "secretary"])!,
    /投给 secretary 的事件/,
  );
});

test("唤醒收尾：处理完、失败累计重试、连续失败或超时转交", () => {
  const exits: WakeExit[] = ["ok", "failed", "timeout"];
  for (const exit of exits)
    for (const unacked of [0, 2])
      for (const failures of [0, 1, 2])
        for (const maxFailures of [1, 2, 3]) {
          const result = afterWake({ exit, unacked, failures, maxFailures });
          const label = JSON.stringify({
            exit,
            unacked,
            failures,
            maxFailures,
          });
          if (exit === "ok" && unacked === 0) {
            assert.deepEqual(result, { kind: "done", failures: 0 }, label);
            continue;
          }
          if (exit === "timeout") {
            assert.equal(result.kind, "handoff", label);
            assert.match((result as { note: string }).note, /超时/);
            continue;
          }
          const next = failures + 1;
          if (next >= maxFailures) {
            assert.equal(result.kind, "handoff", label);
            assert.equal(result.failures, 0, label);
            assert.match(
              (result as { note: string }).note,
              new RegExp(`连续 ${next} 次`),
            );
          } else {
            assert.equal(result.kind, "retry", label);
            assert.equal(result.failures, next, label);
          }
          assert.match(
            (result as { note: string }).note,
            exit === "failed" ? /异常退出/ : /没确认/,
          );
        }
});

test("上交输入：四类之一、说明必填有上限、任务短号；已上线须带任务", () => {
  assert.deepEqual(
    escalateInput({ kind: "cross", note: "  要 OpenQuota 配合 " }),
    { kind: "cross", note: "要 OpenQuota 配合", task: null },
  );
  assert.deepEqual(
    escalateInput({ kind: "shipped", note: "已上线", task: "t5" }),
    { kind: "shipped", note: "已上线", task: "t5" },
  );
  for (const kind of ["beyond", "stuck"])
    assert.equal(escalateInput({ kind, note: "x" }).kind, kind);
  const bad: [unknown, RegExp][] = [
    [null, /请求体应为对象/],
    [[], /请求体应为对象/],
    [{ kind: "done", note: "x" }, /--kind: 上交类型只能是 shipped（已上线）/],
    [{ note: "x" }, /--kind/],
    [{ kind: "cross", note: " " }, /说明: 不能为空/],
    [{ kind: "cross" }, /说明: 不能为空/],
    [{ kind: "cross", note: "字".repeat(2001) }, /至多 2000 字/],
    [{ kind: "cross", note: "x", task: "5" }, /--task: 应为任务短号/],
    [{ kind: "cross", note: "x", task: 5 }, /--task/],
    [{ kind: "shipped", note: "x" }, /已上线」要给上线的任务/],
    [{ kind: "cross", note: "x", extra: 1 }, /extra: 是未知字段/],
  ];
  for (const [body, message] of bad)
    assert.throws(() => escalateInput(body), message, JSON.stringify(body));
});

test("备忘上限：按字数算，超了给精简提示", () => {
  assert.equal(memoProblem(""), null);
  assert.equal(memoProblem("字".repeat(MEMO_MAX)), null);
  assert.match(
    memoProblem("字".repeat(MEMO_MAX + 1))!,
    /超过上限 2000 字；请精简/,
  );
  assert.equal(memoProblem("abc", 3), null);
  assert.match(memoProblem("abcd", 3)!, /4 字/);
});

test("唤醒提示词带全景上下文、备忘、事件、可用命令、权限边界与上交规则", () => {
  const prompt = leaderPrompt({
    leader: "a1",
    name: "Atrium 负责人",
    nodes: [
      {
        ref: "o2",
        name: "Atrium",
        path: "atrium",
        context: "全景位置：组织 → Atrium",
      },
    ],
    memo: "在等 t5 合入",
    events: [
      {
        id: 12,
        task: "t5",
        kind: "failed",
        count: 1,
        detail: { title: "修登录", reason: "测试没过" },
      },
      {
        id: 13,
        task: "t6",
        kind: "blocked",
        count: 2,
        detail: { title: "拆模块", note: "等依赖" },
      },
    ],
    digest: ["t7：退回 1 次后合入"],
    upstream: "秘书",
  });
  for (const part of [
    "leader a1（Atrium 负责人）",
    "全景位置：组织 → Atrium",
    "在等 t5 合入",
    "#12 t5 failed 修登录 · 测试没过",
    "#13 t6 blocked 拆模块 （合并 2 次） · 等依赖",
    "t7：退回 1 次后合入",
    "atrium task run tN",
    "--part o2",
    "不可以：动别的部分的任务",
    "上交（投给 秘书",
    "atrium leader escalate --kind shipped",
    "单个任务上线运行时已自动通知秘书，不必再报",
    "atrium events ack 12 13",
  ])
    assert(prompt.includes(part), part);
  assert.equal(wakeSummary([]), "");
  assert.equal(
    wakeSummary([
      { id: 1, task: "t1", kind: "failed", count: 1, detail: null },
      { id: 2, task: null, kind: "escalated", count: 1, detail: null },
      { id: 3, task: "t3", kind: "done", count: 1, detail: null },
      { id: 4, task: "t4", kind: "done", count: 1, detail: null },
    ]),
    "t1 failed、escalated、t3 done 等 4 件",
  );
});

test("leader 令牌：按 aN 核对、重签作废旧的、撤销与过期即失效，格式不对不认", () => {
  let now = 1000;
  const tokens = new LeaderTokens(() => now);
  const first = tokens.issue("a1", 100);
  assert.match(first, /^a1\.[a-f0-9]{64}$/);
  assert.equal(tokens.verify(`Bearer ${first}`), "a1");
  assert.equal(LeaderTokens.looksLike(`Bearer ${first}`), true);
  assert.equal(LeaderTokens.looksLike(`Bearer ${"f".repeat(64)}`), false);
  // 换个 aN 前缀冒用：按 a2 找不到。
  assert.equal(tokens.verify(`Bearer ${first.replace(/^a1/, "a2")}`), null);
  const second = tokens.issue("a1", 100);
  assert.equal(tokens.verify(`Bearer ${first}`), null);
  assert.equal(tokens.verify(`Bearer ${second}`), "a1");
  now += 101;
  assert.equal(tokens.verify(`Bearer ${second}`), null);
  const third = tokens.issue("a1", 100);
  tokens.revoke("a1");
  assert.equal(tokens.verify(`Bearer ${third}`), null);
  assert.equal(tokens.verify(undefined), null);
  assert.equal(tokens.verify("Bearer a1.xyz"), null);
});
