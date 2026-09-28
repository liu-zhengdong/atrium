import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "./task-fixture.ts";

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
