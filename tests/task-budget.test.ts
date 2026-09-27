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
  parseQuotaReservePercent,
  readQuotaReservePercent,
} from "../server/tasks/budget.ts";
import { chooseWorker } from "../server/tasks/worker-choice.ts";

test("章程预算：解析嵌套字段和注释；文件或字段缺失取默认，坏值拒绝", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const charter = join(dir, "charter.md");
  assert.equal(DEFAULT_QUOTA_RESERVE_PERCENT, 20);
  assert.equal(await readQuotaReservePercent(charter), 20);
  assert.equal(parseQuotaReservePercent("---\nstatus: 草稿\n---\n正文"), 20);
  writeFileSync(
    charter,
    "---\nbudget:\n  quota_reserve_percent: 25 # 给用户\n---\n正文",
  );
  assert.equal(await readQuotaReservePercent(charter), 25);
  for (const value of ["-1", "101", "NaN", ""])
    assert.throws(
      () =>
        parseQuotaReservePercent(
          `---\nbudget:\n  quota_reserve_percent: ${value}\n---\n`,
        ),
      /quota_reserve_percent/,
    );
});

test("指定执行者触及章程预算时拒绝并给出可选执行者；自动派活避开该账号", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-choice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const workersDir = join(dir, "workers");
  mkdirSync(bin);
  mkdirSync(workersDir);
  for (const name of ["grok", "kimi", "codex"]) {
    const file = join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const charterPath = join(dir, "charter.md");
  writeFileSync(
    charterPath,
    "---\nbudget:\n  quota_reserve_percent: 20\n---\n",
  );
  const options = {
    data: dir,
    workersDir,
    env: { PATH: bin },
    charterPath,
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
  writeFileSync(
    charterPath,
    "---\nbudget:\n  quota_reserve_percent: 10\n---\n",
  );
  assert.equal(
    (await chooseWorker({ worker: "grok" }, options)).worker.tool,
    "grok",
  );
});

test("组织章程导入后按任务节点的最严保留额挑人", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-org-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
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
  const workersDir = join(dir, "workers");
  mkdirSync(bin);
  mkdirSync(workersDir);
  for (const name of ["grok", "kimi"]) {
    const file = join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const charterPath = join(dir, "charter.md");
  writeFileSync(charterPath, "---\nbudget:\n  quota_reserve_percent: 0\n---\n");
  const options = {
    db,
    data: dir,
    workersDir,
    env: { PATH: bin },
    charterPath,
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
