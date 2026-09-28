import { importWorkerProfiles } from "../server/tasks/worker-profiles.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { authPolicy } from "../server/auth-policy.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { ensureSkillTables } from "../server/skills/schema.ts";
import { addSkill, bindSkill } from "../server/skills/store.ts";
import {
  advanceTask,
  createTask,
  ensureTaskTables,
  noteTask,
} from "../server/tasks/ledger.ts";
import { createJobRole } from "../server/tasks/job-roles.ts";
import { editMap } from "../server/map/write.ts";
import { mapNode } from "../server/map/view.ts";
import {
  deliveryResult,
  deliveryStory,
  mapRole,
  mapRoles,
  mapSkills,
  mapWorker,
  mapWorkers,
  profileNotes,
} from "../server/map/people.ts";
import { removeTemp } from "./temp-dir.ts";

// ---- 纯函数：结果标签、经过、档案里的观察 ----

const facts = (over: Partial<Parameters<typeof deliveryResult>[0]> = {}) => ({
  final_result: "已合入",
  first_pass: true,
  gate_return_count: 0,
  merge_returns: [] as string[],
  verdict: null as string | null,
  ended_at: 10,
  ...over,
});

test("交付结果标签：结局优先，其次上线后的标注与打回次数", () => {
  const label = (over: Parameters<typeof facts>[0]) =>
    deliveryResult(facts(over));
  assert.deepEqual(label({}), { label: "一次通过", tone: "green" });
  assert.deepEqual(label({ first_pass: false, gate_return_count: 1 }), {
    label: "打回 1 次",
    tone: "amber",
  });
  assert.deepEqual(
    label({ first_pass: false, gate_return_count: 1, merge_returns: ["x"] }),
    { label: "打回 2 次", tone: "orange" },
  );
  assert.equal(label({ verdict: "rejected" }).label, "被你否掉");
  assert.equal(label({ verdict: "fixed" }).label, "上线后返修");
  assert.equal(label({ final_result: "失败" }).label, "没交付");
  assert.equal(label({ final_result: "换人" }).label, "换人");
  assert.equal(label({ final_result: "受阻" }).label, "卡住");
  assert.equal(label({ final_result: "取消" }).tone, "gray");
  // 变基冲突不算执行者的：灰色，不是打回。
  assert.deepEqual(label({ final_result: "变基冲突" }), {
    label: "合入冲突",
    tone: "gray",
  });
  assert.deepEqual(label({ final_result: "进行中", ended_at: null }), {
    label: "进行中",
    tone: "green",
  });
  assert.deepEqual(label({ final_result: "交付", first_pass: false }), {
    label: "等合入",
    tone: "blue",
  });
  assert.deepEqual(label({ first_pass: false }), {
    label: "已合入",
    tone: "gray",
  });
});

test("交付经过：关卡名换成证据，冲突注明不算它的，没有就是空串", () => {
  const none = {
    incidents: [],
    gate_returns: [],
    merge_returns: [],
    rebase_conflicts: 0,
    verdict_note: null,
  };
  assert.equal(deliveryStory(none), "");
  assert.equal(
    deliveryStory({
      ...none,
      incidents: ["卡死", "虚报"],
      gate_returns: ["screenshot：PR 正文里没有截图", "local_check：未过"],
      merge_returns: ["检查失败"],
      rebase_conflicts: 2,
      verdict_note: "上线后按钮位置不对",
    }),
    "出事：卡死、虚报；验收没过：PR 正文里没有截图；本地检查没过；合入退回：检查失败；合入时和别人冲突 2 次（不算它的）；上线后按钮位置不对",
  );
});

test("档案观察：带日期的段落才算，写了谁就用谁，新的在前", () => {
  const notes = profileNotes([
    {
      body: "（2026-09-26 观察：审查稳。）\n\n**硬规定**：不要后台等待。\n\n（2026-09-27：两次放到后台，零交付。）",
    },
    {
      body: "（模型层）交付稳定。\n（2026-09-27 你纠正：前端先出设计稿。）\n（2026-09-25 用户定：只接小活。）",
    },
  ]);
  assert.deepEqual(notes, [
    { date: "09-27", text: "两次放到后台，零交付。", by: "秘书" },
    { date: "09-27", text: "前端先出设计稿。", by: "你纠正" },
    { date: "09-26", text: "审查稳。", by: "秘书" },
    { date: "09-25", text: "只接小活。", by: "你定" },
  ]);
  assert.deepEqual(profileNotes([{ body: "" }]), []);
});

// ---- 读库：角色、技能、执行者 ----

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "atrium-map-people-"));
  const workers = join(root, "workers");
  for (const dir of ["harness", "models", "combos"])
    mkdirSync(join(workers, dir), { recursive: true });
  writeFileSync(
    join(workers, "harness", "codex.md"),
    "---\ntrust: medium\n---\n（2026-09-26 你说的：后端放心。）\n",
  );
  writeFileSync(join(workers, "models", "gpt-6-sol.md"), "---\n---\n模型层\n");
  const db = new DatabaseSync(":memory:");
  ensureOrgTables(db);
  ensureTaskTables(db);
  ensureSkillTables(db);
  importWorkerProfiles(db, workers, () => {});
  const node = (input: Record<string, unknown>) =>
    addNode(db, { reason: "创建", ...input } as never, "u1");
  node({ slug: "org", kind: "org", name: "组织" });
  node({ parent: "o1", slug: "atrium", kind: "project", name: "Atrium" });
  node({ parent: "o2", slug: "cli", kind: "module", name: "cli" });
  node({ parent: "o2", slug: "安全", kind: "concern", name: "安全" });
  editMap(db, "o3", { alias: "命令行和网页" }, "u1");
  addSkill(
    db,
    {
      slug: "atrium-cli",
      name: "命令行约定",
      description: "回执给下一步",
      files: {
        "SKILL.md":
          "---\nname: atrium-cli\ndescription: 回执给下一步\n---\n正文",
      },
      reason: "首版",
    },
    "u1",
  );
  bindSkill(db, "atrium-cli", "o3", "u1");
  createJobRole(db, {
    name: "后端",
    description: "服务和数据",
    body: "测试要过",
    preferred: ["codex+gpt-6-sol:high"],
    checks: ["local_check"],
    skills: ["atrium-cli"],
  });
  createJobRole(db, {
    name: "前端",
    description: "网页",
    body: "附截图",
    preferred: [],
    checks: ["screenshot"],
    skills: [],
  });
  const worker = "codex+gpt-6-sol:high";
  for (let i = 0; i < 5; i++) {
    const task = createTask(db, { title: `交付${i}`, by: "后端", part: "o3" });
    const at = 1000 + i * 1000;
    advanceTask(db, task.ref, { kind: "start" }, { worker }, { worker }, at);
    if (i === 1)
      noteTask(
        db,
        task.id,
        "gates",
        { passed: false, results: [{ gate: "local_check", ok: false }] },
        at + 100,
      );
    noteTask(db, task.id, "gates", { passed: true, results: [] }, at + 200);
    advanceTask(db, task.ref, { kind: "exit_ok" }, {}, undefined, at + 600_000);
  }
  // 在做、还没结束的一件：不进统计行，但在角色任务里。
  const running = createTask(db, { title: "在做的", by: "后端", part: "o3" });
  advanceTask(db, running.ref, { kind: "start" }, { worker }, { worker }, 9000);
  return { db, workers, root };
}

test("全景的角色、技能、执行者视图：挂在哪、谁做得好、交付记录与观察", async (t) => {
  const { db, workers, root } = seeded();
  t.after(() => removeTemp(root));

  const { roles } = mapRoles(db);
  assert.deepEqual(
    roles.map((r) => [r.ref, r.name, r.running]),
    [
      ["r1", "后端", 1],
      ["r2", "前端", 0],
    ],
  );
  const [skill] = mapSkills(db).skills;
  assert.deepEqual(skill!.on, [
    { kind: "role", ref: "r1", name: "后端" },
    { kind: "part", ref: "o3", name: "命令行和网页" },
  ]);
  assert.equal(skill!.last?.reason, "首版");

  const all = await mapWorkers(db, undefined);
  assert.equal(all.rows.length, 1, "在做的不单独成行");
  assert.equal(all.rows[0]!.deliveries, 5);
  assert.equal(all.rows[0]!.first_pass_rate, 0.8);
  assert.equal(all.rows[0]!.trust, "medium");
  assert.deepEqual((await mapWorkers(db, "r2")).rows, []);
  await assert.rejects(mapWorkers(db, "r9"), /不存在/);

  const role = await mapRole(db, "r1");
  assert.equal(role.tasks.length, 6);
  assert.equal(role.tasks[0]!.status, "running");
  assert.deepEqual(role.tasks[0]!.job, { ref: "r1", name: "后端" });
  assert.equal(role.workers.length, 1);
  assert.deepEqual(
    role.skills.map((s) => s.slug),
    ["atrium-cli"],
  );
  await assert.rejects(mapRole(db, "r9"), /专员 r9 不存在/);

  const worker = await mapWorker(db, "codex+gpt-6-sol:high");
  assert.equal(worker.trust, "medium");
  assert.equal(worker.deliveries.length, 6);
  assert.deepEqual(worker.deliveries.map((d) => d.result.label).sort(), [
    "一次通过",
    "一次通过",
    "一次通过",
    "一次通过",
    "打回 1 次",
    "进行中",
  ]);
  assert.deepEqual(worker.notes, [
    { date: "09-26", text: "后端放心。", by: "你说的" },
  ]);
  // 破坏输入：名字不合法 400；合法但既没交付也没模型或组合档案 404。
  await assert.rejects(mapWorker(db, "foo+bar"), /未知的执行者工具/);
  await assert.rejects(
    mapWorker(db, "claude+nope:high"),
    /没有交付记录，也没有档案/,
  );

  // 各部分的任务带角色；专员带人话「什么时候请来」。
  const node = mapNode(db, "o3");
  assert.deepEqual(node.tasks.running[0]!.job, { ref: "r1", name: "后端" });
  editMap(db, "o4", { when: "动到凭据、权限时" }, "u1");
  assert.equal("concerns" in mapNode(db, "o2"), false);
  assert.throws(
    () => editMap(db, "o3", { when: "随时" }, "u1"),
    /--when: 专员请用 atrium specialist edit/,
  );
  editMap(db, "o4", { when: "" }, "u1");
  assert.equal("concerns" in mapNode(db, "o2"), false);
  db.close();
});

test("接口：网页会话能读角色、技能、执行者，不存在的给 404", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-map-people-app-"));
  t.after(() => removeTemp(data));
  const { app } = await createApp({
    data,
    tasks: { pace: async () => undefined, workersDir: join(data, "workers") },
  });
  t.after(() => app.close());
  const host = { host: "127.0.0.1" };
  const auth = {
    ...host,
    authorization: `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`,
  };
  const link = await app.inject({
    method: "POST",
    url: "/api/map/login",
    headers: auth,
  });
  const login = await app.inject({ url: link.json().path, headers: host });
  const session = {
    ...host,
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
  };
  for (const url of [
    "/api/map/specialists",
    "/api/map/skills",
    "/api/map/workers",
    "/api/map/leaders",
  ]) {
    assert.equal(authPolicy("GET", url), "map-read");
    const res = await app.inject({ url, headers: session });
    assert.equal(res.statusCode, 200, `${url} ${res.body}`);
  }
  assert.deepEqual(
    (
      await app.inject({ url: "/api/map/specialists", headers: session })
    ).json(),
    { specialists: [] },
  );
  for (const [url, code] of [
    ["/api/map/specialists/r9", 404],
    ["/api/map/workers/claude%2Bnope%3Ahigh", 404],
    ["/api/map/workers/foo%2Bbar", 400],
    ["/api/map/workers?role=r9", 404],
    ["/api/map/leaders/a9", 404],
    ["/api/map/leaders/o1", 400],
    ["/api/map/leaders/..%2Fa1", 400],
    // 按部分列专员：部分不存在或名字不合法都不给。
    ["/api/map/specialists?part=o99", 404],
    ["/api/map/specialists?part=..%2Fo1", 404],
    ["/api/map/specialists?part=", 200],
  ] as const)
    assert.equal(
      (await app.inject({ url, headers: session })).statusCode,
      code,
      url,
    );
  // 没登录不能读。
  assert.equal(
    (await app.inject({ url: "/api/map/workers", headers: host })).statusCode,
    401,
  );
});
