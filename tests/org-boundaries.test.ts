import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  checkBoundaries,
  effective,
  exportBoundaries,
  looser,
  parseBoundaries,
  stricter,
  type Boundary,
  type Level,
  type SubNode,
} from "../server/org/boundaries.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc, editNode, revertDoc } from "../server/org/write.ts";
import { history, show } from "../server/org/read.ts";
import { exportDocument, parseDocument } from "../server/org/validate.ts";
import { formatBoundaries, formatOrgChanges } from "../cli/org.ts";

const text = (id: string, summary = `${id} 的要点`): Boundary => ({
  id,
  summary,
  detail: null,
  param: null,
});
const quota = (value: number, summary = ""): Boundary => ({
  id: "quota-reserve",
  summary,
  detail: null,
  param: { key: "quota_reserve_percent", value },
});
const money = (value: number, summary = ""): Boundary => ({
  id: "money",
  summary,
  detail: null,
  param: { key: "money_yuan_max", value },
});
const root: Level = {
  node: 1,
  name: "组织",
  entries: [text("no-spend"), quota(20, "额度留给用户"), money(0, "花费上限")],
};
const fields = (result: ReturnType<typeof checkBoundaries>) =>
  result.problems.map((p) => p.field);
const run = (
  proposed: Boundary[],
  options: {
    chain?: Level[];
    current?: Boundary[];
    subtree?: SubNode[];
    oldChain?: Level[];
  } = {},
) =>
  checkBoundaries({
    chain: options.chain ?? [root],
    ...(options.oldChain ? { oldChain: options.oldChain } : {}),
    node: { node: 2, name: "Atrium" },
    current: options.current ?? [],
    proposed,
    subtree: options.subtree ?? [],
  });

test("方向：quota/disk 越大越严，money 越小越严", () => {
  assert.equal(stricter("quota_reserve_percent", 20, 25), 25);
  assert.equal(stricter("disk_min_free_gb", 15, 10), 15);
  assert.equal(stricter("money_yuan_max", 0, 5), 0);
  assert.equal(looser("quota_reserve_percent", 10, 20), true);
  assert.equal(looser("quota_reserve_percent", 20, 20), false);
  assert.equal(looser("money_yuan_max", 1, 0), true);
  assert.equal(looser("money_yuan_max", 0, 0), false);
  assert.equal(looser("disk_min_free_gb", 30, 15), false);
});

test("生效链：追加、同 id 取最严、文字沿用最早出处", () => {
  const list = effective([
    root,
    { node: 2, name: "Atrium", entries: [text("no-4310"), quota(25)] },
    { node: 4, name: "runtime", entries: [quota(22), text("no-stash")] },
  ]);
  assert.deepEqual(
    list.map((e) => e.id),
    ["no-spend", "quota-reserve", "money", "no-4310", "no-stash"],
  );
  const q = list.find((e) => e.id === "quota-reserve")!;
  assert.equal(q.param!.value, 25);
  assert.equal(q.from, 1);
  assert.equal(q.set_by, 2);
  assert.equal(q.summary, "额度留给用户");
});

test("parseBoundaries 结构错误逐条报", () => {
  assert.deepEqual(parseBoundaries("x").problems, [
    { field: "boundaries", message: "应为条目列表" },
  ]);
  const bad = parseBoundaries([
    1,
    { id: 3 },
    { id: "a1", summary: 2, extra: true },
    { id: "a2", summary: "s", param: { quota_reserve_percent: 101 } },
    { id: "a3", summary: "s", param: { foo: 1 } },
    {
      id: "a4",
      summary: "s",
      param: { money_yuan_max: 0, disk_min_free_gb: 1 },
    },
    { id: "a5", summary: "s", param: { disk_min_free_gb: "15" } },
    { id: "a6", summary: "s", detail: [] },
  ]).problems.map((p) => p.field);
  assert.deepEqual(bad, [
    "boundaries[0]",
    "boundaries[1].id",
    "boundaries[2].extra",
    "boundaries.a1.summary",
    "boundaries.a2.param.quota_reserve_percent",
    "boundaries.a3.param",
    "boundaries.a4.param",
    "boundaries.a5.param.disk_min_free_gb",
    "boundaries.a6.detail",
  ]);
  assert.ok(
    parseBoundaries(Array.from({ length: 41 }, (_, i) => text(`b${i}`)))
      .problems.length,
  );
  const ok = parseBoundaries([
    { id: "no-stash", summary: " 不用 stash " },
    { id: "quota-reserve", param: { quota_reserve_percent: 25 } },
  ]);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.entries, [
    { id: "no-stash", summary: "不用 stash", detail: null, param: null },
    quota(25),
  ]);
  assert.deepEqual(exportBoundaries(ok.entries), [
    { id: "no-stash", summary: "不用 stash" },
    { id: "quota-reserve", param: { quota_reserve_percent: 25 } },
  ]);
});

test("B1：id 格式、唯一、长度、非覆盖条目要有 summary", () => {
  for (const id of ["No Spend", "1abc", "a", "x_y", "", "a".repeat(41)])
    assert.equal(run([text(id)]).problems.length, 1, id);
  assert.deepEqual(fields(run([text("ab"), text("ab")])), ["boundaries.ab"]);
  assert.deepEqual(fields(run([text("ab", "长".repeat(81))])), [
    "boundaries.ab.summary",
  ]);
  assert.deepEqual(fields(run([{ ...text("ab"), detail: "长".repeat(501) }])), [
    "boundaries.ab.detail",
  ]);
  assert.deepEqual(fields(run([text("ab", "")])), ["boundaries.ab.summary"]);
  assert.deepEqual(fields(run([text("ab", "长".repeat(80))])), []);
});

test("B2：文字条目不能同 id 重写，参数条目不能换参数", () => {
  assert.match(
    run([text("no-spend", "可以花一点")]).problems[0]!.message,
    /文字条目不能同 id 重写/,
  );
  assert.match(
    run([
      { ...text("no-spend", ""), param: { key: "money_yuan_max", value: 0 } },
    ]).problems[0]!.message,
    /文字条目/,
  );
  assert.match(
    run([text("quota-reserve", "")]).problems[0]!.message,
    /只能改参数 quota_reserve_percent/,
  );
  assert.match(
    run([
      {
        ...quota(30),
        param: { key: "disk_min_free_gb", value: 30 },
      },
    ]).problems[0]!.message,
    /只能改参数/,
  );
  // 覆盖条目不能改文字；写同样的文字可以
  assert.deepEqual(fields(run([quota(25, "随便写")])), [
    "boundaries.quota-reserve.summary",
  ]);
  assert.deepEqual(fields(run([quota(25, "额度留给用户")])), []);
});

test("B3：覆盖值只能收紧或相等", () => {
  const loose = run([quota(10)]);
  assert.deepEqual(fields(loose), ["boundaries.quota-reserve"]);
  assert.equal(
    loose.problems[0]!.message,
    "只能收紧，上层 o1 要求至少 20%，这里写的是 10%",
  );
  assert.deepEqual(fields(run([quota(20)])), []);
  assert.deepEqual(fields(run([quota(25)])), []);
  assert.deepEqual(fields(run([money(1)])), ["boundaries.money"]);
  assert.deepEqual(fields(run([money(0)])), []);
  // 以链上最严值为准：中间层收到 30 后，下层写 25 被拒
  const mid: Level = { node: 2, name: "Atrium", entries: [quota(30)] };
  const deeper = checkBoundaries({
    chain: [root, mid],
    node: { node: 4, name: "runtime" },
    current: [],
    proposed: [quota(25)],
    subtree: [],
    label: (n) => (n === 2 ? "o2 Atrium" : `o${n}`),
  });
  assert.match(deeper.problems[0]!.message, /上层 o2 Atrium 要求至少 30%/);
  // 上层后来收紧：本节点未改动的旧值不再拦，改动其他条目照常通过
  assert.deepEqual(
    fields(
      checkBoundaries({
        chain: [root, mid],
        node: { node: 4, name: "runtime" },
        current: [quota(25)],
        proposed: [quota(25), text("no-stash")],
        subtree: [],
      }),
    ),
    [],
  );
  // 但把旧值继续放宽仍被拒
  assert.equal(
    checkBoundaries({
      chain: [root, mid],
      node: { node: 4, name: "runtime" },
      current: [quota(25)],
      proposed: [quota(22)],
      subtree: [],
    }).problems.length,
    1,
  );
});

test("B4：新增 id 不得与后代已有的非覆盖条目重名", () => {
  const subtree: SubNode[] = [
    { node: 4, parent: 2, name: "runtime", entries: [text("no-4310")] },
    {
      node: 5,
      parent: 4,
      name: "deep",
      entries: [
        {
          id: "disk-floor",
          summary: "磁盘",
          detail: null,
          param: { key: "disk_min_free_gb", value: 30 },
        },
      ],
    },
  ];
  const clash = run([text("no-4310")], { subtree });
  assert.deepEqual(fields(clash), ["boundaries.no-4310"]);
  assert.match(clash.problems[0]!.message, /后代 o4 已有同名条目/);
  // 参数条目也算：否则后代条目会被误判成覆盖
  assert.deepEqual(
    fields(
      run(
        [
          {
            id: "disk-floor",
            summary: "磁盘下限",
            detail: null,
            param: { key: "disk_min_free_gb", value: 15 },
          },
        ],
        { subtree },
      ),
    ),
    ["boundaries.disk-floor"],
  );
  // 后代的覆盖条目不算冲突：本节点已有该 id 时调整参数
  const own = [text("x-own"), quota(25)];
  const overriding: SubNode[] = [
    { node: 4, parent: 2, name: "runtime", entries: [quota(30)] },
  ];
  assert.deepEqual(
    fields(
      run([text("x-own"), quota(28)], { current: own, subtree: overriding }),
    ),
    [],
  );
  // 把后代覆盖的参数条目改成文字条目会让后代失效
  assert.match(
    run([text("x-own"), text("quota-reserve", "改成文字")], {
      chain: [{ ...root, entries: [text("no-spend")] }],
      current: [text("x-own"), quota(25, "额度")],
      subtree: overriding,
    }).problems[0]!.message,
    /后代 o4 以参数覆盖此条/,
  );
});

test("B5：整条链 summary 合计 ≤ 1200，含后代", () => {
  const long = (i: number) => text(`long-${i}`, "字".repeat(80));
  const fourteen = Array.from({ length: 14 }, (_, i) => long(i));
  // 根 3 条：no-spend 的要点（12）+ 额度留给用户（6）+ 花费上限（4）= 22 字
  assert.deepEqual(fields(run(fourteen)), []); // 22 + 1120
  const over = run([...fourteen, text("tail", "字".repeat(60))]); // 22 + 1180 = 1202
  assert.deepEqual(fields(over), ["boundaries"]);
  assert.match(over.problems[0]!.message, /合计 1202 字，超过 1200/);
  const child = run(fourteen, {
    subtree: [
      {
        node: 4,
        parent: 2,
        name: "runtime",
        entries: [text("tail", "字".repeat(60))],
      },
    ],
  });
  assert.match(
    child.problems[0]!.message,
    /后代 o4 的整条链 summary 合计将为 1202/,
  );
});

test("B6：删除本节点条目，后代同 id 覆盖转为自有条目", () => {
  const current = [
    text("x-own"),
    { ...quota(25), id: "own-quota", summary: "本项目额度" },
  ];
  const subtree: SubNode[] = [
    {
      node: 4,
      parent: 2,
      name: "runtime",
      entries: [{ ...quota(30), id: "own-quota" }, text("no-stash")],
    },
    {
      node: 5,
      parent: 4,
      name: "deep",
      entries: [{ ...quota(35), id: "own-quota" }],
    },
  ];
  const result = run([text("x-own")], { current, subtree });
  assert.deepEqual(result.problems, []);
  // 只有直接失去上层的那一层转换；更深的仍覆盖 o4 的条目
  assert.deepEqual(result.converted, [
    { node: 4, id: "own-quota", summary: "本项目额度" },
  ]);
  // 删除只作用于本节点：上层条目仍在，后代覆盖不受影响
  assert.deepEqual(
    run([], {
      current: [quota(25)],
      subtree: [{ node: 4, parent: 2, name: "r", entries: [quota(30)] }],
    }).converted,
    [],
  );
});

test("移动：新上层同名冲突被拒，失去的覆盖转为自有条目", () => {
  const other: Level = {
    node: 3,
    name: "OpenQuota",
    entries: [text("no-4310")],
  };
  const oldChain = [root, { node: 2, name: "Atrium", entries: [text("keep")] }];
  const moved = checkBoundaries({
    chain: [root, other],
    oldChain,
    node: { node: 4, name: "runtime" },
    current: [text("no-4310", "别的意思")],
    proposed: [text("no-4310", "别的意思")],
    subtree: [],
  });
  assert.match(moved.problems[0]!.message, /移动后与上层 o3 的同名条目冲突/);
  const ownOverride = [{ ...quota(30), id: "atrium-quota" }];
  const withOverride = checkBoundaries({
    chain: [root, other],
    oldChain: [
      root,
      {
        node: 2,
        name: "Atrium",
        entries: [{ ...quota(25), id: "atrium-quota", summary: "Atrium 额度" }],
      },
    ],
    node: { node: 4, name: "runtime" },
    current: ownOverride,
    proposed: ownOverride,
    subtree: [],
  });
  assert.deepEqual(withOverride.problems, []);
  assert.deepEqual(withOverride.converted, [
    { node: 4, id: "atrium-quota", summary: "Atrium 额度" },
  ]);
  // 搬到更严的上层下：旧值已被覆盖，不拦
  assert.deepEqual(
    checkBoundaries({
      chain: [root, { node: 3, name: "OQ", entries: [quota(40)] }],
      oldChain: [root],
      node: { node: 4, name: "runtime" },
      current: [quota(25)],
      proposed: [quota(25)],
      subtree: [],
    }).problems,
    [],
  );
});

// —— 第 2.3 节例子逐条复现（数据库 + 命令行格式） ——

const rootDoc = `---
goal: "组织目标"
boundaries:
  - { id: no-spend,        summary: 不花钱：不买订阅、不开付费服务、不产生新账单 }
  - { id: no-impersonate,  summary: 不以用户名义在他人的仓库、社区、邮件、社交平台发言；fork 仓库 gh 一律带 -R }
  - { id: personal-data,   summary: 用户个人配置与文件只读，不改不删不外传 }
  - { id: no-secret-leak,  summary: 凭据不进日志、截图、提交、PR、issue 或外部服务 }
  - { id: no-visibility,   summary: 不改仓库可见性，不公开私有数据 }
  - { id: reversible,      summary: 迁移或删除在用数据前先备份并能回滚 }
  - { id: quota-reserve,   summary: 每个订阅账号周期额度至少留给用户, param: { quota_reserve_percent: 20 } }
  - { id: disk-floor,      summary: 磁盘可用低于下限就暂停新任务, param: { disk_min_free_gb: 15 } }
  - { id: money,           summary: 花费上限（元）, param: { money_yuan_max: 0 } }
---
根章程正文
`;
const setup = () => {
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建" }, "u1");
  addNode(
    db,
    {
      parent: "o1",
      slug: "atrium",
      kind: "project",
      name: "Atrium",
      leader: "a1",
      reason: "建",
    },
    "u1",
  );
  addNode(
    db,
    {
      parent: "o1",
      slug: "openquota",
      kind: "project",
      name: "OpenQuota",
      leader: "a1",
      reason: "建",
    },
    "u1",
  );
  addNode(
    db,
    {
      parent: "o2",
      slug: "runtime",
      kind: "module",
      name: "runtime",
      reason: "建",
    },
    "a1",
  );
  return db;
};
const put = (
  db: DatabaseSync,
  node: string,
  source: string,
  actor = "u1",
  reason = "改",
) =>
  editDoc(
    db,
    node,
    "charter",
    { ...parseDocument(source, "charter"), reason },
    actor,
  );
const doc = (lines: string[]) =>
  `---\nboundaries:\n${lines.map((l) => `  - ${l}`).join("\n")}\n---\n`;
type Shown = Parameters<typeof formatBoundaries>[0];

test("2.3 例子：放宽被拒、收紧通过、上层后收紧标覆盖、后代同名被拒", () => {
  const db = setup();
  put(db, "o1", rootDoc);
  put(
    db,
    "atrium",
    doc([
      "{ id: no-4310, summary: 不启停、不更新 4310 上的安装版服务，atrium 命令必须带隔离端口与数据目录 }",
    ]),
    "a1",
  );
  // runtime 加 no-stash 并把保留收紧到 25 ✅
  const runtimeDoc = doc([
    "{ id: no-stash, summary: 不用 git stash }",
    "{ id: quota-reserve, param: { quota_reserve_percent: 25 } }",
  ]);
  const ok = put(db, "atrium/runtime", runtimeDoc, "a1", "收紧额度");
  assert.equal(ok.rev, "r1");
  // OpenQuota 放宽到 10 被拒，报错与设计一致
  assert.throws(
    () =>
      put(
        db,
        "openquota",
        doc(["{ id: quota-reserve, param: { quota_reserve_percent: 10 } }"]),
        "a1",
        "放宽额度",
      ),
    (error: Error & { nextCommand?: string }) => {
      assert.equal(
        error.message,
        "拒绝修改 o3 OpenQuota 的章程：\n- boundaries.quota-reserve：只能收紧，上层 o1 组织 要求至少 20%，这里写的是 10%",
      );
      assert.equal(error.nextCommand, "atrium org show o3 --charter --raw");
      return true;
    },
  );
  // 被拒不写入：章程仍是 r0
  assert.equal((show(db, "o3") as { charter: unknown }).charter, null);
  // 文字条目重写被拒
  assert.throws(
    () =>
      put(
        db,
        "atrium/runtime",
        doc(["{ id: no-impersonate, summary: 可以在上游仓库评论 }"]),
        "a1",
      ),
    /boundaries.no-impersonate：上层 o1 组织 的文字条目不能同 id 重写/,
  );

  // runtime 生效：9 + 1 (Atrium) + 1 (no-stash)，额度 25 由本节点收紧
  let view = (show(db, "o4") as { boundaries: Shown }).boundaries;
  assert.equal(view.inherited, 10);
  assert.equal(view.added, 1);
  const q = view.items.find((e) => e.id === "quota-reserve")!;
  assert.equal(q.param!.value, 25);
  assert.equal(q.set_by, "o4");
  assert.match(
    formatBoundaries(view).join("\n"),
    /至少 25%（o4 runtime 收紧） · o1 组织/,
  );

  // 上层后收紧到 30：不查后代，runtime 的 25 标「已被上层覆盖」
  put(
    db,
    "o1",
    rootDoc.replace("quota_reserve_percent: 20", "quota_reserve_percent: 30"),
    "u1",
    "上层收紧",
  );
  view = (show(db, "o4") as { boundaries: Shown }).boundaries;
  assert.equal(
    view.items.find((e) => e.id === "quota-reserve")!.param!.value,
    30,
  );
  const text = formatBoundaries(view).join("\n");
  assert.match(
    text,
    /本节点 quota-reserve 写的至少 25% 已被上层覆盖：o1 组织 要求至少 30%/,
  );
  // runtime 仍能改自己的其他条目
  put(
    db,
    "o4",
    runtimeDoc.replace("不用 git stash", "不用 git stash，改用 WIP 提交"),
    "a1",
  );

  // 根新增 no-4310，而 Atrium 已有自己的 no-4310：被拒
  assert.throws(
    () =>
      put(
        db,
        "o1",
        rootDoc.replace(
          "---\n根章程",
          "  - { id: no-4310, summary: 不动 4310 }\n---\n根章程",
        ),
      ),
    /boundaries.no-4310：后代 o2 Atrium 已有同名条目/,
  );
});

test("章程往返、修订快照含边界、B6 转换写后代修订、回退与移动都过校验", () => {
  const db = setup();
  put(db, "o1", rootDoc);
  put(
    db,
    "o2",
    doc([
      "{ id: atrium-quota, summary: Atrium 额度, param: { quota_reserve_percent: 25 } }",
      "{ id: no-4310, summary: 不动 4310 }",
    ]),
    "a1",
  );
  put(
    db,
    "o4",
    doc(["{ id: atrium-quota, param: { quota_reserve_percent: 30 } }"]),
    "a1",
  );
  // 导出再写回：不变
  const raw = (show(db, "o4", "charter") as { raw: string }).raw;
  assert.match(
    raw,
    /boundaries:\n {2}- id: atrium-quota\n {4}param:\n {6}quota_reserve_percent: 30/,
  );
  const again = put(db, "o4", raw, "a1", "往返");
  assert.deepEqual(again.boundaries, [
    { id: "atrium-quota", param: { quota_reserve_percent: 30 } },
  ]);
  // 覆盖条目写上与上层相同的文字：不重复存
  const same = put(
    db,
    "o4",
    doc([
      "{ id: atrium-quota, summary: Atrium 额度, param: { quota_reserve_percent: 30 } }",
    ]),
    "a1",
  );
  assert.deepEqual(same.boundaries, [
    { id: "atrium-quota", param: { quota_reserve_percent: 30 } },
  ]);
  // 不写 boundaries 键：保留原有条目
  put(db, "o4", '---\ngoal: "派活闭环"\n---\n', "a1");
  assert.equal(
    (show(db, "o4") as { boundaries: Shown }).boundaries.own.length,
    1,
  );
  // card 不收边界
  assert.throws(
    () =>
      editDoc(
        db,
        "o4",
        "card",
        { fields: {}, body: "", boundaries: [], reason: "x" },
        "a1",
      ),
    /card.boundaries 是未知字段/,
  );
  assert.throws(
    () => parseDocument("---\nboundaries: []\n---\n", "card"),
    /card.boundaries 是未知字段/,
  );

  // B6：Atrium 删除 atrium-quota，runtime 的覆盖转为自有条目并补上文字
  const removed = put(
    db,
    "o2",
    doc(["{ id: no-4310, summary: 不动 4310 }"]),
    "a1",
    "拆分额度",
  );
  assert.deepEqual(removed.converted, [{ node: "o4", id: "atrium-quota" }]);
  const runtime = show(db, "o4") as {
    boundaries: Shown;
    charter: { rev: string };
  };
  const own = runtime.boundaries.items.find((e) => e.id === "atrium-quota")!;
  assert.equal(own.summary, "Atrium 额度");
  assert.equal(own.from, "o4");
  const last = history(db, "o4", { target: "charter", limit: 1 }) as {
    items: {
      reason: string;
      author: string;
      snapshot: { boundaries: unknown };
    }[];
  };
  assert.match(
    last.items[0]!.reason,
    /因 o2 Atrium 的修改，atrium-quota 转为本节点自有条目：拆分额度/,
  );
  assert.deepEqual(last.items[0]!.snapshot.boundaries, [
    {
      id: "atrium-quota",
      summary: "Atrium 额度",
      param: { quota_reserve_percent: 30 },
    },
  ]);

  // 修订差异按条目列出
  const diff = history(db, "o2", { target: "charter", rev: "r2" }) as {
    changes: Record<string, { before: unknown; after: unknown }>;
  };
  assert.deepEqual(Object.keys(diff.changes), ["boundaries.atrium-quota"]);
  assert.equal(
    formatOrgChanges(diff.changes as never),
    "boundaries.atrium-quota：Atrium 额度 quota_reserve_percent=25→ （空）",
  );

  // 回退也过校验：o1 收紧到 30 后，把 o3 回退到放宽版本被拒
  put(
    db,
    "o3",
    doc(["{ id: quota-reserve, param: { quota_reserve_percent: 25 } }"]),
    "a1",
  );
  put(
    db,
    "o3",
    doc(["{ id: quota-reserve, param: { quota_reserve_percent: 35 } }"]),
    "a1",
  );
  put(
    db,
    "o1",
    rootDoc.replace("quota_reserve_percent: 20", "quota_reserve_percent: 30"),
  );
  assert.throws(
    () => revertDoc(db, "o3", "charter", "r1", "回退", "a1"),
    /只能收紧/,
  );
  // 第 2 步之前的旧修订没有 boundaries：回退视为当时没有边界
  addNode(
    db,
    { parent: "o2", slug: "cli", kind: "module", name: "cli", reason: "建" },
    "a1",
  );
  db.prepare(
    "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(5,'charter',1,'{}','旧',?,0)",
  ).run("a1");
  db.prepare(
    "INSERT INTO org_revisions(node_id,target,rev,author,at,reason,snapshot) VALUES(5,'charter',1,'a1',0,'旧版',?)",
  ).run(JSON.stringify({ fields: {}, body: "旧" }));
  put(db, "o5", doc(["{ id: no-stash, summary: 不用 stash }"]), "a1");
  const cleared = revertDoc(db, "o5", "charter", "r1", "回退", "a1") as {
    rev: string;
    boundaries: unknown[];
  };
  assert.equal(cleared.rev, "r3");
  assert.deepEqual(cleared.boundaries, []);
});

test("移动节点：新上层同名条目冲突被拒，合法移动写回执", () => {
  const db = setup();
  put(db, "o1", rootDoc);
  put(
    db,
    "o3",
    doc(["{ id: no-4310, summary: OpenQuota 的 4310 约定 }"]),
    "a1",
  );
  put(db, "o4", doc(["{ id: no-4310, summary: runtime 的 4310 约定 }"]), "a1");
  assert.throws(
    () => editNode(db, "o4", { parent: "o3", reason: "搬家" }, "a1"),
    /拒绝修改 o4 runtime 的位置：\n- boundaries.no-4310：移动后与上层 o3 OpenQuota 的同名条目冲突/,
  );
  put(db, "o4", doc(["{ id: no-stash, summary: 不用 stash }"]), "a1");
  const moved = editNode(db, "o4", { parent: "o3", reason: "搬家" }, "a1");
  assert.equal(moved.parent_id, 3);
});

test("exportDocument：无边界的章程也写出空列表，能再解析", () => {
  const out = exportDocument({ goal: "g" }, "正文", []);
  assert.equal(out, '---\ngoal: "g"\nboundaries: []\n---\n正文');
  assert.deepEqual(parseDocument(out, "charter"), {
    fields: { goal: "g" },
    body: "正文",
    boundaries: [],
  });
});
