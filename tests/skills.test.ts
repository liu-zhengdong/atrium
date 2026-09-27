import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addNode } from "../server/org/write.ts";
import { ensureSkillTables } from "../server/skills/schema.ts";
import {
  LIMITS,
  avoidReason,
  effectiveSkills,
  filesDiff,
  merge3Text,
  mergeFiles,
  skillMeta,
  validateFiles,
  validateSkillSlug,
  type ChainNode,
} from "../server/skills/model.ts";
import {
  acceptProposal,
  addSkill,
  bindSkill,
  editSkill,
  listProposals,
  listSkills,
  rejectProposal,
  revertSkill,
  showProposal,
  skillHistory,
} from "../server/skills/store.ts";
import { skillsForTask } from "../server/skills/task-skills.ts";
import { collectSkillEdits } from "../server/skills/collect.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
} from "../server/tasks/ledger.ts";
import { pickWorker } from "../server/tasks/prepare.ts";
import { prepareRun } from "../server/tasks/workspace.ts";
import {
  mergeLayers,
  type EffectiveProfile,
} from "../server/tasks/profiles.ts";
import type { Tool } from "../server/tasks/adapters/index.ts";
import { readSkillSource } from "../cli/skills.ts";

const md = (slug: string, description: string, body = "正文") =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n\n${body}\n`;

/** 组织 o1；Atrium o2 下 web o3（leader a1）、runtime o4；OpenQuota o5。 */
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
  node({ parent: "o2", slug: "runtime", kind: "module", name: "runtime" });
  node({ parent: "o1", slug: "openquota", kind: "project", name: "OpenQuota" });
  return db;
}

const add = (
  db: DatabaseSync,
  slug: string,
  extra: Record<string, unknown> = {},
  actor = "u1",
) =>
  addSkill(
    db,
    {
      slug,
      files: { "SKILL.md": md(slug, `${slug} 的简介`) },
      reason: "新建",
      ...extra,
    },
    actor,
  );

test("技能文件校验：破坏输入按字段名拒绝", () => {
  assert.throws(() => validateSkillSlug("Web Design"), /^Error: slug /);
  assert.throws(() => validateSkillSlug("web--design"), /slug/);
  assert.throws(() => validateSkillSlug("../x"), /slug/);
  assert.equal(validateSkillSlug("web-design"), "web-design");
  assert.throws(
    () => validateFiles({ "README.md": "x" }),
    /files 缺少 SKILL.md/,
  );
  assert.throws(() => validateFiles([]), /files 应为/);
  for (const bad of [
    "../x.md",
    "/etc/passwd",
    ".hidden",
    "a/.git/x",
    "a\\b",
    "a//b",
    "a/b/c/d/e",
  ])
    assert.throws(
      () => validateFiles({ "SKILL.md": "x", [bad]: "y" }),
      /路径不合法/,
      bad,
    );
  assert.throws(
    () => validateFiles({ "SKILL.md": "x", "bin.dat": "a\0b" }),
    /files.bin.dat 应为文本文件/,
  );
  assert.throws(
    () => validateFiles({ "SKILL.md": "x".repeat(LIMITS.bytes + 1) }),
    /超过 256 KB/,
  );
  const many = Object.fromEntries(
    Array.from({ length: LIMITS.files }, (_, i) => [`f${i}.md`, "x"]),
  );
  assert.throws(
    () => validateFiles({ "SKILL.md": "x", ...many }),
    /超过 32 个文件/,
  );
  assert.deepEqual(
    Object.keys(validateFiles({ z: "1", "SKILL.md": "2", "a/b.md": "3" })),
    ["SKILL.md", "a/b.md", "z"],
  );
  // frontmatter
  assert.throws(
    () => skillMeta("web", { "SKILL.md": md("other", "简介") }),
    /name 应为 web/,
  );
  assert.throws(
    () => skillMeta("web", { "SKILL.md": "---\nname: web\n---\n正文" }),
    /缺少 description/,
  );
  assert.throws(
    () => skillMeta("web", { "SKILL.md": "---\nname: [web\n---\n" }),
    /frontmatter 格式错误/,
  );
  assert.throws(
    () => skillMeta("web", { "SKILL.md": "正文" }),
    /description 必填/,
  );
  assert.throws(
    () => skillMeta("web", { "SKILL.md": md("web", "甲") }, "乙"),
    /与 SKILL.md frontmatter 里的 description 不一致/,
  );
  const filled = skillMeta(
    "web",
    { "SKILL.md": "按钮间距 8px" },
    "前端设计约定",
  );
  assert.equal(filled.description, "前端设计约定");
  assert.match(
    filled.files["SKILL.md"]!,
    /^---\nname: web\ndescription: 前端设计约定\n---\n\n按钮间距 8px$/,
  );
  assert.throws(
    () =>
      skillMeta(
        "web",
        { "SKILL.md": "x" },
        "长".repeat(LIMITS.description + 1),
      ),
    /description 超过 1024 字/,
  );
});

const chain: ChainNode[] = [
  { id: 1, ref: "o1", path: "org" },
  { id: 2, ref: "o2", path: "atrium" },
  { id: 3, ref: "o3", path: "atrium/web" },
];

test("生效集合：节点链绑定 ∪ 档案，去重、上限、未知单列", () => {
  const known = new Set([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "base",
  ]);
  const result = effectiveSkills({
    chain,
    bound: new Map([
      [1, ["base"]],
      [3, ["a", "b"]],
      [9, ["j"]],
    ]),
    profile: {
      skills: ["b", "c", "ghost"],
      skills_for: { "atrium/web": ["d"], o2: ["e"], "atrium/runtime": ["i"] },
    },
    known,
  });
  assert.deepEqual(
    result.picked.map((p) => `${p.slug}:${p.via}`),
    [
      "base:o1 org",
      "a:o3 atrium/web",
      "b:o3 atrium/web",
      "c:执行者档案",
      "d:执行者档案（做 atrium/web 的活）",
      "e:执行者档案（做 atrium 的活）",
    ],
    "父节点绑定覆盖子节点的活；别的节点的 skills_for 不带",
  );
  assert.deepEqual(result.unknown, ["ghost"]);
  const capped = effectiveSkills({
    chain,
    bound: new Map([[3, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]]]),
    known,
  });
  assert.equal(capped.picked.length, 8);
  assert.deepEqual(
    capped.dropped.map((d) => d.slug),
    ["i", "j"],
  );
  assert.deepEqual(
    effectiveSkills({
      chain: [],
      bound: new Map(),
      profile: { skills: "c" },
      known,
    }).picked,
    [{ slug: "c", via: "执行者档案" }],
    "没关联节点的任务仍带档案指定的",
  );
});

test("avoid_nodes：自动挑人时避开，写父节点也覆盖子节点", () => {
  assert.equal(
    avoidReason(chain, ["atrium/web"]),
    "档案 avoid_nodes 避开 o3 atrium/web",
  );
  assert.equal(avoidReason(chain, "o2"), "档案 avoid_nodes 避开 o2 atrium");
  assert.equal(avoidReason(chain, ["atrium/runtime"]), undefined);
  assert.equal(avoidReason([], ["atrium/web"]), undefined);
  const profile = (rules: EffectiveProfile["rules"]): EffectiveProfile => ({
    rules,
    body: "",
    layers: [],
    warnings: [],
  });
  const picked = pickWorker({
    installed: ["codex", "claude"] as Tool[],
    risk: "low",
    profiles: { codex: profile({ avoid_nodes: ["atrium/web"] }) },
    pace: [
      { providerId: "codex", sparePercent: 80 },
      { providerId: "claude", sparePercent: 10 },
    ],
    chain,
  });
  assert.ok(picked.ok);
  assert.equal(picked.ok && picked.tool, "claude");
  assert.deepEqual(
    picked.skipped.find((s) => s.tool === "codex"),
    { tool: "codex", reason: "档案 avoid_nodes 避开 o3 atrium/web" },
  );
  const elsewhere = pickWorker({
    installed: ["codex", "claude"] as Tool[],
    risk: "low",
    profiles: { codex: profile({ avoid_nodes: ["atrium/web"] }) },
    pace: [
      { providerId: "codex", sparePercent: 80 },
      { providerId: "claude", sparePercent: 10 },
    ],
    chain: chain.slice(0, 2),
  });
  assert.equal(elsewhere.ok && elsewhere.tool, "codex");
});

test("档案合并：skills、avoid_nodes 取并集，skills_for 按节点合并", () => {
  const layer = (
    l: "harness" | "models" | "combos",
    rules: Record<string, unknown>,
  ) => ({
    layer: l,
    file: `${l}.md`,
    rules: rules as never,
    body: "",
    warnings: [],
  });
  const merged = mergeLayers([
    layer("harness", {
      skills: ["a"],
      skills_for: { "atrium/web": ["x"] },
      avoid_nodes: "o3",
    }),
    layer("combos", {
      skills: ["b", "a"],
      skills_for: { "atrium/web": ["y"], o4: ["z"] },
    }),
  ]).rules;
  assert.deepEqual(merged.skills, ["a", "b"]);
  assert.deepEqual(merged.avoid_nodes, ["o3"]);
  assert.deepEqual(merged.skills_for, { "atrium/web": ["x", "y"], o4: ["z"] });
});

test("三方合并：两边改不同处自动合并，改同一处算冲突", () => {
  const base = "标题\n一\n二\n三\n四\n五";
  const ours = "标题\n一（审核人改）\n二\n三\n四\n五";
  const theirs = "标题\n一\n二\n三\n四\n五（执行者改）\n六";
  assert.deepEqual(merge3Text(base, ours, theirs), {
    text: "标题\n一（审核人改）\n二\n三\n四\n五（执行者改）\n六",
    conflict: false,
  });
  assert.equal(merge3Text(base, ours, ours).conflict, false, "两边改得一样");
  assert.equal(merge3Text(base, base, theirs).text, theirs);
  assert.equal(merge3Text(base, ours, base).text, ours);
  assert.equal(
    merge3Text(base, "标题\n一甲\n二\n三\n四\n五", "标题\n一乙\n二\n三\n四\n五")
      .conflict,
    true,
  );
  assert.deepEqual(merge3Text("a\nb", "x\na\nb", "a\nb\ny"), {
    text: "x\na\nb\ny",
    conflict: false,
  });
  const files = mergeFiles(
    { "SKILL.md": base, "old.md": "旧", "keep.md": "k" },
    { "SKILL.md": ours, "old.md": "旧", "keep.md": "k2" },
    { "SKILL.md": theirs, "new.md": "新", "keep.md": "k" },
  );
  assert.deepEqual(files, {
    files: {
      "SKILL.md": "标题\n一（审核人改）\n二\n三\n四\n五（执行者改）\n六",
      "keep.md": "k2",
      "new.md": "新",
    },
    conflicts: [],
  });
  assert.deepEqual(
    mergeFiles({ "a.md": "1" }, { "a.md": "2" }, {}).conflicts,
    ["a.md"],
    "一边删一边改",
  );
  assert.deepEqual(
    mergeFiles({}, { "a.md": "甲" }, { "a.md": "乙" }).conflicts,
    ["a.md"],
    "两边各自新增同名文件",
  );
  assert.deepEqual(
    filesDiff({ "a.md": "x\ny" }, { "a.md": "x\nz", "b.md": "新" }),
    ["修改 a.md", "  x", "- y", "+ z", "新增 b.md", "+ 新"],
  );
});

test("技能读写：修订只追加、乐观并发、权限看 owner 节点、回退追加新修订", () => {
  const db = setup();
  const created = add(db, "web-design", { owner: "atrium/web" }, "a1");
  assert.deepEqual(created, {
    slug: "web-design",
    rev: "r1",
    owner: "o3 atrium/web",
    files: 1,
  });
  assert.equal(add(db, "general").owner, "o1 org", "owner 默认根节点");
  assert.throws(() => add(db, "web-design"), /已存在/);
  assert.throws(
    () => add(db, "x", {}, "a1"),
    /新建技能无权限：a1 不是技能 owner o1/,
  );
  assert.throws(
    () => add(db, "y", { owner: "atrium/nope" }),
    /owner: 节点 atrium\/nope 不存在/,
  );
  assert.throws(() => add(db, "z", { reason: " " }), /reason 不能为空/);
  const v2 = {
    "SKILL.md": md("web-design", "前端设计约定", "按钮间距 8px"),
    "ref/colors.md": "暖灰",
  };
  assert.deepEqual(
    editSkill(
      db,
      "web-design",
      {
        files: v2,
        reason: "用户纠正：按钮间距又不对",
        source: "https://github.com/x/y/pull/1#r1",
      },
      "a1",
    ),
    { slug: "web-design", before: "r1", rev: "r2" },
  );
  assert.throws(
    () => editSkill(db, "web-design", { files: v2, reason: "再来一次" }, "u1"),
    /没有变化/,
  );
  assert.throws(
    () =>
      editSkill(
        db,
        "web-design",
        { name: "x", rev: "r1", reason: "过期" },
        "u1",
      ),
    /技能已是 r2，你基于 r1 修改/,
  );
  assert.throws(
    () => editSkill(db, "general", { name: "通用", reason: "改名" }, "a1"),
    /修改技能无权限/,
  );
  assert.throws(
    () =>
      editSkill(
        db,
        "web-design",
        { description: "只改简介", reason: "x" },
        "u1",
      ),
    /description 写在 SKILL.md 的 frontmatter 里/,
  );
  assert.throws(
    () =>
      editSkill(
        db,
        "web-design",
        {
          files: { "SKILL.md": md("web-design", "x"), "../evil": "y" },
          reason: "x",
        },
        "u1",
      ),
    /路径不合法/,
  );
  const history = skillHistory(db, "web-design");
  assert.deepEqual(
    history.items!.map((r) => [r.rev, r.author, r.reason, r.source]),
    [
      [
        "r2",
        "a1",
        "用户纠正：按钮间距又不对",
        "https://github.com/x/y/pull/1#r1",
      ],
      ["r1", "a1", "新建", null],
    ],
  );
  const detail = skillHistory(db, "web-design", { rev: "r2" });
  assert.ok(detail.diff!.includes("新增 ref/colors.md"));
  assert.deepEqual(detail.meta, [
    {
      field: "description",
      before: "web-design 的简介",
      after: "前端设计约定",
    },
  ]);
  assert.deepEqual(revertSkill(db, "web-design", "r1", "回到最初", "u1"), {
    slug: "web-design",
    before: "r2",
    rev: "r3",
    to: "r1",
  });
  assert.equal(
    listSkills(db).find((s) => s.slug === "web-design")!.description,
    "web-design 的简介",
  );
  assert.throws(
    () => revertSkill(db, "web-design", "r9", "x", "u1"),
    /没有修订 r9/,
  );
  assert.throws(
    () => db.prepare("UPDATE org_skill_revisions SET reason='改写历史'").run(),
    /append only/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM org_skills").run(),
    /archive only/,
  );
  // 绑定权限看被绑节点
  assert.deepEqual(bindSkill(db, "web-design", "atrium/web", "a1"), {
    slug: "web-design",
    node: "o3 atrium/web",
    bound: true,
  });
  assert.throws(
    () => bindSkill(db, "web-design", "atrium/web", "u1"),
    /已绑在 o3 atrium\/web/,
  );
  assert.throws(
    () => bindSkill(db, "general", "atrium/runtime", "a1"),
    /绑定无权限：a1 不是 o4/,
  );
  assert.throws(() => bindSkill(db, "nope", "o3", "u1"), /技能 nope 不存在/);
  editSkill(db, "general", { archive: true, reason: "不用了" }, "u1");
  assert.throws(() => bindSkill(db, "general", "o3", "u1"), /已归档，不能绑定/);
  assert.deepEqual(
    listSkills(db).map((s) => s.slug),
    ["web-design"],
  );
  assert.deepEqual(bindSkill(db, "web-design", "o3", "u1", true).bound, false);
  assert.throws(
    () => bindSkill(db, "web-design", "o3", "u1", true),
    /没有绑在/,
  );
  db.close();
});

const worker = (tool: Tool, rules: Record<string, unknown> = {}) => ({
  tool,
  id: tool,
  profile: { rules, body: "", layers: [], warnings: [] } as never,
});

test("派活挂载：按工具放进任务目录，不碰仓库与用户配置；重试保留改过的副本", async () => {
  const db = setup();
  add(db, "web-design", { owner: "atrium/web" });
  add(db, "org-wide");
  add(db, "codex-front", {
    files: {
      "SKILL.md": md("codex-front", "codex 做前端的补充"),
      "ref/grid.md": "栅格 8px",
    },
  });
  bindSkill(db, "web-design", "atrium/web", "u1");
  bindSkill(db, "org-wide", "o1", "u1");
  const data = mkdtempSync(join(tmpdir(), "atrium-skills-"));
  const home = join(data, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), "{}");
  writeFileSync(join(home, ".codex", "config.toml"), "model = 'x'");
  for (const own of ["my-own", "codex-front"]) {
    mkdirSync(join(home, ".codex", "skills", own), { recursive: true });
    writeFileSync(
      join(home, ".codex", "skills", own, "SKILL.md"),
      md(own, "用户自己的"),
    );
  }
  const mountedNote = (id: number) =>
    JSON.parse(
      String(
        getTask(db, `t${id}`).events.find((e) => e.kind === "skills_mounted")
          ?.detail,
      ),
    );
  try {
    const run = async (
      id: number,
      tool: Tool,
      rules: Record<string, unknown> = {},
    ) =>
      prepareRun(
        getTask(db, `t${id}`),
        { worker: worker(tool, rules), risk: "low" },
        {
          db,
          data,
          workersDir: data,
          env: { HOME: home },
        },
      );
    const t1 = createTask(db, { title: "改按钮", role: "atrium/web" }).id;
    const claude = await run(t1, "claude");
    const dir = join(data, "tasks", String(t1));
    const plugin = join(dir, "skills-plugin");
    assert.deepEqual(claude.launch.args.slice(-2), ["--plugin-dir", plugin]);
    assert.equal(claude.launch.env, undefined);
    assert.equal(
      JSON.parse(
        readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"),
      ).name,
      "atrium-skills",
    );
    assert.ok(existsSync(join(plugin, "skills", "web-design", "SKILL.md")));
    assert.ok(existsSync(join(plugin, "skills", "org-wide", "SKILL.md")));
    const prompt = readFileSync(claude.promptFile, "utf8");
    assert.match(
      prompt,
      /## 本次挂载的技能\n\n以下技能由组织维护，只对这次运行生效；已作为 Claude Code 插件技能加载/,
    );
    assert.ok(
      prompt.includes(
        `- org-wide（r1，来自 o1 org）：org-wide 的简介\n  文件：${join(plugin, "skills", "org-wide", "SKILL.md")}`,
      ),
    );
    assert.ok(prompt.includes("- web-design（r1，来自 o3 atrium/web）"));
    assert.ok(prompt.includes(join(dir, "skill-notes.md")));
    assert.deepEqual(mountedNote(t1), {
      worker: "claude",
      skills: ["org-wide@r1", "web-design@r1"],
    });

    // 执行者改了副本，然后同一任务重试：副本原样保留
    const copy = join(plugin, "skills", "web-design", "SKILL.md");
    writeFileSync(copy, md("web-design", "web-design 的简介", "按钮间距 12px"));
    await run(t1, "claude");
    assert.match(readFileSync(copy, "utf8"), /12px/);

    // codex：CODEX_HOME 指到任务目录，登录与配置软链回用户目录；档案 skills_for 命中节点
    const t2 = createTask(db, { title: "codex 改前端", role: "o3" }).id;
    const codex = await run(t2, "codex", {
      skills_for: { "atrium/web": ["codex-front"] },
      skills: ["ghost"],
    });
    const codexHome = join(data, "tasks", String(t2), "codex-home");
    assert.deepEqual(codex.launch.env, { CODEX_HOME: codexHome });
    assert.equal(
      readlinkSync(join(codexHome, "auth.json")),
      join(home, ".codex", "auth.json"),
    );
    assert.ok(lstatSync(join(codexHome, "config.toml")).isSymbolicLink());
    assert.ok(!existsSync(join(codexHome, "AGENTS.md")), "用户没有的文件不链");
    assert.equal(
      readlinkSync(join(codexHome, "skills", "my-own")),
      join(home, ".codex", "skills", "my-own"),
      "用户自己的 codex 技能照旧可用",
    );
    assert.ok(
      !lstatSync(join(codexHome, "skills", "codex-front")).isSymbolicLink(),
      "同名以组织技能为准",
    );
    assert.equal(
      readFileSync(
        join(codexHome, "skills", "codex-front", "ref", "grid.md"),
        "utf8",
      ),
      "栅格 8px",
    );
    assert.deepEqual(mountedNote(t2), {
      worker: "codex",
      skills: ["org-wide@r1", "web-design@r1", "codex-front@r1"],
      unknown: ["ghost"],
    });

    // opencode：OPENCODE_CONFIG_DIR；grok 没有原生技能，只给路径
    const t3 = createTask(db, { title: "别的", role: "atrium/runtime" }).id;
    const oc = await run(t3, "opencode");
    assert.deepEqual(oc.launch.env, {
      OPENCODE_CONFIG_DIR: join(data, "tasks", String(t3), "opencode"),
    });
    assert.ok(
      existsSync(
        join(
          data,
          "tasks",
          String(t3),
          "opencode",
          "skills",
          "org-wide",
          "SKILL.md",
        ),
      ),
    );
    assert.ok(
      !existsSync(
        join(data, "tasks", String(t3), "opencode", "skills", "web-design"),
      ),
      "runtime 不带 web 的技能",
    );
    const t4 = createTask(db, { title: "grok 干活", role: "o2" }).id;
    const grok = await run(t4, "grok");
    assert.equal(grok.launch.env, undefined);
    assert.ok(
      readFileSync(grok.promptFile, "utf8").includes(
        "没有原生加载，需要时读对应的 SKILL.md",
      ),
    );
    assert.ok(
      existsSync(
        join(data, "tasks", String(t4), "skills", "org-wide", "SKILL.md"),
      ),
    );

    // 没有任何技能的任务：提示词与调用与以前一样
    editSkill(db, "org-wide", { archive: true, reason: "停用" }, "u1");
    const t5 = createTask(db, { title: "旧任务" }).id;
    const plain = await run(t5, "claude");
    assert.ok(!plain.launch.args.includes("--plugin-dir"));
    assert.ok(
      !readFileSync(plain.promptFile, "utf8").includes("本次挂载的技能"),
    );
    assert.ok(!existsSync(join(data, "tasks", String(t5), "skills.json")));
    assert.deepEqual(skillsForTask(db, getTask(db, `t${t5}`)).skills, []);
  } finally {
    rmSync(data, { recursive: true, force: true });
    db.close();
  }
});

test("回收：改了副本生成提议，采纳写成作者为任务号的新修订；期间有别的修订就三方合并，冲突留给审核人", async () => {
  const db = setup();
  const base = md("web-design", "前端设计约定", "一\n二\n三\n四");
  add(db, "web-design", { owner: "atrium/web", files: { "SKILL.md": base } });
  bindSkill(db, "web-design", "o3", "u1");
  const data = mkdtempSync(join(tmpdir(), "atrium-skills-"));
  try {
    const launch = async (title: string) => {
      const id = createTask(db, { title, role: "o3" }).id;
      await prepareRun(
        getTask(db, `t${id}`),
        { worker: worker("codex"), risk: "low" },
        {
          db,
          data,
          workersDir: data,
          env: { HOME: data },
        },
      );
      const dir = join(data, "tasks", String(id));
      return {
        id,
        dir,
        file: join(dir, "codex-home", "skills", "web-design", "SKILL.md"),
      };
    };
    const untouched = await launch("没改技能");
    assert.deepEqual(collectSkillEdits(db, untouched.id, untouched.dir), {
      proposals: [],
      problems: [],
    });

    const a = await launch("改第一行");
    writeFileSync(
      a.file,
      md("web-design", "前端设计约定", "一（执行者改）\n二\n三\n四"),
    );
    writeFileSync(join(a.dir, "skill-notes.md"), "第一行的说法已过时");
    const first = collectSkillEdits(db, a.id, a.dir);
    assert.deepEqual(first.proposals, [
      {
        proposal: "p1",
        slug: "web-design",
        base: "r1",
        owner: { node: "o3 atrium/web", leader: "a1" },
      },
    ]);
    assert.deepEqual(
      collectSkillEdits(db, a.id, a.dir).proposals,
      [],
      "同样的内容不重复提",
    );
    assert.equal(showProposal(db, "p1").reason, "第一行的说法已过时");
    assert.ok(showProposal(db, "p1").diff.includes("+ 一（执行者改）"));

    const b = await launch("改最后一行");
    writeFileSync(
      b.file,
      md("web-design", "前端设计约定", "一\n二\n三\n四（另一个执行者改）"),
    );
    const c = await launch("也改第一行");
    writeFileSync(
      c.file,
      md("web-design", "前端设计约定", "一（冲突）\n二\n三\n四"),
    );
    const d = await launch("改坏了");
    writeFileSync(d.file, "没有 frontmatter 了");
    assert.equal(
      collectSkillEdits(db, b.id, b.dir).proposals[0]!.proposal,
      "p2",
    );
    assert.equal(
      collectSkillEdits(db, c.id, c.dir).proposals[0]!.proposal,
      "p3",
    );
    assert.match(
      collectSkillEdits(db, d.id, d.dir).problems[0]!,
      /web-design：改动不合规.*没生成提议/,
    );

    assert.throws(
      () => acceptProposal(db, "p1", undefined, "a9"),
      /--as|leader/,
    );
    assert.deepEqual(acceptProposal(db, "p1", undefined, "a1"), {
      ref: "p1",
      slug: "web-design",
      before: "r1",
      rev: "r2",
      merged: false,
    });
    const r2 = skillHistory(db, "web-design").items![0]!;
    assert.deepEqual(
      [r2.author, r2.reviewer, r2.source],
      [`t${a.id}`, "a1", "p1"],
    );
    assert.match(r2.reason, /^采纳 p1：第一行的说法已过时/);
    assert.throws(() => acceptProposal(db, "p1", undefined, "u1"), /p1 已采纳/);

    // p2 基于 r1，改的是别处：自动合并
    assert.equal(acceptProposal(db, "p2", "顺手合并", "u1").merged, true);
    assert.equal(
      JSON.parse(
        db.prepare("SELECT files FROM org_skills").get()!.files as string,
      )["SKILL.md"],
      md(
        "web-design",
        "前端设计约定",
        "一（执行者改）\n二\n三\n四（另一个执行者改）",
      ),
    );
    // p3 基于 r1，与 p1 改了同一行：冲突，留给审核人手工合并后写回
    assert.throws(
      () => acceptProposal(db, "p3", undefined, "u1"),
      /p3 基于 r1，技能已是 r3，合并有冲突：SKILL.md/,
    );
    assert.deepEqual(
      editSkill(
        db,
        "web-design",
        {
          files: {
            "SKILL.md": md(
              "web-design",
              "前端设计约定",
              "一（手工合并）\n二\n三\n四（另一个执行者改）",
            ),
          },
          rev: "r3",
          proposal: "p3",
          reason: "手工合并 p3",
        },
        "u1",
      ),
      { slug: "web-design", before: "r3", rev: "r4", proposal: "p3" },
    );
    assert.equal(skillHistory(db, "web-design").items![0]!.author, `t${c.id}`);
    assert.deepEqual(
      listProposals(db, { status: "all" }).map((p) => [
        p.ref,
        p.status,
        p.result,
      ]),
      [
        ["p3", "accepted", "r4"],
        ["p2", "accepted", "r3"],
        ["p1", "accepted", "r2"],
      ],
    );

    const e = await launch("再改");
    writeFileSync(e.file, md("web-design", "前端设计约定", "胡改"));
    collectSkillEdits(db, e.id, e.dir);
    assert.throws(() => rejectProposal(db, "p4", "", "u1"), /reason 不能为空/);
    assert.deepEqual(rejectProposal(db, "p4", "改错了", "a1"), {
      ref: "p4",
      slug: "web-design",
      status: "rejected",
    });
    assert.deepEqual(listProposals(db), []);
    assert.throws(() => showProposal(db, "x1"), /提议应写成 p1/);
  } finally {
    rmSync(data, { recursive: true, force: true });
    db.close();
  }
});

test("命令行读技能来源：目录跳过隐藏文件与符号链接，单个文件当作 SKILL.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-skill-src-"));
  try {
    writeFileSync(join(dir, "SKILL.md"), md("x", "y"));
    mkdirSync(join(dir, "ref"));
    writeFileSync(join(dir, "ref", "a.md"), "a");
    writeFileSync(join(dir, ".DS_Store"), "junk");
    assert.deepEqual(Object.keys(readSkillSource(dir)).sort(), [
      "SKILL.md",
      "ref/a.md",
    ]);
    assert.deepEqual(Object.keys(readSkillSource(join(dir, "SKILL.md"))), [
      "SKILL.md",
    ]);
    assert.throws(() => readSkillSource(join(dir, "ref")), /没有 SKILL.md/);
    assert.throws(() => readSkillSource(join(dir, "nope")), /读不到/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("运行时：派到节点的任务挂上技能，执行者改了副本，收尾生成提议并通知负责人，经接口采纳", async (t) => {
  const { startApp } = await import("./task-fixture.ts");
  const { fx, call } = await startApp(t, (fx) => {
    // 假 codex：按 CODEX_HOME 找到挂载的技能副本改一行、写原因，再在 worktree 里提交。
    const file = join(fx.root, "bin", "codex");
    writeFileSync(
      file,
      [
        "#!/bin/sh",
        "set -e",
        "cat > /dev/null",
        'f="$CODEX_HOME/skills/web-design/SKILL.md"',
        'printf -- "---\\nname: web-design\\ndescription: 前端设计约定\\n---\\n\\n按钮间距 12px\\n" > "$f"',
        'echo "8px 在新设计稿里不对" > "$CODEX_HOME/../skill-notes.md"',
        'env > "$PWD/../codex-env.txt"',
        "echo hi > done.txt",
        "git add done.txt",
        "git commit -qm done",
        'echo "完成，提交 $(git rev-parse --short HEAD)"',
      ].join("\n"),
    );
    execChmod(file);
  });
  const ok = async (method: "GET" | "POST", url: string, payload?: object) => {
    const response = await call(method, url, payload);
    assert.ok(
      response.status < 300,
      `${url}: ${JSON.stringify(response.body)}`,
    );
    return response.body;
  };
  await ok("POST", "/api/org/nodes", {
    slug: "org",
    kind: "org",
    name: "组织",
    reason: "建",
  });
  await ok("POST", "/api/org/nodes", {
    parent: "o1",
    slug: "atrium",
    kind: "project",
    name: "Atrium",
    reason: "建",
  });
  await ok("POST", "/api/org/nodes", {
    parent: "o2",
    slug: "web",
    kind: "module",
    name: "web",
    reason: "建",
  });
  await ok("POST", "/api/skills", {
    slug: "web-design",
    files: { "SKILL.md": md("web-design", "前端设计约定", "按钮间距 8px") },
    owner: "atrium/web",
    reason: "用户写给 codex 的前端约束",
  });
  // 破坏输入：路径穿越与 name 不一致都按字段名拒绝
  const bad = await call("POST", "/api/skills", {
    slug: "evil",
    files: { "SKILL.md": md("evil", "x"), "../../x": "y" },
    reason: "x",
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /files\.\.\.\/\.\.\/x 路径不合法/);
  assert.equal(
    (
      await call("POST", "/api/skills", {
        slug: "a",
        files: { "SKILL.md": md("b", "x") },
        reason: "x",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/api/skills?as=a9", {
        slug: "c",
        files: { "SKILL.md": md("c", "x") },
        reason: "x",
      })
    ).status,
    404,
  );
  await ok("POST", "/api/skills/web-design/bind", { node: "atrium/web" });
  await ok("POST", "/api/tasks", {
    title: "Adjust button",
    repo: fx.repo,
    role: "atrium/web",
  });
  await ok("POST", "/api/tasks/t1/run", { worker: "codex" });
  await ok("GET", "/api/tasks/t1/wait?timeout=20");
  const env = readFileSync(join(fx.root, "codex-env.txt"), "utf8");
  assert.match(env, /^CODEX_HOME=.*\/tasks\/1\/codex-home$/m);
  const proposals = await ok("GET", "/api/skill-proposals");
  assert.deepEqual(
    proposals.map(
      (p: { ref: string; skill: string; task: string; reason: string }) => [
        p.ref,
        p.skill,
        p.task,
        p.reason,
      ],
    ),
    [["p1", "web-design", "t1", "8px 在新设计稿里不对"]],
  );
  const events = await ok("GET", "/api/events/wait?as=secretary&timeout=0");
  const event = events.events.find(
    (e: { kind: string }) => e.kind === "skill_proposal",
  );
  assert.ok(event, JSON.stringify(events));
  assert.deepEqual(
    [event.task, event.detail.proposal, event.detail.owner, event.detail.next],
    [
      "t1",
      "p1",
      { node: "o3 atrium/web", leader: "u1" },
      "atrium skill proposal p1",
    ],
  );
  const accepted = await ok("POST", "/api/skill-proposals/p1/accept", {});
  assert.deepEqual([accepted.before, accepted.rev], ["r1", "r2"]);
  const history = await ok("GET", "/api/skills/web-design/history");
  assert.deepEqual(
    [
      history.items[0].author,
      history.items[0].reviewer,
      history.items[0].source,
    ],
    ["t1", "u1", "p1"],
  );
  // 技能文件没进仓库
  assert.equal(
    execGit(`${fx.repo}-t1-adjust-button`, "ls-files")
      .split("\n")
      .sort()
      .join(","),
    "README.md,done.txt",
  );
});

function execChmod(file: string) {
  chmodSync(file, 0o755);
}
function execGit(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
