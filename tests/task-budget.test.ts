import { profileDb } from "./profile-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { writeLimits } from "../server/org/limits.ts";
import {
  DEFAULT_QUOTA_RESERVE_PERCENT,
  quotaReserve,
  readQuotaReservePercent,
} from "../server/tasks/budget.ts";
import { chooseWorker } from "../server/tasks/worker-choice.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { removeTemp } from "./temp-dir.ts";

/** 只有根节点的组织树（带空档案表），根节点配置写上保留份额（不写就不设）。 */
function rootWithReserve(reserve?: number) {
  const db = profileDb();
  ensureOrgTables(db);
  const root = addNode(
    db,
    { slug: "org", kind: "org", name: "组织", reason: "建树" },
    "u1",
  );
  if (reserve !== undefined) setRootReserve(db, root.id, reserve);
  return { db, root };
}
function setRootReserve(db: DatabaseSync, _id: number, reserve: number) {
  writeLimits(db, { quota_reserve_percent: reserve }, "u1");
}

test("保留份额只读组织树：没有库、没有根、根节点没设都取缺省；设了就用它", (t) => {
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

test("指定执行者触及保留额时拒绝并给出可选执行者；自动派活避开该账号", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-choice-"));
  t.after(() => removeTemp(dir));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["grok", "kimi", "codex"]) {
    writeFakeBin(join(bin, name), "#!/bin/sh\nexit 0\n");
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
  // 根节点把保留份额放宽到 10%：89% 还能派。
  const { db } = rootWithReserve(10);
  t.after(() => db.close());
  assert.equal(
    (await chooseWorker({ worker: "grok" }, { ...options, db })).worker.tool,
    "grok",
  );
});
