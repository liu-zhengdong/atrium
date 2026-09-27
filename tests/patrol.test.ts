import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { addNode } from "../server/org/write.ts";
import { editMap } from "../server/map/write.ts";
import { addLeader } from "../server/leaders/model.ts";
import {
  scenarioAt,
  fingerprintOf,
  inNodeTree,
} from "../server/tasks/patrol.ts";
import { fixture, until } from "./task-fixture.ts";

test("巡检场景轮换与同现象归一", () => {
  assert.equal(scenarioAt(["甲", "乙"], 0), "甲");
  assert.equal(scenarioAt(["甲", "乙"], 1), "乙");
  assert.equal(scenarioAt(["甲", "乙"], 2), "甲");
  assert.throws(() => scenarioAt([], 0), /uses/);
  assert.equal(fingerprintOf("  帮助   缺示例 "), fingerprintOf("帮助 缺示例"));
  const parents = new Map([
    [1, null],
    [2, 1],
    [3, 2],
  ]);
  assert.equal(inNodeTree(3, 2, parents), true);
  assert.equal(inNodeTree(1, 2, parents), false);
  assert.equal(inNodeTree(null, 2, parents), false);
});

test("隔离服务手动巡检：真实环境标记、发现去重、leader 收件并处理、全景可见；旧表不妨碍启动", async (t) => {
  const fx = fixture(t);
  const data = join(fx.root, "patrol-data");
  mkdirSync(data);
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(
    "CREATE TABLE IF NOT EXISTS pi_identities (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO pi_identities VALUES (1,'legacy')",
  );
  legacy.close();
  fx.script(
    "opencode",
    'env > "$PWD/../env-seen.txt"\necho \'{"type":"text","part":{"text":"正在巡检"}}\'\nsleep 1.5\necho \'{"type":"text","part":{"text":"巡检结束"}}\'',
  );
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let received = false;
  let leaderError: unknown;
  const created = await createApp({
    data,
    auth: false,
    tasks: {
      env: { ...fx.env, ATRIUM_DATA: data, ATRIUM_PORT: "4999" },
      workersDir: fx.workers,
      pace: async () => undefined,
      usagePace: async () => undefined,
      diskFreeGb: async () => 1000,
      tickMs: 100,
    },
    leaders: {
      batchMs: 0,
      pollMs: 20,
      run: async (spec) => {
        try {
          const event = /#(\d+) 巡检发现/.exec(spec.prompt);
          assert(event, spec.prompt);
          const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
          const decide = await app.inject({
            method: "POST",
            url: "/api/patrol/findings/f1/decide",
            headers: { host: "127.0.0.1", authorization: token },
            payload: { action: "ignored", reason: "已有改进计划" },
          });
          assert.equal(decide.statusCode, 200, decide.body);
          const ack = await app.inject({
            method: "POST",
            url: "/api/events/ack",
            headers: { host: "127.0.0.1", authorization: token },
            payload: { ids: [Number(event[1])] },
          });
          assert.equal(ack.statusCode, 200, ack.body);
          received = true;
        } catch (error) {
          leaderError = error;
        }
        return leaderError ? "failed" : "ok";
      },
    },
  });
  app = created.app;
  t.after(() => app.close());
  const call = async (
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      ...(payload ? { payload } : {}),
    });
    return {
      status: response.statusCode,
      body: response.json() as Record<string, any>,
    };
  };
  addNode(
    created.db,
    { slug: "org", kind: "org", name: "组织", reason: "建" },
    "u1",
  );
  addNode(
    created.db,
    {
      parent: "o1",
      slug: "cli",
      kind: "project",
      name: "命令行",
      reason: "建",
    },
    "u1",
  );
  editMap(
    created.db,
    "o2",
    { uses: ["看帮助", "看全景"], flow: ["打开帮助", "按回执操作"] },
    "u1",
  );
  addLeader(created.db, { name: "负责人", worker: "opencode" });
  const assign = await app.inject({
    method: "PATCH",
    url: "/api/org/nodes/o2",
    headers: { host: "127.0.0.1" },
    payload: { leader: "a1", reason: "巡检处理" },
  });
  assert.equal(assign.statusCode, 200, assign.body);
  const first = await call("POST", "/api/patrol/nodes/o2/run", {
    worker: "opencode",
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.scenario, "看帮助");
  const invalid = await call(
    "POST",
    `/api/patrol/tasks/${first.body.task.ref}/findings`,
    { phenomenon: "缺示例" },
  );
  assert.equal(invalid.status, 400);
  const finding = {
    phenomenon: "帮助缺示例",
    step: "打开帮助",
    command: "atrium guide",
    expected: "有示例",
    actual: "没有示例",
    kind: "awkward",
  };
  const reported = await call(
    "POST",
    `/api/patrol/tasks/${first.body.task.ref}/findings`,
    finding,
  );
  assert.equal(reported.status, 201, JSON.stringify(reported.body));
  assert.equal(reported.body.finding.ref, "f1");
  assert.equal(
    (
      await call(
        "POST",
        `/api/patrol/tasks/${first.body.task.ref}/findings`,
        finding,
      )
    ).body.duplicate,
    true,
  );
  await until(() => received || !!leaderError, 10000);
  if (leaderError) throw leaderError;
  const env = readFileSync(
    join(data, "tasks", String(first.body.task.id), "env-seen.txt"),
    "utf8",
  );
  assert.match(env, /ATRIUM_DATA=/);
  assert.match(env, /ATRIUM_PORT=4999/);
  assert.doesNotMatch(env, /ATRIUM_WORKER=1/);
  const map = await call("GET", "/api/map/nodes/o2");
  assert.equal(map.body.findings[0].status, "ignored");
  assert.equal(map.body.findings[0].reason, "已有改进计划");
  const second = await call("POST", "/api/patrol/nodes/o2/run", {
    worker: "opencode",
  });
  assert.equal(second.body.scenario, "看全景");
  const repeated = await call(
    "POST",
    `/api/patrol/tasks/${second.body.task.ref}/findings`,
    finding,
  );
  assert.equal(repeated.body.duplicate, true);
  await until(
    () =>
      !!(
        created.db
          .prepare("SELECT finished_at FROM patrol_runs WHERE task_id=?")
          .get(second.body.task.id) as { finished_at: number | null }
      ).finished_at,
  );
  assert.equal(
    (
      created.db
        .prepare(
          "SELECT kind FROM task_inbox WHERE task_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(second.body.task.id) as { kind: string }
    ).kind,
    "patrol_finished",
  );
  assert.equal(
    (
      created.db.prepare("SELECT count(*) n FROM patrol_findings").get() as {
        n: number;
      }
    ).n,
    1,
  );
  assert.equal(
    (
      created.db
        .prepare("SELECT value FROM pi_identities WHERE id=1")
        .get() as { value: string }
    ).value,
    "legacy",
  );
});
