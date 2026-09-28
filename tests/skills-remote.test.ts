import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addNode } from "../server/org/write.ts";
import { ensureSkillTables } from "../server/skills/schema.ts";
import { addSkill, bindSkill } from "../server/skills/store.ts";
import { skillsForTask } from "../server/skills/task-skills.ts";
import { collectSkillEdits } from "../server/skills/collect.ts";
import { mountSkills, skillLayout } from "../server/skills/mount.ts";
import {
  REMOTE_REPORT,
  SKILLS_SLOT,
  copyOf,
  fillSkillSlot,
  skillReport,
} from "../server/skills/remote.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
} from "../server/tasks/ledger.ts";
import { prepareRun } from "../server/tasks/workspace.ts";
import type { TaskEventRow } from "../server/tasks/ledger-model.ts";
import type { Tool } from "../server/tasks/adapters/index.ts";
import { skippedSkillsLine } from "../cli/tasks.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 远程主机上的组织技能（t232）：服务随拉起指令带上技能、提示词留占位；代理用同一套挂载填上；
 * 收尾只回传改过的副本，服务落成报告后照常生成修订提议；挂不上的派活回执写明。
 */

const md = (slug: string, description: string, body = "正文") =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n${body}\n`;

/** 组织 o1；Atrium o2 下 web o3（leader a1）；技能 web-design 归 web、绑在 web。 */
function setup() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureSkillTables(db);
  const node = (input: Record<string, unknown>) =>
    addNode(db, { reason: "创建", ...input } as never, "u1");
  node({ slug: "org", kind: "org", name: "组织" });
  node({ parent: "o1", slug: "atrium", kind: "project", name: "Atrium" });
  node({
    parent: "o2",
    slug: "web",
    kind: "module",
    name: "web",
    leader: "a1",
  });
  addSkill(
    db,
    {
      slug: "web-design",
      files: { "SKILL.md": md("web-design", "前端设计约定", "按钮间距 8px") },
      owner: "atrium/web",
      reason: "新建",
    },
    "u1",
  );
  bindSkill(db, "web-design", "atrium/web", "u1");
  return db;
}

const worker = (tool: Tool) => ({
  tool,
  id: tool,
  profile: { rules: {}, body: "", layers: [], warnings: [] } as never,
});

const kinds = (db: DatabaseSync, id: number) =>
  getTask(db, `t${id}`).events.map((e) => e.kind);

test("远程派活：能挂技能的代理随指令带上技能、提示词留占位；旧代理记 skills_skipped；本机那份写明去哪看", async () => {
  const db = setup();
  const data = mkdtempSync(join(tmpdir(), "atrium-skills-remote-"));
  try {
    const t1 = createTask(db, { title: "改按钮", role: "atrium/web" }).id;
    const site = {
      host: 2,
      os: "win32",
      data_dir: "C:\\atrium-agent",
      skills: true,
      version: "0.1.142",
    };
    const prepared = await prepareRun(
      getTask(db, `t${t1}`),
      { worker: worker("claude"), risk: "low" },
      { db, data, env: { HOME: data } },
      undefined,
      site,
    );
    const plan = prepared.remote!;
    // Windows 主机：任务目录按那台的路径拼。
    assert.equal(plan.dir, `C:\\atrium-agent\\tasks\\${t1}`);
    assert.deepEqual(
      plan.skills?.copies.map((s) => [s.slug, s.rev, s.via]),
      [["web-design", 1, "o3 atrium/web"]],
    );
    assert.match(plan.skills!.copies[0]!.files["SKILL.md"]!, /按钮间距 8px/);
    assert.ok(plan.prompt.includes(`## 本次挂载的技能\n\n${SKILLS_SLOT}`));
    const local = readFileSync(prepared.promptFile, "utf8");
    assert.ok(!local.includes(SKILLS_SLOT));
    assert.match(local, /由 h2 上的代理挂载：web-design@r1/);
    // 本机不挂；挂上没有等代理回执再记。
    assert.ok(!existsSync(join(data, "tasks", String(t1), "skills-plugin")));
    assert.ok(!existsSync(join(data, "tasks", String(t1), "skills.json")));
    assert.ok(!kinds(db, t1).includes("skills_mounted"));
    assert.ok(!kinds(db, t1).includes("skills_skipped"));

    // 旧代理不报 skills：不带技能、不留占位，记一笔并说清怎么办。
    const t2 = createTask(db, { title: "改表单", role: "atrium/web" }).id;
    const old = await prepareRun(
      getTask(db, `t${t2}`),
      { worker: worker("codex"), risk: "low" },
      { db, data, env: { HOME: data } },
      undefined,
      { host: 3, os: "linux", data_dir: "/srv/agent", version: "0.1.140" },
    );
    assert.equal(old.remote!.skills, undefined);
    assert.ok(!old.remote!.prompt.includes(SKILLS_SLOT));
    assert.ok(!old.remote!.prompt.includes("本次挂载的技能"));
    const skipped = getTask(db, `t${t2}`).events.find(
      (e) => e.kind === "skills_skipped",
    );
    const detail = JSON.parse(skipped!.detail!);
    assert.deepEqual(detail.skills, ["web-design"]);
    assert.equal(detail.host, "h3");
    assert.match(
      detail.reason,
      /h3 上的代理（0\.1\.140）版本旧，不会挂组织技能/,
    );
  } finally {
    removeTemp(data);
    db.close();
  }
});

test("Windows 上的挂载路径：按工具放在任务目录的哪、怎么交给执行者", () => {
  const dir = "C:\\atrium-agent\\tasks\\7";
  const at = (tool: Tool) => skillLayout(dir, tool, path.win32.join);
  assert.deepEqual(at("claude").args, [
    "--plugin-dir",
    "C:\\atrium-agent\\tasks\\7\\skills-plugin",
  ]);
  assert.equal(
    at("claude").skills,
    "C:\\atrium-agent\\tasks\\7\\skills-plugin\\skills",
  );
  assert.deepEqual(at("codex").env, {
    CODEX_HOME: "C:\\atrium-agent\\tasks\\7\\codex-home",
  });
  assert.deepEqual(at("opencode").env, {
    OPENCODE_CONFIG_DIR: "C:\\atrium-agent\\tasks\\7\\opencode",
  });
  assert.equal(at("grok").skills, "C:\\atrium-agent\\tasks\\7\\skills");
  // 缺省按本机平台拼。
  assert.equal(
    skillLayout(join("a", "b"), "claude").root,
    join("a", "b", "skills-plugin"),
  );
});

test("代理挂载填占位、收尾只回传改过的副本；服务落成报告后照常生成提议，读不出的写明原因", () => {
  const db = setup();
  const root = mkdtempSync(join(tmpdir(), "atrium-skills-remote-"));
  try {
    const id = createTask(db, { title: "改按钮", role: "atrium/web" }).id;
    const copies = skillsForTask(db, getTask(db, `t${id}`)).skills.map(copyOf);
    // 代理那台：同一个 mountSkills，路径是那台自己的。
    const agentDir = join(root, "agent", "tasks", String(id));
    mkdirSync(agentDir, { recursive: true });
    const mount = mountSkills(agentDir, "opencode", copies, root)!;
    const copy = join(agentDir, "opencode", "skills", "web-design", "SKILL.md");
    const prompt = `# 任务\n\n## 本次挂载的技能\n\n${SKILLS_SLOT}\n\n## 规则`;
    const filled = fillSkillSlot(prompt, { section: mount.section });
    assert.ok(!filled.includes(SKILLS_SLOT));
    assert.ok(filled.includes(`文件：${copy}`));
    assert.ok(filled.includes(join(agentDir, "skill-notes.md")));
    assert.match(
      fillSkillSlot(prompt, { error: "挂技能失败：EPERM" }),
      /原本要带的组织技能没挂上（挂技能失败：EPERM）/,
    );
    assert.equal(fillSkillSlot(prompt, undefined).includes(SKILLS_SLOT), false);
    assert.equal(fillSkillSlot("没有占位", { section: "x" }), "没有占位");

    // 没改：不回传，退出上报与以前一样。
    assert.equal(skillReport(agentDir), undefined);
    writeFileSync(copy, md("web-design", "前端设计约定", "按钮间距 12px"));
    writeFileSync(join(agentDir, "skill-notes.md"), "8px 在新设计稿里不对\n");
    const report = skillReport(agentDir)!;
    assert.equal(report.notes, "8px 在新设计稿里不对");
    assert.equal(report.edits.length, 1);
    assert.match(
      (report.edits[0] as { files: Record<string, string> }).files["SKILL.md"]!,
      /12px/,
    );

    // 服务这边：本机任务目录里没有挂载清单，只有落下的报告。
    const serverDir = join(root, "server", "tasks", String(id));
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, REMOTE_REPORT), JSON.stringify(report));
    const collected = collectSkillEdits(db, id, serverDir);
    assert.deepEqual(collected.problems, []);
    assert.deepEqual(
      collected.proposals.map((p) => [p.proposal, p.slug, p.base]),
      [["p1", "web-design", "r1"]],
    );
    assert.deepEqual(collectSkillEdits(db, id, serverDir).proposals, []);

    // 副本读不出来（被删、超限）：写明原因，不生成提议。
    writeFileSync(
      join(serverDir, REMOTE_REPORT),
      JSON.stringify({
        edits: [{ id: 1, slug: "web-design", rev: 1, problem: "读不到 x" }],
      }),
    );
    assert.deepEqual(collectSkillEdits(db, id, serverDir).problems, [
      "web-design：读不到 x，没生成提议",
    ]);
    // 坏报告当没有。
    writeFileSync(join(serverDir, REMOTE_REPORT), "{坏");
    assert.deepEqual(collectSkillEdits(db, id, serverDir), {
      proposals: [],
      problems: [],
    });
  } finally {
    removeTemp(root);
    db.close();
  }
});

test("派活回执：这次拉起前记了 skills_skipped 才写明，之前几轮的不算", () => {
  let n = 0;
  const event = (kind: string, detail?: object): TaskEventRow => ({
    id: ++n,
    task_id: 1,
    at: n,
    kind,
    detail: detail ? JSON.stringify(detail) : null,
  });
  const skipped = event("skills_skipped", {
    host: "h3",
    reason: "h3 上的代理（0.1.140）版本旧，不会挂组织技能",
    skills: ["visual-design", "design-dialogue"],
  });
  assert.equal(skippedSkillsLine([]), null);
  assert.equal(skippedSkillsLine(undefined), null, "回执没带事件");
  assert.equal(
    skippedSkillsLine([event("created"), skipped]),
    null,
    "还没拉起",
  );
  assert.equal(
    skippedSkillsLine([event("created"), skipped, event("start")]),
    "组织技能没挂上（visual-design、design-dialogue）：h3 上的代理（0.1.140）版本旧，不会挂组织技能",
  );
  assert.equal(
    skippedSkillsLine([
      skipped,
      event("start"),
      event("skills_mounted", { skills: ["visual-design@r1"] }),
      event("start"),
    ]),
    null,
    "上一轮没挂上，这一轮挂上了",
  );
  assert.equal(
    skippedSkillsLine([
      event("start"),
      { ...skipped, detail: "{坏" },
      event("start"),
    ]),
    null,
  );
});
