import { profileDb } from "./profile-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import {
  DEFAULT_QUOTA_RESERVE_PERCENT,
  quotaReserve,
  readQuotaReservePercent,
} from "../server/tasks/budget.ts";
import { chooseWorker } from "../server/tasks/worker-choice.ts";

/** 只有根节点的组织树，根章程写上保留份额（不写就不给 boundaries）。 */
function rootWithReserve(reserve?: number) {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  if (reserve !== undefined) setRootReserve(db, root.id, reserve);
  return { db, root };
}
function setRootReserve(db: DatabaseSync, id: number, reserve: number) {
  editDoc(
    db,
    `o${id}`,
    "charter",
    {
      fields: {},
      body: "",
      boundaries: [
        {
          id: "quota-reserve",
          summary: "留给用户",
          param: { quota_reserve_percent: reserve },
        },
      ],
      reason: "改保留份额",
    },
    "u1",
  );
}

test("保留份额只读组织树：没有库、没有根、根章程没写都取缺省；写了就用根章程", (t) => {
  assert.equal(DEFAULT_QUOTA_RESERVE_PERCENT, 20);
  assert.deepEqual(quotaReserve(), { percent: 20, set_by: null });
  const empty = new DatabaseSync(":memory:");
  t.after(() => empty.close());
  assert.equal(readQuotaReservePercent(empty), 20);
  ensureOrgTables(empty);
  assert.equal(readQuotaReservePercent(empty), 20);
  const bare = rootWithReserve();
  t.after(() => bare.db.close());
  assert.deepEqual(quotaReserve(bare.db), { percent: 20, set_by: null });
  const set = rootWithReserve(25);
  t.after(() => set.db.close());
  assert.deepEqual(quotaReserve(set.db), {
    percent: 25,
    set_by: `o${set.root.id}`,
  });
});

test("指定执行者触及章程预算时拒绝并给出可选执行者；自动派活避开该账号", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-choice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["grok", "kimi", "codex"]) {
    const file = join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const options = {
    data: dir,
    env: { PATH: bin },
    pace: async () => [
      { providerId: "grok", usedPercent: 89, sparePercent: 90 },
      { providerId: "kimi", usedPercent: 12, sparePercent: 40 },
      { providerId: "codex", usedPercent: 80, sparePercent: 50 },
    ],
  };
  await assert.rejects(
    chooseWorker({ worker: "grok" }, options),
    /grok.*89%.*80%.*可选的其他执行者：kimi/,
  );
  assert.equal((await chooseWorker({}, options)).worker.tool, "kimi");
  // 根章程把保留份额放宽到 10%：89% 还能派。
  const { db } = rootWithReserve(10);
  t.after(() => db.close());
  assert.equal(
    (await chooseWorker({ worker: "grok" }, { ...options, db })).worker.tool,
    "grok",
  );
});

test("组织章程导入后按任务节点的最严保留额挑人", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-org-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = profileDb(undefined, new DatabaseSync(":memory:"));
  t.after(() => db.close());
  ensureOrgTables(db);
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  const project = addNode(
    db,
    {
      parent: `o${root.id}`,
      slug: "project",
      kind: "project",
      name: "项目",
      reason: "建项目",
    },
    "u1",
  );
  const boundary = (reserve: number) => [
    {
      id: "reserve",
      summary: "留给用户",
      param: { quota_reserve_percent: reserve },
    },
  ];
  editDoc(
    db,
    `o${root.id}`,
    "charter",
    { fields: {}, body: "", boundaries: boundary(20), reason: "导入" },
    "u1",
  );
  editDoc(
    db,
    `o${project.id}`,
    "charter",
    {
      fields: {},
      body: "",
      boundaries: [{ id: "reserve", param: { quota_reserve_percent: 30 } }],
      reason: "收紧",
    },
    "u1",
  );
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["grok", "kimi"]) {
    const file = join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const options = {
    db,
    data: dir,
    env: { PATH: bin },
    pace: async () => [
      { providerId: "grok", usedPercent: 75, sparePercent: 80 },
      { providerId: "kimi", usedPercent: 5, sparePercent: 20 },
    ],
  };
  assert.equal(
    (
      await chooseWorker({}, options, new Map(), {
        chain: [{ id: root.id, ref: `o${root.id}`, path: "" }],
      })
    ).worker.tool,
    "grok",
  );
  assert.equal(
    (
      await chooseWorker({}, options, new Map(), {
        chain: [
          { id: root.id, ref: `o${root.id}`, path: "" },
          { id: project.id, ref: `o${project.id}`, path: "project" },
        ],
      })
    ).worker.tool,
    "kimi",
  );
});
