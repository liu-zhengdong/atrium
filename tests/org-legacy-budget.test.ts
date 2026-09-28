import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  isLegacyBudget,
  liftLegacyBudget,
} from "../server/org/legacy-budget.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { ownBoundaries } from "../server/org/boundary-store.ts";
import { ownShares } from "../server/org/share-store.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import { parseDocument } from "../server/org/validate.ts";

test("旧写法判定：出现 quota_reserve_percent / disk_min_free_gb / money_yuan_max 才算", () => {
  assert.equal(isLegacyBudget({ quota_reserve_percent: 20 }), true);
  assert.equal(isLegacyBudget({ disk_min_free_gb: 15 }), true);
  assert.equal(isLegacyBudget({ money_yuan_max: 0 }), true);
  assert.equal(isLegacyBudget({ money: 0 }), false);
  assert.equal(isLegacyBudget({ quota: { "*": 10 }, disk: 5 }), false);
  assert.equal(isLegacyBudget(undefined), false);
  assert.equal(isLegacyBudget([1]), false);
});

test("旧写法折成边界参数：写了的更新或补上，磁盘下限丢掉，份额留在 budget", () => {
  const own = [
    { id: "no-spend", summary: "不花钱" },
    {
      id: "reserve",
      summary: "留给用户",
      param: { quota_reserve_percent: 30 },
    },
    { id: "disk-floor", summary: "本机磁盘", param: { disk_min_free_gb: 15 } },
  ];
  assert.deepEqual(
    liftLegacyBudget(
      { quota_reserve_percent: 20, money: 0, disk_min_free_gb: 15, disk: 8 },
      own,
    ),
    {
      budget: { disk: 8 },
      boundaries: [
        { id: "no-spend", summary: "不花钱" },
        {
          id: "reserve",
          summary: "留给用户",
          param: { quota_reserve_percent: 20 },
        },
        {
          id: "money",
          summary: "花费上限（元）",
          param: { money_yuan_max: 0 },
        },
      ],
    },
  );
  // 上层已有同 id：只写参数覆盖，文字沿用上层。
  assert.deepEqual(
    liftLegacyBudget(
      { quota_reserve_percent: 25 },
      [],
      new Set(["quota-reserve"]),
    ).boundaries,
    [{ id: "quota-reserve", param: { quota_reserve_percent: 25 } }],
  );
  // boundaries 写坏了：原样交给边界校验报错。
  assert.equal(
    liftLegacyBudget({ quota_reserve_percent: 20 }, "坏").boundaries,
    "坏",
  );
});

const setup = () => {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建" }, "u1");
  editDoc(
    db,
    "o1",
    "charter",
    {
      ...parseDocument(
        `---
goal: 组织目标
boundaries:
  - { id: no-spend, summary: 不花钱 }
  - { id: quota-reserve, summary: 每个订阅账号的周期额度留给用户, param: { quota_reserve_percent: 20 } }
  - { id: disk-floor, summary: 本机磁盘可用低于下限就暂停新任务, param: { disk_min_free_gb: 15 } }
  - { id: money, summary: 花费上限（元）, param: { money_yuan_max: 0 } }
---
正文
`,
        "charter",
      ),
      reason: "建",
    },
    "u1",
  );
  return db;
};

test("根章程用旧写法 budget 改得动：额度 20%、钱 0 保留，磁盘下限删掉，文字边界不动", () => {
  const db = setup();
  const result = editDoc(
    db,
    "o1",
    "charter",
    {
      ...parseDocument(
        `---
goal: 组织目标
budget:
  quota_reserve_percent: 20     # 每个订阅账号的周额度，至少留 20% 给用户本人
  money: 0                       # 不产生任何新花费
---
# 组织章程

> 来历：秘书 09-26 起草；用户 09-28 确认额度 20%、不花钱，删除磁盘下限。
`,
        "charter",
      ),
      reason: "改根章程",
    },
    "u1",
  );
  assert.equal(result.rev, "r2");
  assert.deepEqual(
    ownBoundaries(db, 1).map((e) => [e.id, e.param?.value ?? null]),
    [
      ["no-spend", null],
      ["quota-reserve", 20],
      ["money", 0],
    ],
  );
  assert.deepEqual(ownShares(db, 1), []);
});

test("旧写法的坏值照样拒绝，不写入", () => {
  const db = setup();
  assert.throws(
    () =>
      editDoc(
        db,
        "o1",
        "charter",
        {
          fields: { goal: "组织目标" },
          body: "",
          budget: { quota_reserve_percent: 150 },
          reason: "改",
        },
        "u1",
      ),
    /quota_reserve_percent.*0–100/,
  );
  assert.equal(ownBoundaries(db, 1).length, 4);
});
