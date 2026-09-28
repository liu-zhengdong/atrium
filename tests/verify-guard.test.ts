import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getTask } from "../server/tasks/ledger.ts";
import {
  stopgapAction,
  VERIFIER_HEADER,
  verifierRef,
  verifierVerdict,
} from "../server/tasks/verify-scope.ts";
import { VERIFY_RULES, verifyBrief } from "../server/tasks/verify.ts";
import { DEFAULT_RULES } from "../server/tasks/prepare.ts";
import {
  VERIFIER_HEADER as CLI_HEADER,
  verifierCommandGuard,
  verifierHeaders,
  verifierIsolated,
} from "../cli/worker-guard.ts";
import { startApp, until } from "./task-fixture.ts";

/**
 * 上线验证不许在真实环境停别人的活（t239）：验证身份的服务端边界（纯函数穷举）、命令行带头与隔离实例的分辨、
 * 隔离服务 + 假执行者里验证身份调 host clean / 停别的任务被拒而用户与 leader 照常，停止事件记发起者。
 */

const check = (
  method: string,
  route: string,
  extra: { id?: string; body?: unknown; self?: string } = {},
) => stopgapAction({ method, route, self: "t9", ...extra });

test("验证身份的边界：止损类写接口拒绝，读接口、停自己与其他写接口放行", () => {
  // 止损类：停别人的活、改主机或服务状态。
  for (const [method, route, extra] of [
    ["POST", "/api/hosts/:id/clean", { id: "h3" }],
    ["POST", "/api/hosts/:id/pause", { id: "h1", body: { paused: true } }],
    ["POST", "/api/hosts/:id/pause", { id: "h1", body: { paused: false } }],
    ["POST", "/api/hosts", { body: { name: "x" } }],
    ["PATCH", "/api/hosts/:id", { id: "h2", body: {} }],
    ["DELETE", "/api/hosts/:id", { id: "h2" }],
    ["POST", "/api/service/stop", {}],
    ["POST", "/api/service/prepare-restart", {}],
    ["POST", "/api/auth/rotate", {}],
    ["POST", "/api/tasks/:id/stop", { id: "t5" }],
    ["POST", "/api/tasks/:id/stop", { id: "5" }],
    ["POST", "/api/tasks/:id/stop", { id: "t9", self: "" }],
    [
      "PATCH",
      "/api/tasks/:id",
      { id: "t5", body: { stopgap: "atrium host clean h1" } },
    ],
    ["PATCH", "/api/tasks/:id", { id: "t5", body: { urgent: true } }],
    [
      "PATCH",
      "/api/tasks/:id",
      { id: "t5", body: { status: "cancelled", with_children: true } },
    ],
    ["POST", "/api/tasks", { body: { title: "x", urgent: true } }],
    [
      "POST",
      "/api/tasks",
      { body: { title: "x", stopgap: "atrium host pause h1" } },
    ],
    ["POST", "/api/tasks/:id/run", { id: "t5", body: { urgent: true } }],
  ] as const)
    assert.ok(
      check(method, route, extra),
      `${method} ${route} ${JSON.stringify(extra)} 应拒绝`,
    );
  // 放行：读接口、停自己、普通写接口。
  for (const [method, route, extra] of [
    ["GET", "/api/hosts", {}],
    ["GET", "/api/hosts/:id", { id: "h1" }],
    ["HEAD", "/api/tasks/:id", { id: "t5" }],
    ["GET", "/api/tasks/:id/wait", { id: "t5" }],
    ["POST", "/api/tasks/:id/stop", { id: "t9" }],
    ["POST", "/api/tasks/:id/stop", { id: "9" }],
    ["POST", "/api/tasks", { body: { title: "验证用", urgent: false } }],
    ["PATCH", "/api/tasks/:id", { id: "t5", body: { status: "cancelled" } }],
    [
      "PATCH",
      "/api/tasks/:id",
      { id: "t5", body: { urgent: false, stopgap: "" } },
    ],
    ["POST", "/api/tasks/:id/run", { id: "t5", body: { worker: "kimi" } }],
    ["POST", "/api/tasks/:id/note", { id: "t5", body: { text: "x" } }],
    ["POST", "/api/events/ack", { body: { ids: [1] } }],
    ["POST", "/api/tasks/:id/stop", { id: "t9", body: null }],
  ] as const)
    assert.equal(
      check(method, route, extra),
      null,
      `${method} ${route} ${JSON.stringify(extra)} 应放行`,
    );
  // 回执写明不能做止损、这一步记 unverifiable、去隔离环境。
  const denied = verifierVerdict({
    method: "POST",
    route: "/api/hosts/:id/clean",
    id: "h3",
    self: "t9",
  })!;
  assert.match(denied, /验证任务不能做止损操作/);
  assert.match(denied, /unverifiable/);
  assert.match(denied, /ATRIUM_DATA/);
  assert.match(check("POST", "/api/tasks/:id/stop", { id: "t5" })!, /t5/);
});

test("验证身份头：tN 认出自己，其他值仍按验证执行者限制，没有头不限", () => {
  assert.equal(verifierRef(undefined), undefined);
  assert.equal(verifierRef(""), undefined);
  assert.equal(verifierRef("  "), undefined);
  assert.equal(verifierRef("t233"), "t233");
  assert.equal(verifierRef(" T12 "), "t12");
  assert.equal(verifierRef(["t3", "t4"]), "t3");
  for (const odd of ["1", "t0", "a1", "t1;x", "../t1"])
    assert.equal(verifierRef(odd), "", odd);
  assert.equal(VERIFIER_HEADER, CLI_HEADER);
});

test("命令行：连真实服务带验证身份头并拦启停；自己起的隔离实例不带头、不拦", () => {
  const real = join("/", "srv", "atrium-real");
  const base = {
    ATRIUM_VERIFIER: "1",
    ATRIUM_TASK: "t233",
    ATRIUM_VERIFIER_DATA: real,
  };
  // 运行时给的真实服务。
  const onReal = { ...base, ATRIUM_DATA: real, ATRIUM_PORT: "4310" };
  assert.equal(verifierIsolated(onReal), false);
  assert.deepEqual(verifierHeaders(onReal), { [CLI_HEADER]: "t233" });
  assert.throws(() => verifierCommandGuard("stop", onReal), /无法验证/);
  // 临时数据目录 + 另一个端口：隔离实例。
  const isolated = {
    ...base,
    ATRIUM_DATA: join("/", "tmp", "verify-x"),
    ATRIUM_PORT: "4399",
  };
  assert.equal(verifierIsolated(isolated), true);
  assert.deepEqual(verifierHeaders(isolated), {});
  verifierCommandGuard(undefined, isolated);
  verifierCommandGuard("stop", isolated);
  // 只换数据目录不换端口、端口是 4310、没给端口、认不出真实服务：都不算隔离。
  for (const env of [
    { ...base, ATRIUM_DATA: join("/", "tmp", "verify-x") },
    { ...base, ATRIUM_DATA: join("/", "tmp", "verify-x"), ATRIUM_PORT: "4310" },
    {
      ATRIUM_VERIFIER: "1",
      ATRIUM_TASK: "t233",
      ATRIUM_DATA: join("/", "tmp", "verify-x"),
      ATRIUM_PORT: "4399",
    },
  ]) {
    assert.equal(verifierIsolated(env), false, JSON.stringify(env));
    assert.deepEqual(verifierHeaders(env), { [CLI_HEADER]: "t233" });
  }
  // 旧环境没有 ATRIUM_TASK：照样带头（服务端按验证执行者限制）。
  assert.deepEqual(verifierHeaders({ ATRIUM_VERIFIER: "1" }), {
    [CLI_HEADER]: "1",
  });
  // 不是验证执行者：不带头。
  assert.deepEqual(verifierHeaders({}), {});
  assert.deepEqual(verifierHeaders({ ATRIUM_VERIFIER: "0" }), {});
});

test("提示词：验证执行者止损类步骤记 null、引导去隔离环境；写端到端验证要标注破坏性步骤", () => {
  const rules = VERIFY_RULES.join("\n");
  assert.match(rules, /host clean/);
  assert.match(rules, /matched=null/);
  assert.match(rules, /隔离环境/);
  assert.match(rules, /只在隔离环境/);
  assert.match(rules, /需要人工/);
  const brief = verifyBrief({
    ref: "t1",
    title: "x",
    version: "0.1.0",
    pr_url: null,
    steps: "atrium host clean h1",
  });
  assert.match(brief, /不在真实环境跑/);
  const e2e = DEFAULT_RULES.find((rule) => rule.includes("端到端验证"))!;
  assert.match(e2e, /只在隔离环境/);
  assert.match(e2e, /需要人工/);
});

/** 假 kimi 一直有输出、不收工，直到被停。 */
const waitingKimi = (fx: { script: (name: string, body: string) => void }) =>
  fx.script("kimi", "while true; do echo waiting; sleep 0.1; done");

const stopDetails = (db: DatabaseSync, ref: string) =>
  getTask(db, ref)
    .events.filter((event) => event.kind === "stop_requested")
    .map((event) => JSON.parse(event.detail ?? "null"));

test("隔离服务：验证身份调 host clean、停别的任务被拒，停自己可以；用户 host clean 与 leader 停任务照常，停止事件记发起者", async (t) => {
  const { fx, data, call, app } = await startApp(t, waitingKimi);
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const as =
    (verifier: string | undefined) =>
    async (method: "GET" | "POST", url: string, payload?: object) => {
      const response = await app.inject({
        method,
        url,
        headers: {
          host: "127.0.0.1",
          ...(verifier ? { [VERIFIER_HEADER]: verifier } : {}),
        },
        ...(payload ? { payload } : {}),
      });
      return { status: response.statusCode, body: response.json() };
    };
  const verifier = as("t3");
  for (const title of ["别人的活甲", "别人的活乙", "上线验证：t1"]) {
    await call("POST", "/api/tasks", { title, repo: fx.repo });
  }
  for (const ref of ["t1", "t2", "t3"]) {
    const run = await call("POST", `/api/tasks/${ref}/run`, { worker: "kimi" });
    assert.equal(run.body.task.status, "running", ref);
  }

  // 验证身份：host clean、host pause、停别的任务都被拒，回执写明记 unverifiable。
  for (const [url, payload] of [
    ["/api/hosts/h1/clean", {}],
    ["/api/hosts/h1/pause", { paused: true }],
    ["/api/tasks/t1/stop?as=secretary", undefined],
  ] as const) {
    const refused = await verifier("POST", url, payload);
    assert.equal(refused.status, 403, url);
    assert.equal(refused.body.code, "verifier_scope");
    assert.match(refused.body.error, /验证任务不能做止损操作/);
    assert.match(refused.body.error, /unverifiable/);
  }
  assert.equal(getTask(db, "t1").status, "running");
  assert.equal(getTask(db, "t2").status, "running");
  assert.deepEqual(stopDetails(db, "t1"), []);
  // 读照常。
  assert.equal((await verifier("GET", "/api/tasks/t1")).status, 200);
  assert.equal((await verifier("GET", "/api/hosts")).status, 200);

  // 停自己可以，停止事件记验证任务自己。
  const self = await verifier("POST", "/api/tasks/t3/stop?as=secretary");
  assert.equal(self.status, 200);
  await until(() => getTask(db, "t3").status !== "running");
  assert.equal(stopDetails(db, "t3")[0].by, "t3");

  // leader 停任务照常，记 aN（leader 令牌的请求 ?as= 已锁成自己）。
  const leader = await call("POST", "/api/tasks/t2/stop?as=a1");
  assert.equal(leader.status, 200);
  await until(() => getTask(db, "t2").status !== "running");
  assert.equal(stopDetails(db, "t2")[0].by, "a1");

  // 用户 host clean 照常停掉在跑的，停止事件记发起者与缘由。
  const cleaned = await call("POST", "/api/hosts/h1/clean");
  assert.equal(cleaned.status, 200);
  assert.deepEqual(cleaned.body.stopped, ["t1"]);
  await until(() => getTask(db, "t1").status !== "running");
  const [stop] = stopDetails(db, "t1");
  assert.equal(stop.by, "u1");
  assert.equal(stop.reason, "host clean h1 止损");
});
