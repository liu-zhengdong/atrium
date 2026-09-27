import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { createTask, ensureTaskTables } from "../server/tasks/ledger.ts";
import { ensureEventTables } from "../server/tasks/events.ts";
import { addPoint } from "../server/org/points.ts";
import { addNode } from "../server/org/write.ts";
import {
  MAP_REVISION_SQL,
  ensureMapWatch,
  mapRevision,
  startMapWatch,
} from "../server/map/watch.ts";
import { removeTemp } from "./temp-dir.ts";

function memory() {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureTaskTables(db);
  ensureEventTables(db);
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "创建" }, "u1");
  ensureMapWatch(db);
  return db;
}

const planOf = (db: DatabaseSync, sql: string) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map((row) => row.detail)
    .join("\n");

const scansTable = (plan: string, table: string) =>
  new RegExp(`\\bSCAN (?:TABLE )?${table}(?! USING)`, "i").test(plan);

test("检测语句主键点查，不扫任务、收件箱、交付", () => {
  const db = memory();
  for (let i = 0; i < 40; i++) createTask(db, { title: `t${i}` });
  const plan = planOf(db, MAP_REVISION_SQL);
  assert.match(plan, /map_revision/i);
  assert.match(plan, /PRIMARY KEY/i);
  for (const table of ["tasks", "task_inbox", "task_deliveries", "task_events"])
    assert.equal(scansTable(plan, table), false, `${table}: ${plan}`);
});

test("插入与更新都抬版本号（更新不是新 id）", () => {
  const db = memory();
  const before = mapRevision(db);
  const task = createTask(db, { title: "活" });
  const afterInsert = mapRevision(db);
  assert.notEqual(afterInsert, before);
  db.prepare("UPDATE tasks SET status='done',updated_at=? WHERE id=?").run(
    Date.now(),
    task.id,
  );
  assert.notEqual(mapRevision(db), afterInsert);
  addPoint(db, "o1", { text: "要点", why: "理由", by: "u1 09-27" }, "u1");
  assert.ok(mapRevision(db) > afterInsert);
});

test("多名订阅者共用一次检测，次数与人数无关", () => {
  const db = memory();
  let n = 0;
  let tick = () => {};
  const watch = startMapWatch(db, {
    detect: () => n,
    repeat: (_ms, fn) => {
      tick = fn;
      return () => {
        tick = () => {};
      };
    },
  });
  const got: string[][] = [[], [], [], [], [], [], [], []];
  const stops = got.map((buf) => watch.subscribe((event) => buf.push(event)));
  assert.equal(n, 0);
  assert.equal(watch.detectCount, 1, "第一个订阅者只快照一次");
  tick();
  tick();
  assert.equal(watch.detectCount, 3);
  assert.deepEqual(
    got.map((buf) => buf.length),
    got.map(() => 0),
    "没变不推 changed",
  );
  n = 1;
  tick();
  assert.equal(watch.detectCount, 4);
  assert.deepEqual(
    got.map((buf) => buf.join()),
    got.map(() => "changed"),
  );
  for (const stop of stops) stop();
  const after = watch.detectCount;
  tick();
  assert.equal(watch.detectCount, after, "没人订了就停");
  watch.close();
});

test("空闲保活：连续未变到次数就 ping", () => {
  const db = memory();
  let tick = () => {};
  const watch = startMapWatch(db, {
    pingEvery: 3,
    detect: () => 1,
    repeat: (_ms, fn) => {
      tick = fn;
      return () => {};
    },
  });
  const events: string[] = [];
  watch.subscribe((event) => events.push(event));
  tick();
  tick();
  assert.deepEqual(events, []);
  tick();
  assert.deepEqual(events, ["ping"]);
  watch.close();
});

test("开 N 个 SSE 时检测函数调用次数与 N 无关", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-map-watch-"));
  t.after(() => removeTemp(data));
  let detects = 0;
  let tick = () => {};
  const created = await createApp({
    data,
    tasks: { pace: async () => undefined },
    mapDetect: (db) => {
      detects++;
      return mapRevision(db);
    },
    mapRepeat: (_ms, fn) => {
      tick = fn;
      return () => {
        tick = () => {};
      };
    },
  });
  t.after(() => created.app.close());
  const bearer = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const address = await created.app.listen({ port: 0, host: "127.0.0.1" });
  const sockets: ReturnType<typeof request>[] = [];
  t.after(() => {
    for (const req of sockets) req.destroy();
  });
  const open = () =>
    new Promise<void>((resolve, reject) => {
      const req = request(
        `${address}/api/map/stream`,
        { headers: { authorization: bearer } },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (/event: hello/.test(chunk)) resolve();
          });
        },
      );
      sockets.push(req);
      req.on("error", reject);
      req.end();
    });
  await Promise.all(Array.from({ length: 6 }, open));
  assert.equal(detects, 1, "六个连接连上时只快照一次");
  tick();
  tick();
  assert.equal(detects, 3);
});
