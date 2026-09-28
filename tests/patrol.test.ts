import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { addNode } from "../server/org/write.ts";
import { editMap } from "../server/map/write.ts";
import { scenarioAt } from "../server/tasks/patrol.ts";
import { fixture, until } from "./task-fixture.ts";

test("巡检场景轮换：按 uses 逐次轮换，没有场景就停下", () => {
  assert.equal(scenarioAt(["甲", "乙"], 0), "甲");
  assert.equal(scenarioAt(["甲", "乙"], 1), "乙");
  assert.equal(scenarioAt(["甲", "乙"], 2), "甲");
  assert.throws(() => scenarioAt([], 0), /uses/);
});

test("隔离服务巡检：连回本机服务、不带执行者标记；发现直接建修复任务，同标题没结束的拒绝；旧表不妨碍启动", async (t) => {
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
    'env > "$PWD/../env-seen.txt"\necho \'{"type":"text","part":{"text":"巡检结束"}}\'',
  );
  const created = await createApp({
    data,
    auth: false,
    tasks: {
      env: { ...fx.env, ATRIUM_DATA: data, ATRIUM_PORT: "4999" },
      workersDir: fx.workers,
      pace: async () => undefined,
      usagePace: async () => undefined,
      tickMs: 100,
    },
  });
  const app = created.app;
  t.after(() => app.close());
  const call = async (method: "GET" | "POST", url: string, payload?: object) => {
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
    { parent: "o1", slug: "cli", kind: "project", name: "命令行", reason: "建" },
    "u1",
  );
  editMap(
    created.db,
    "o2",
    { uses: ["看帮助", "看全景"], flow: ["打开帮助", "按回执操作"] },
    "u1",
  );
  const schedule = await call("POST", "/api/schedules", {
    node: "o2",
    kind: "patrol",
    every: "1d",
    worker: "opencode",
  });
  assert.equal(schedule.status, 201, JSON.stringify(schedule.body));
  const first = await call("POST", "/api/schedules/s1/run");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.scenario, "看帮助");
  const id = first.body.task.id as number;
  await until(() => {
    try {
      return /ATRIUM_PORT/.test(
        readFileSync(join(data, "tasks", String(id), "env-seen.txt"), "utf8"),
      );
    } catch {
      return false;
    }
  }, 10000);
  const env = readFileSync(
    join(data, "tasks", String(id), "env-seen.txt"),
    "utf8",
  );
  assert.match(env, /ATRIUM_DATA=/);
  assert.match(env, /ATRIUM_PORT=4999/);
  assert.doesNotMatch(env, /ATRIUM_WORKER=1/);
  // 巡检要连用户的服务，不带执行者标记（t203），免得那边起的进程被当成孤儿。
  assert.doesNotMatch(env, /ATRIUM_SPAWN=/);
  const prompt = readFileSync(
    join(data, "tasks", String(id), "prompt.md"),
    "utf8",
  );
  assert.match(prompt, /atrium task add '修复：简短现象' --part o2 --priority 修复/);

  const fix = { title: "修复：帮助缺示例", part: "o2", priority: "修复" };
  assert.equal((await call("POST", "/api/tasks", fix)).status, 201);
  const again = await call("POST", "/api/tasks", fix);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.match(again.body.error, /o2 已有同标题的修复任务 t\d+ 还没结束/);
  assert.equal(
    (await call("POST", "/api/tasks", { ...fix, priority: "普通" })).status,
    201,
    "只对修复任务去重",
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
