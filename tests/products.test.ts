import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { addNode } from "../server/org/write.ts";
import { editMap } from "../server/map/write.ts";
import { leaderRule, denyReason } from "../server/leaders/scope.ts";
import { memoProblem } from "../server/memos/store.ts";
import {
  CHOICE_FILE,
  everyHuman,
  leaderMemo,
  productFields,
  researchBrief,
  type ResearchFacts,
} from "../server/products/brief.ts";
import { productSlug } from "../server/products/model.ts";
import { parseChoiceFile } from "../server/products/settle.ts";
import { DAY, HOUR, MINUTE } from "../server/schedules/plan.ts";
import { OVERVIEW_LISTS, OVERVIEW_TEXT } from "../server/org/overview.ts";
import { fixture, until } from "./task-fixture.ts";

const utc8 = () => 480;

test("周期的人话：每周、每天、每 N 天 / 小时 / 分钟", () => {
  assert.equal(everyHuman(7 * DAY), "每周");
  assert.equal(everyHuman(DAY), "每天");
  assert.equal(everyHuman(3 * DAY), "每 3 天");
  assert.equal(everyHuman(14 * DAY), "每 14 天");
  assert.equal(everyHuman(12 * HOUR), "每 12 小时");
  assert.equal(everyHuman(90 * MINUTE), "每 90 分钟");
});

test("产品部路径名：product 占了依次往后", () => {
  assert.equal(productSlug(new Set()), "product");
  assert.equal(productSlug(new Set(["cli", "web"])), "product");
  assert.equal(productSlug(new Set(["product"])), "product-2");
  assert.equal(
    productSlug(new Set(["product", "product-2", "product-3"])),
    "product-4",
  );
  assert.equal(productSlug(new Set(["product-2"])), "product");
});

const names = (parent: string, alias = "") => ({
  parent: { ref: "o2", name: parent, alias },
  product: { ref: "o7", name: "产品部" },
  leader: "a3",
  schedule: "s4",
  every_ms: 7 * DAY,
});

test("人话字段与 leader 备忘：管父节点的演进，只调研不立项；长名字也不超上限", () => {
  const fields = productFields(names("Atrium", "让一群 AI 替你干活"));
  assert.equal(fields.alias, "让一群 AI 替你干活的产品部");
  assert.match(fields.what, /^管「让一群 AI 替你干活」的演进：每周调研一次/);
  assert.match(fields.what, /不自己立项、不写代码/);
  assert.equal(fields.flow.length, 4);
  assert.match(fields.flow[3]!, /没选的记成决定记录/);
  // 没有人话名用名称。
  assert.equal(productFields(names("OpenQuota")).alias, "OpenQuota 的产品部");
  assert.equal(productFields(names("运行时")).alias, "运行时的产品部");
  const long = productFields(names("长".repeat(400)));
  assert.equal(Array.from(long.alias).length, OVERVIEW_TEXT.alias);
  assert.ok(Array.from(long.what).length <= OVERVIEW_TEXT.what!);
  assert.ok(Array.from(long.analogy).length <= OVERVIEW_TEXT.analogy!);
  assert.ok(long.flow.length <= OVERVIEW_LISTS.flow!);
  for (const step of long.flow) assert.ok(Array.from(step).length <= 300);
  for (const parent of ["Atrium", "长".repeat(400)]) {
    const memo = leaderMemo(names(parent));
    assert.equal(memoProblem(memo), null, memo);
    assert.match(memo, /s4/);
    assert.match(memo, /atrium choice add o2 --file 文件 --task tN/);
    assert.match(memo, /不立项/);
  }
});

const facts = (over: Partial<ResearchFacts> = {}): ResearchFacts => ({
  names: {
    parent: { ref: "o2", name: "Atrium", alias: "" },
    product: { ref: "o7", name: "产品部" },
  },
  date: "09-28",
  overview: { what: "", uses: [], flow: [], now: "", next: "" },
  parts: [],
  choices: [],
  decisions: [],
  findings: [],
  setbacks: [],
  shipped: [],
  ...over,
});

test("研究模板：交付格式与规矩在前，材料在后；空的一节写（没有）", () => {
  const empty = researchBrief(facts());
  assert.match(empty, /你是「Atrium」（o2）的产品部（o7）/);
  assert.match(empty, /不写代码、不改仓库、不开 PR、不建任务/);
  assert.match(empty, new RegExp(`在当前工作目录写 ${CHOICE_FILE}`));
  assert.match(empty, /"title": "Atrium 下一步（09-28）"/);
  assert.match(empty, /options 写 3–5 个/);
  assert.match(empty, /可以上网查同类产品/);
  assert.match(empty, /情况没变不要再提/);
  assert.ok(empty.indexOf("## 交付") < empty.indexOf("## 材料"));
  // 六节材料都在，空的写（没有）。
  for (const title of [
    "「Atrium」全景",
    "最近的选项单",
    "决定记录",
    "近期巡检发现",
    "失败与被打回的任务",
    "近期完成与上线",
  ])
    assert.match(empty, new RegExp(`### ${title}[^\\n]*\\n（没有）`));

  const full = researchBrief(
    facts({
      names: {
        parent: { ref: "o2", name: "Atrium", alias: "AI 组织" },
        product: { ref: "o7", name: "产品部" },
      },
      overview: {
        what: "让 AI 替你干活",
        uses: ["派活", "看全景"],
        flow: ["说目标", "拆任务"],
        now: "能派活",
        next: "做产品部",
      },
      parts: ["命令行（CLI）", "网页"],
      choices: [
        {
          ref: "c2",
          title: "下一步",
          status_text: "已拍板",
          open: false,
          picked: ["看板过滤"],
          skipped: ["合入提速"],
          note: "等 CI 稳了",
        },
        {
          ref: "c3",
          title: "再下一步",
          status_text: "等拍板",
          open: true,
          picked: [],
          skipped: [],
          note: null,
        },
      ],
      decisions: ["d4 09-27 u1 定：这轮不做「合入提速」——等 CI 稳了"],
      findings: [
        { ref: "f3", phenomenon: "帮助太长", kind: "awkward", status: "new" },
        { ref: "f4", phenomenon: "崩了", kind: "broken", status: "task" },
      ],
      setbacks: [
        { ref: "t9", title: "修测试", what: "失败", why: "超时" },
        { ref: "t10", title: "改网页", what: "卡住", why: null },
      ],
      shipped: [{ ref: "t12", title: "选项单", what: "已上线 v0.1.121" }],
    }),
  );
  assert.match(full, /你是「AI 组织」（o2）的产品部/);
  assert.match(full, /是什么：让 AI 替你干活/);
  assert.match(full, /能用它做什么：\n- 派活\n- 看全景/);
  assert.match(full, /一件事怎么走完：\n1\. 说目标\n2\. 拆任务/);
  assert.match(full, /由哪几部分组成：命令行（CLI）、网页/);
  assert.match(full, /现在做到哪：能派活\n接下来：做产品部/);
  assert.match(
    full,
    /- c2 下一步 · 已拍板；选了「看板过滤」；没选「合入提速」；说明：等 CI 稳了/,
  );
  assert.match(full, /- c3 再下一步 · 还在等用户拍板，里面的方向不要重复\n/);
  assert.match(full, /- d4 09-27 u1 定：这轮不做「合入提速」/);
  assert.match(full, /- f3 \[别扭\] 帮助太长（待处理）/);
  assert.match(full, /- f4 \[坏了\] 崩了（已建任务）/);
  assert.match(full, /- t9 修测试 · 失败：超时/);
  assert.match(full, /- t10 改网页 · 卡住\n/);
  assert.match(full, /- t12 选项单 · 已上线 v0\.1\.121/);
  assert.doesNotMatch(full, /（没有）/);
});

test("选项单文件：没写、空、坏 JSON 报清楚，BOM 与空白不挡", () => {
  assert.deepEqual(parseChoiceFile(null), {
    ok: false,
    error: `研究者没有在工作目录写 ${CHOICE_FILE}`,
  });
  assert.deepEqual(parseChoiceFile(" \n"), {
    ok: false,
    error: `${CHOICE_FILE} 是空的`,
  });
  assert.deepEqual(parseChoiceFile("{title"), {
    ok: false,
    error: `${CHOICE_FILE} 不是合法的 JSON`,
  });
  assert.deepEqual(parseChoiceFile('﻿ {"title":"x"}\n'), {
    ok: true,
    value: { title: "x" },
  });
});

test("leader 不能成立产品部，只能看", () => {
  assert.equal(leaderRule("POST", "/api/products"), "deny");
  assert.equal(leaderRule("GET", "/api/products"), "read");
  assert.match(denyReason("a2", "POST", "/api/products"), /成立产品部/);
});

// ---- 集成 ----

const option = (n: number) => ({
  title: `方向 ${n}`,
  gain: "能多做到一件事",
  why_now: "现在正好",
  cost: "两件活",
  skip: "会慢",
  basis: ["f1"],
});
const sheet = JSON.stringify({
  title: "Atrium 下一步",
  options: [option(1), option(2), option(3)],
  recommend: [1],
  why: "先做 1",
});

test("隔离服务：product add 一次建好部分、leader 与周期研究；研究按模板取材料，完成后把 choice.json 登记成选项单叫醒秘书；带旧表启动", async (t) => {
  const fx = fixture(t);
  const data = join(fx.root, "product-data");
  mkdirSync(data);
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(
    "CREATE TABLE IF NOT EXISTS pi_identities (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO pi_identities VALUES (1,'legacy')",
  );
  legacy.close();
  // 假研究者：在工作目录写选项单。
  fx.script(
    "opencode",
    `cat > ${CHOICE_FILE} <<'JSON'\n${sheet}\nJSON\necho '{"type":"text","part":{"text":"提了三个方向"}}'`,
  );
  const start = Date.now();
  const { app, db } = await createApp({
    data,
    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      pace: async () => undefined,
      usagePace: async () => undefined,
      diskFreeGb: async () => 1000,
      tickMs: 100,
    },
    schedules: { tickMs: 50, now: () => start, offset: utc8 },
  });
  t.after(() => app.close());
  const call = async (
    method: "GET" | "POST" | "PATCH",
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
  const count = (sql: string, ...args: (string | number)[]) =>
    (db.prepare(sql).get(...args) as { n: number }).n;
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建" }, "u1");
  addNode(
    db,
    {
      parent: "o1",
      slug: "atrium",
      kind: "project",
      name: "Atrium",
      reason: "建",
    },
    "u1",
  );
  addNode(
    db,
    { parent: "o1", slug: "oq", kind: "project", name: "OQ", reason: "建" },
    "u1",
  );
  addNode(
    db,
    { parent: "o2", slug: "cli", kind: "module", name: "命令行", reason: "建" },
    "u1",
  );
  editMap(
    db,
    "o2",
    {
      what: "让 AI 替你干活",
      uses: ["派活"],
      now: "能派活",
      alias: "AI 组织",
    },
    "u1",
  );
  editMap(db, "o4", { alias: "终端里用" }, "u1");
  assert.equal(
    (
      await call("POST", "/api/leaders", {
        name: "Atrium 负责人",
        worker: "opencode",
      })
    ).status,
    201,
  );
  assert.equal(
    (await call("PATCH", "/api/org/nodes/o2", { leader: "a1", reason: "负责" }))
      .status,
    200,
  );

  // 校验：出错整条回滚，不留节点、leader、周期任务。
  const nodesBefore = count("SELECT count(*) n FROM org_nodes");
  for (const [payload, status, pattern] of [
    [{}, 400, /节点: 必填/],
    [{ node: "o9" }, 404, /不存在/],
    [{ node: "o2", every: "30m" }, 400, /--every/],
    [{ node: "o2", at: "25:00" }, 400, /--at/],
    [{ node: "o2", worker: "nope+x" }, 400, /worker/],
    [{ node: "o2", color: "red" }, 400, /color: 是未知字段/],
    // OQ 和上级都没有登记的 leader：要 --worker。
    [{ node: "o3" }, 400, /--worker: 必填/],
  ] as const) {
    const bad = await call("POST", "/api/products", payload);
    assert.equal(bad.status, status, JSON.stringify(bad.body));
    assert.match(bad.body.error, pattern);
  }
  assert.equal(count("SELECT count(*) n FROM org_nodes"), nodesBefore);
  assert.equal(count("SELECT count(*) n FROM org_leaders"), 1);
  assert.equal(count("SELECT count(*) n FROM schedules"), 0);
  assert.equal(count("SELECT count(*) n FROM products"), 0);
  assert.equal(count("SELECT count(*) n FROM tasks"), 0);

  // 材料：一条挂在命令行上的决定、一条巡检发现、一件失败的任务、一件完成的任务。
  assert.equal(
    (
      await call("POST", "/api/decisions?as=a1", {
        text: "这轮不做「合入提速」",
        why: "等 CI 稳了",
        node: "o4",
      })
    ).status,
    201,
  );
  const failedTask = (
    await call("POST", "/api/tasks", { title: "修测试", part: "o4" })
  ).body;
  db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(failedTask.id);
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,'exit_fail',?)",
  ).run(failedTask.id, Date.now(), JSON.stringify({ reason: "测试超时" }));
  const doneTask = (
    await call("POST", "/api/tasks", { title: "选项单上线", part: "o2" })
  ).body;
  db.prepare(
    "UPDATE tasks SET status='done',delivery_stage='online',release_version='0.1.121' WHERE id=?",
  ).run(doneTask.id);
  db.prepare(
    "INSERT INTO patrol_findings(node_id,task_id,fingerprint,phenomenon,step,command,expected,actual,kind,status,created_at,updated_at) VALUES (4,?,'fp','帮助太长','看帮助','atrium --help','短','长','awkward','new',?,?)",
  ).run(failedTask.id, Date.now(), Date.now());

  const made = await call("POST", "/api/products", {
    node: "atrium",
    at: "09:30",
    worker: "opencode",
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.node, "o5");
  assert.equal(made.body.name, "产品部");
  assert.equal(made.body.parent, "o2");
  assert.equal(made.body.leader, "a2");
  assert.equal(made.body.schedule, "s1");
  assert.equal(made.body.every, "7d");
  assert.equal(made.body.schedule_state, "active");
  assert.ok(made.body.next_at > start && made.body.next_at <= start + DAY);
  // 试建一轮已回滚：没有任务，短号也没被占。
  assert.equal(count("SELECT count(*) n FROM tasks"), 2);
  const node = (await call("GET", "/api/org/nodes/o5")).body;
  assert.equal(node.leader, "a2");
  assert.equal(node.slug, "product");
  const map = (await call("GET", "/api/map/nodes/o5")).body;
  assert.equal(map.overview.alias, "AI 组织的产品部");
  assert.match(map.overview.what, /^管「AI 组织」的演进：每周调研一次/);
  const leader = (await call("GET", "/api/leaders/a2")).body;
  assert.equal(leader.name, "Atrium 产品部");
  assert.equal(leader.worker, "opencode");
  assert.match(leader.memo, /周期研究 s1 每周一轮/);
  const schedule = (await call("GET", "/api/schedules/s1")).body;
  assert.equal(schedule.kind, "research");
  assert.equal(schedule.at, "09:30");
  assert.equal(schedule.worker, "opencode");
  // 同一节点只设一个。
  const again = await call("POST", "/api/products", { node: "o2" });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /已有产品部 o5/);
  // 不给 --worker：leader 沿用往上最近的 leader（a1）的执行者，研究按档案挑。
  const inner = await call("POST", "/api/products", {
    node: "o4",
    name: "体验组",
  });
  assert.equal(inner.status, 201, JSON.stringify(inner.body));
  assert.equal(inner.body.node, "o6");
  assert.equal(inner.body.leader, "a3");
  assert.equal((await call("GET", "/api/leaders/a3")).body.worker, "opencode");
  assert.equal(
    (await call("GET", "/api/leaders/a3")).body.name,
    "命令行 体验组",
  );
  assert.equal((await call("GET", "/api/schedules/s2")).body.worker, null);
  const listed = (await call("GET", "/api/products")).body;
  assert.deepEqual(
    listed.products.map((p: { node: string }) => p.node),
    ["o5", "o6"],
  );
  assert.deepEqual(
    (await call("GET", "/api/products?node=o3")).body.products,
    [],
  );

  // 手动跑一轮：详述按模板现取材料，产品部自己不算材料。
  const run = await call("POST", "/api/schedules/s1/run");
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const round = run.body.task;
  assert.equal(round.deliver, "none");
  assert.equal(round.part_ref, "o5");
  assert.match(round.title, /^Atrium 下一步调研 · /);
  const brief = round.brief as string;
  assert.match(brief, /你是「AI 组织」（o2）的产品部（o5）/);
  assert.match(brief, /是什么：让 AI 替你干活/);
  assert.match(brief, /由哪几部分组成：命令行（终端里用）\n/);
  assert.doesNotMatch(brief, /由哪几部分组成：[^\n]*产品部/);
  assert.match(brief, /这轮不做「合入提速」/);
  assert.match(brief, /\[别扭\] 帮助太长（待处理）/);
  assert.match(brief, new RegExp(`${failedTask.ref} 修测试 · 失败：测试超时`));
  assert.match(
    brief,
    new RegExp(`${doneTask.ref} 选项单上线 · 已上线 v0\\.1\\.121`),
  );

  // 研究结束：运行时把 choice.json 登记成挂在 o2 上的选项单，提的人是产品部 leader。
  await until(
    () =>
      count("SELECT count(*) n FROM choices") === 1 &&
      count(
        "SELECT count(*) n FROM task_inbox WHERE task_id=? AND kind='done'",
        round.id,
      ) === 1,
    15_000,
  );
  const choice = (await call("GET", "/api/choices/c1")).body;
  assert.equal(choice.node, "o2");
  assert.equal(choice.created_by, "a2");
  assert.equal(choice.task, round.ref);
  assert.equal(choice.options.length, 3);
  const inbox = db
    .prepare(
      "SELECT subscriber,kind,detail FROM task_inbox WHERE (dedupe_key='choice:c1' OR task_id=?) ORDER BY id",
    )
    .all(round.id) as { subscriber: string; kind: string; detail: string }[];
  // 拍板人是用户：秘书被叫醒；o2 的 leader a1 收写意见；产品部 leader 收任务完成（带 c1）。
  assert.ok(
    inbox.some(
      (e) => e.subscriber === "secretary" && e.kind === "choice_ready",
    ),
    JSON.stringify(inbox),
  );
  assert.ok(
    inbox.some((e) => e.subscriber === "a1" && e.kind === "choice_review"),
  );
  const done = inbox.find((e) => e.kind === "done")!;
  assert.equal(done.subscriber, "a2");
  assert.equal(JSON.parse(done.detail).choice, "c1");

  // 第二轮：研究者没写文件，任务照常完成，错误写进完成事件交给产品部 leader。
  fx.script("opencode", `echo '{"type":"text","part":{"text":"没写"}}'`);
  const second = (await call("POST", "/api/schedules/s1/run")).body.task;
  assert.match(second.brief, /- c1 Atrium 下一步 · 还在等用户拍板/);
  await until(
    () =>
      count(
        "SELECT count(*) n FROM task_inbox WHERE task_id=? AND kind='done'",
        second.id,
      ) === 1,
    15_000,
  );
  const missing = JSON.parse(
    (
      db
        .prepare(
          "SELECT detail FROM task_inbox WHERE task_id=? AND kind='done'",
        )
        .get(second.id) as { detail: string }
    ).detail,
  );
  assert.match(missing.choice_error, /没有在工作目录写 choice\.json/);
  assert.match(
    missing.next,
    new RegExp(
      `atrium choice add o2 --file .*choice\\.json --task ${second.ref}`,
    ),
  );
  assert.equal(count("SELECT count(*) n FROM choices"), 1);
  assert.equal(
    (await call("GET", `/api/tasks/${second.ref}`)).body.status,
    "done",
  );
  assert.equal(
    (
      db.prepare("SELECT value FROM pi_identities WHERE id=1").get() as {
        value: string;
      }
    ).value,
    "legacy",
  );
});
