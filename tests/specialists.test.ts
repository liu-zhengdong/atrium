import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode } from "../server/org/write.ts";
import { addPoint } from "../server/org/points.ts";
import { ensureSkillTables } from "../server/skills/schema.ts";
import { addSkill, bindSkill } from "../server/skills/store.ts";
import { createJobRole, getJobRole } from "../server/tasks/job-roles.ts";
import { createTask } from "../server/tasks/ledger-write.ts";
import { checklists } from "../server/tasks/concerns.ts";
import {
  specialistMigrationAction,
  migrateSpecialists,
} from "../server/tasks/specialist-migrate.ts";
import { specialistOptions } from "../server/tasks/specialist-options.ts";
import { tree } from "../server/org/read.ts";
import { startApp } from "./task-fixture.ts";

const dbOf = () => {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureOrgTables(db);
  return db;
};
const node = (db: DatabaseSync, input: Record<string, unknown>) =>
  addNode(db, { reason: "测试", ...input } as never, "u1");

test("新旧专员参数：空串清空、两套写法同时给则拒绝", () => {
  for (const [input, by, ask] of [
    [{ by: "前端", ask: "后端" }, "前端", "后端"],
    [{ job: "前端", concern: "后端" }, "前端", "后端"],
    [{ by: "", ask: "" }, "", ""],
  ] as const) {
    const parsed = specialistOptions(input);
    assert.equal(parsed.by, by);
    assert.equal(parsed.ask, ask);
    assert.equal(parsed.byPresent, true);
    assert.equal(parsed.askPresent, true);
  }
  assert.equal(specialistOptions({}).byPresent, false);
  assert.throws(
    () => specialistOptions({ by: "前端", job: "后端" }),
    /只能给一个/,
  );
  assert.throws(
    () => specialistOptions({ ask: "前端", concern: "后端" }),
    /只能给一个/,
  );
  assert.throws(() => specialistOptions({ by: 0 }), /by: 应为专员/);
  assert.throws(() => specialistOptions({ ask: [] }), /ask: 应为专员/);
});

test("--by 干活、--ask 请来看共用专员短号；旧参数仍可读", () => {
  const db = dbOf();
  createJobRole(db, { name: "前端", description: "页面", body: "做页面" });
  createJobRole(db, {
    name: "后端",
    description: "服务",
    body: "做服务",
    review_goal: "检查接口",
    review_points: [{ ref: "k1", text: "接口契约正确", why: "避免回归" }],
  });
  const task = createTask(db, { title: "改页面", by: "前端", ask: "后端" });
  assert.equal(task.job_ref, "r1");
  assert.deepEqual(
    task.concerns?.map((x) => x.ref),
    ["r2"],
  );
  assert.equal(checklists(db, task.id)[0]!.points[0]!.text, "接口契约正确");
  assert.equal(createTask(db, { title: "旧写法", job: "前端" }).job_ref, "r1");
  assert.equal(
    createTask(db, { title: "更旧写法", role: "前端" }).job_ref,
    "r1",
  );
  assert.throws(
    () => createTask(db, { title: "错", ask: "不存在" }),
    /专员 不存在 不存在/,
  );
  db.close();
});

test("启动迁移：rN 不变，关注点并入专员，o6/o7 要点移入 o2", () => {
  assert.equal(specialistMigrationAction({ id: 6, name: "安全" }), "retire");
  assert.equal(specialistMigrationAction({ id: 7, name: "质量" }), "retire");
  assert.equal(specialistMigrationAction({ id: 6, name: "前端" }), "convert");
  const db = dbOf();
  node(db, { slug: "组织", kind: "org", name: "组织" });
  node(db, { parent: "o1", slug: "atrium", kind: "project", name: "Atrium" });
  for (const name of ["甲", "乙", "丙"])
    node(db, { parent: "o2", slug: name, kind: "module", name });
  node(db, { parent: "o2", slug: "安全", kind: "concern", name: "安全" });
  node(db, { parent: "o2", slug: "质量", kind: "concern", name: "质量" });
  node(db, { parent: "o2", slug: "后端", kind: "concern", name: "后端" });
  ensureSkillTables(db);
  addSkill(
    db,
    {
      slug: "backend-skill",
      name: "后端技能",
      description: "服务规则",
      files: {
        "SKILL.md":
          "---\nname: backend-skill\ndescription: 服务规则\n---\n接口契约",
      },
      reason: "测试",
    },
    "u1",
  );
  bindSkill(db, "backend-skill", "o8", "u1");
  db.prepare(
    "INSERT INTO org_points(id,node_id,pos,text,why,decided_by,updated_by,updated_at) VALUES(15,6,0,'凭据不进日志、提交、PR、截图和提示词','守住凭据','u1','u1',1)",
  ).run();
  createJobRole(db, { name: "前端", description: "页面", body: "前端技能" });
  createJobRole(db, { name: "后端", description: "服务", body: "后端技能" });
  const task = createTask(db, { title: "旧任务", concern: "后端" });
  migrateSpecialists(db);
  assert.equal(getJobRole(db, "前端").ref, "r1");
  assert.equal(getJobRole(db, "后端").ref, "r2");
  assert.deepEqual(getJobRole(db, "后端").skills, ["backend-skill"]);
  assert.equal(
    db
      .prepare("SELECT node_id FROM task_concerns WHERE task_id=?")
      .get(task.id)!.node_id,
    -2,
  );
  assert.equal(
    db.prepare("SELECT node_id FROM org_points WHERE id=15").get()!.node_id,
    2,
  );
  assert.ok(tree(db).every((n: { kind: string }) => n.kind !== "concern"));
  migrateSpecialists(db);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) n FROM org_points WHERE id=15 AND node_id=2")
      .get()!.n,
    1,
  );
  db.close();
});

test("启动迁移逐条隔离坏记录；旧运行时表保持原样", () => {
  const db = dbOf();
  db.exec("CREATE TABLE pi_accounts(id INTEGER PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO pi_accounts(id,value) VALUES(1,'legacy')").run();
  node(db, { slug: "org", kind: "org", name: "组织" });
  node(db, { parent: "o1", slug: "atrium", kind: "project", name: "Atrium" });
  node(db, { parent: "o2", slug: "坏记录", kind: "concern", name: "坏记录" });
  node(db, { parent: "o2", slug: "后端", kind: "concern", name: "后端" });
  db.prepare(
    "INSERT INTO org_docs(node_id,doc,rev,fields,body,updated_by,updated_at) VALUES(3,'charter',1,'{bad','说明','u1',1)",
  ).run();
  migrateSpecialists(db);
  assert.equal(getJobRole(db, "后端").ref, "r1");
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM specialist_migration_quarantine WHERE node_id=3",
      )
      .get()!.n,
    1,
  );
  assert.equal(
    typeof db.prepare("SELECT archived_at FROM org_nodes WHERE id=3").get()!
      .archived_at,
    "number",
  );
  migrateSpecialists(db);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM specialist_migration_quarantine WHERE node_id=3",
      )
      .get()!.n,
    1,
  );
  assert.equal(
    db.prepare("SELECT value FROM pi_accounts WHERE id=1").get()!.value,
    "legacy",
  );
  db.close();
});

test("隔离服务：--by 前端派活附前端技能，全景树不挂专员", async (t) => {
  const { fx, data, call } = await startApp(t);
  const ok = async (url: string, payload: object) => {
    const response = await call("POST", url, payload);
    assert.ok(response.status < 300, JSON.stringify(response.body));
    return response.body;
  };
  await ok("/api/org/nodes", {
    slug: "org",
    kind: "org",
    name: "组织",
    reason: "建",
  });
  await ok("/api/org/nodes", {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    reason: "建",
  });
  await ok("/api/skills", {
    slug: "frontend-skill",
    reason: "前端约定",
    files: {
      "SKILL.md":
        "---\nname: frontend-skill\ndescription: 前端技能\n---\n页面检查",
    },
  });
  await ok("/api/specialists", {
    name: "前端",
    description: "实现页面",
    body: "按设计稿完成页面",
    skills: ["frontend-skill"],
  });
  const task = await ok("/api/tasks", {
    title: "改页面",
    by: "前端",
    part: "o2",
    repo: fx.repo,
  });
  assert.equal(task.job_ref, "r1");
  await ok("/api/tasks/t1/run", { worker: "opencode" });
  const prompt = readFileSync(join(data, "tasks", "1", "prompt.md"), "utf8");
  assert.match(prompt, /# 干活的专员：前端/);
  assert.match(prompt, /frontend-skill/);
  const specialists = (await call("GET", "/api/map/specialists")).body;
  assert.deepEqual(
    specialists.specialists.map((r: { name: string }) => r.name),
    ["前端"],
  );
  const view = (await call("GET", "/api/map/tree")).body;
  assert.ok(JSON.stringify(view).includes("Atrium"));
  assert.ok(!JSON.stringify(view).includes('"kind":"concern"'));
});

test("隔离服务启动后：o6/o7 从树消失，k15 出现在 o2，rN 保留", async (t) => {
  const { call } = await startApp(t, (fx) => {
    const data = join(fx.root, "data");
    mkdirSync(data, { recursive: true });
    const db = new DatabaseSync(join(data, "atrium.sqlite"));
    ensureTaskTables(db);
    ensureOrgTables(db);
    node(db, { slug: "org", kind: "org", name: "组织" });
    node(db, { parent: "o1", slug: "atrium", kind: "project", name: "Atrium" });
    for (const name of ["甲", "乙", "丙"])
      node(db, { parent: "o2", slug: name, kind: "module", name });
    node(db, { parent: "o2", slug: "安全", kind: "concern", name: "安全" });
    node(db, { parent: "o2", slug: "质量", kind: "concern", name: "质量" });
    db.prepare(
      "INSERT INTO org_points(id,node_id,pos,text,why,decided_by,updated_by,updated_at) VALUES(15,6,0,'凭据不进日志、提交、PR、截图和提示词','守住凭据','u1','u1',1)",
    ).run();
    createJobRole(db, { name: "前端", description: "页面", body: "前端技能" });
    createJobRole(db, { name: "后端", description: "服务", body: "后端技能" });
    db.close();
  });
  const treeResponse = await call("GET", "/api/map/tree");
  assert.equal(treeResponse.status, 200);
  const treeText = JSON.stringify(treeResponse.body);
  assert.ok(!treeText.includes('"ref":"o6"'));
  assert.ok(!treeText.includes('"ref":"o7"'));
  const nodeResponse = await call("GET", "/api/map/nodes/o2");
  assert.equal(nodeResponse.status, 200);
  assert.ok(
    nodeResponse.body.points.some((p: { ref: string }) => p.ref === "k15"),
  );
  const specialists = (await call("GET", "/api/map/specialists")).body
    .specialists;
  assert.deepEqual(
    specialists.map((s: { ref: string; name: string }) => [s.ref, s.name]),
    [
      ["r1", "前端"],
      ["r2", "后端"],
    ],
  );
});
