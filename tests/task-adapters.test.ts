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
import { taskNode } from "../server/org/task-node.ts";
import { ensureOrgTables } from "../server/org/schema.ts";
import { addNode, editDoc } from "../server/org/write.ts";
import {
  ADAPTERS,
  ARG_PROMPT_MAX_BYTES,
  detectInstalled,
  TOOLS,
  type Tool,
} from "../server/tasks/adapters/index.ts";
import { parseFrontmatter } from "../server/tasks/frontmatter.ts";
import {
  mergeLayers,
  parseWorker,
  resolveWorker,
  type EffectiveProfile,
  type ProfileLayer,
} from "../server/tasks/profiles.ts";
import {
  buildPrompt,
  DEFAULT_RULES,
  loadRoleDocs,
  parsePace,
  pickWorker,
  readPace,
  slugify,
  spareByProvider,
  worktreePlan,
} from "../server/tasks/prepare.ts";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `atrium-${name}-`));
const base = {
  promptFile: "/tmp/t1/prompt.md",
  prompt: "修一个 bug",
  cwd: "/w/repo-t1-x",
};

test("适配器：各工具的真实调用参数", () => {
  assert.deepEqual(
    ADAPTERS.codex.build({ ...base, model: "gpt-6-sol", effort: "high" }),
    {
      command: "codex",
      args: [
        "exec",
        "-C",
        "/w/repo-t1-x",
        "-s",
        "danger-full-access",
        "-m",
        "gpt-6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "-o",
        "/tmp/t1/last-message.md",
        "-",
      ],
      cwd: "/w/repo-t1-x",
      stdin: "/tmp/t1/prompt.md",
      resultFile: "/tmp/t1/last-message.md",
    },
  );
  assert.deepEqual(
    ADAPTERS.opencode.build({ ...base, model: "opencode-go/mimo-v2.6-flash" }),
    {
      command: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--auto",
        "-m",
        "opencode-go/mimo-v2.6-flash",
        "--",
        "修一个 bug",
      ],
      cwd: "/w/repo-t1-x",
    },
  );
  assert.deepEqual(
    ADAPTERS.claude.build({ ...base, model: "opus", effort: "max" }),
    {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "opus",
        "--effort",
        "max",
      ],
      cwd: "/w/repo-t1-x",
      stdin: "/tmp/t1/prompt.md",
    },
  );
  assert.deepEqual(ADAPTERS.grok.build({ ...base, model: "grok-4.6" }), {
    command: "grok",
    args: [
      "-p",
      "修一个 bug",
      "-m",
      "grok-4.6",
      "--always-approve",
      "--cwd",
      "/w/repo-t1-x",
    ],
    cwd: "/w/repo-t1-x",
  });
  const kimi = ADAPTERS.kimi.build(base);
  assert.deepEqual(kimi, {
    command: "kimi",
    args: ["-p", "修一个 bug"],
    cwd: "/w/repo-t1-x",
  });
  assert.ok(
    !kimi.args.some(
      (arg) => arg === "-y" || arg === "--yolo" || arg === "--auto",
    ),
  );
});

test("适配器：数据声明齐全，opencode 同一时刻只跑一个", () => {
  for (const tool of TOOLS) {
    const adapter = ADAPTERS[tool];
    assert.equal(adapter.tool, tool);
    assert.ok(
      adapter.promptVia === "arg"
        ? adapter.maxPromptBytes === undefined || adapter.maxPromptBytes > 0
        : true,
    );
    assert.equal(adapter.exclusive, tool === "opencode");
    assert.ok(
      adapter.watchdog.startupMinutes > 0 && adapter.watchdog.idleMinutes > 0,
    );
  }
  assert.equal(ADAPTERS.codex.promptVia, "stdin");
  assert.equal(ADAPTERS.claude.promptVia, "stdin");
  assert.equal(ADAPTERS.opencode.quotaProvider, "opencode");
  assert.equal(ADAPTERS.codex.quotaProvider, "codex");
});

test("适配器：破坏输入被拒", () => {
  assert.throws(
    () => ADAPTERS.kimi.build({ ...base, effort: "high" }),
    /不支持指定思考强度/,
  );
  assert.throws(
    () => ADAPTERS.claude.build({ ...base, effort: "turbo" }),
    /思考强度只能是/,
  );
  assert.throws(
    () => ADAPTERS.grok.build({ ...base, cwd: "relative" }),
    /绝对路径/,
  );
  assert.throws(
    () => ADAPTERS.codex.build({ ...base, model: "gpt 6; rm -rf" }),
    /模型 id 不合法/,
  );
  assert.throws(
    () => ADAPTERS.opencode.build({ ...base, prompt: "  " }),
    /提示词为空/,
  );
  const huge = "字".repeat(ARG_PROMPT_MAX_BYTES / 3 + 10);
  assert.throws(
    () => ADAPTERS.grok.build({ ...base, prompt: huge }),
    /超过上限/,
  );
  // 走 stdin 的工具不受参数长度限制。
  assert.equal(
    ADAPTERS.codex.build({ ...base, prompt: huge }).stdin,
    base.promptFile,
  );
});

test("detectInstalled：只认 PATH 上可执行的文件", () => {
  const dir = temp("path");
  try {
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n");
    chmodSync(join(dir, "codex"), 0o755);
    writeFileSync(join(dir, "kimi"), "not executable");
    chmodSync(join(dir, "kimi"), 0o644);
    mkdirSync(join(dir, "grok"));
    assert.deepEqual(detectInstalled(`/nonexistent:${dir}`), {
      codex: join(dir, "codex"),
    });
    assert.deepEqual(detectInstalled(""), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frontmatter：档案里出现的写法", () => {
  const parsed = parseFrontmatter(`---
trust: medium
max_risk: low           # 只派小的
checks: [pr_exists, ci, file_growth]   # 注释
limits: {max_file_added_lines: 300, max_function_lines: 80}
invoke: opencode run -m <model> "<提示词>"（cwd 为工作目录）
cost: free
坏行
---
正文第一行
第二行 # 不是注释
`);
  assert.deepEqual(parsed.data, {
    trust: "medium",
    max_risk: "low",
    checks: ["pr_exists", "ci", "file_growth"],
    limits: { max_file_added_lines: 300, max_function_lines: 80 },
    invoke: 'opencode run -m <model> "<提示词>"（cwd 为工作目录）',
    cost: "free",
  });
  assert.equal(parsed.body, "正文第一行\n第二行 # 不是注释");
  assert.equal(parsed.warnings.length, 1);
  assert.deepEqual(parseFrontmatter("只有正文"), {
    data: {},
    body: "只有正文",
    warnings: [],
  });
});

test("parseWorker：工具+模型[:思考强度]", () => {
  assert.deepEqual(parseWorker("codex+gpt-6-sol:high"), {
    tool: "codex",
    model: "gpt-6-sol",
    effort: "high",
  });
  assert.deepEqual(parseWorker("opencode+opencode-go/mimo-v2.6-flash"), {
    tool: "opencode",
    model: "opencode-go/mimo-v2.6-flash",
    effort: undefined,
  });
  assert.deepEqual(parseWorker("claude"), {
    tool: "claude",
    model: undefined,
    effort: undefined,
  });
  assert.deepEqual(parseWorker("claude:max"), {
    tool: "claude",
    model: undefined,
    effort: "max",
  });
  assert.throws(() => parseWorker("gemini+x"), /未知的执行者工具/);
  assert.throws(() => parseWorker("codex+"), /模型不合法/);
  assert.throws(() => parseWorker("codex+../../etc/passwd"), /模型不合法/);
  assert.throws(() => parseWorker("codex+a/.hidden"), /模型不合法/);
  assert.throws(() => parseWorker("codex+gpt:HIGH!"), /思考强度不合法/);
});

const layer = (
  l: ProfileLayer["layer"],
  rules: ProfileLayer["rules"],
  body = "",
): ProfileLayer => ({
  layer: l,
  file: `${l}.md`,
  rules,
  body,
  warnings: [],
});

test("档案合并：后层覆盖，数值规则取更严", () => {
  const merged = mergeLayers([
    layer(
      "harness",
      {
        trust: "high",
        max_risk: "high",
        checks: ["pr_exists", "ci"],
        invoke: "a",
        limits: { max_function_lines: 60 },
      },
      "工具层",
    ),
    layer(
      "models",
      {
        trust: "medium",
        max_risk: "low",
        checks: ["ci", "file_growth"],
        limits: { max_file_added_lines: 300, max_function_lines: 80 },
        invoke: "b",
      },
      "模型层",
    ),
    layer(
      "combos",
      {
        trust: "high",
        max_risk: "medium",
        checks: ["finished"],
        limits: { max_file_added_lines: 500 },
        cost: "free",
      },
      "组合层",
    ),
  ]);
  assert.equal(merged.rules.trust, "medium");
  assert.equal(merged.rules.max_risk, "low");
  assert.deepEqual(merged.rules.checks, [
    "pr_exists",
    "ci",
    "file_growth",
    "finished",
  ]);
  assert.deepEqual(merged.rules.limits, {
    max_function_lines: 60,
    max_file_added_lines: 300,
  });
  assert.equal(merged.rules.invoke, "b");
  assert.equal(merged.rules.cost, "free");
  assert.equal(merged.body, "工具层\n\n模型层\n\n组合层");
  assert.deepEqual(mergeLayers([]).rules, {});
  // unknown 最低。
  assert.equal(
    mergeLayers([
      layer("harness", { trust: "high" }),
      layer("models", { trust: "unknown" }),
    ]).rules.trust,
    "unknown",
  );
});

test("resolveWorker：三层读取、默认模型与档案 model", async () => {
  const dir = temp("workers");
  try {
    for (const sub of ["harness", "models", "combos"])
      mkdirSync(join(dir, sub));
    writeFileSync(
      join(dir, "harness/opencode.md"),
      "---\nmodel: opencode-go/mimo-v2.6-flash\nchecks: [pr_exists, ci]\n---\n工具的坑",
    );
    writeFileSync(
      join(dir, "combos/opencode+mimo-v2.6-flash.md"),
      "---\ntrust: medium\nmax_risk: medium\nchecks: [finished, screenshots]\n---\n记得提交",
    );
    writeFileSync(
      join(dir, "harness/grok.md"),
      "---\nchecks: [pr_exists]\n---\n",
    );
    writeFileSync(
      join(dir, "models/grok-4.6.md"),
      "---\nmax_risk: low\nmodel: grok-4.6\nlimits: {max_file_added_lines: 300}\ntrust: bogus\n---\n别堆上帝组件",
    );

    const oc = await resolveWorker("opencode", dir);
    assert.equal(oc.model, "opencode-go/mimo-v2.6-flash");
    assert.equal(oc.cliModel, "opencode-go/mimo-v2.6-flash");
    assert.equal(oc.id, "opencode+opencode-go/mimo-v2.6-flash");
    assert.deepEqual(oc.profile.rules.checks, [
      "pr_exists",
      "ci",
      "finished",
      "screenshots",
    ]);
    assert.equal(oc.profile.rules.max_risk, "medium");
    assert.equal(oc.profile.body, "工具的坑\n\n记得提交");

    const gk = await resolveWorker("grok:high", dir);
    assert.equal(gk.model, "grok-4.6");
    assert.equal(gk.effort, "high");
    assert.equal(gk.profile.rules.max_risk, "low");
    assert.deepEqual(gk.profile.rules.limits, { max_file_added_lines: 300 });
    assert.equal(gk.profile.warnings.length, 1);
    assert.match(gk.profile.warnings[0], /trust/);

    // 目录里没有档案：退回适配器默认模型，规则为空。
    const cx = await resolveWorker("codex+gpt-6-astra", dir);
    assert.equal(cx.cliModel, "gpt-6-astra");
    assert.deepEqual(cx.profile.layers, []);
    const km = await resolveWorker("kimi", join(dir, "missing"));
    assert.equal(km.model, undefined);
    assert.equal(km.id, "kimi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPrompt：按段拼接，空段省略", () => {
  const prompt = buildPrompt({
    title: " 加登录 ",
    brief: "详述",
    roleDoc: "",
    rootDoc: "组织",
    profileBody: "叮嘱",
    rules: ["规则一"],
  });
  assert.equal(
    prompt,
    "# 任务：加登录\n\n## 任务详述\n\n详述\n\n## 组织说明（.agents/README.md）\n\n组织\n\n## 给你的额外叮嘱\n\n叮嘱\n\n## 通用约束\n\n- 规则一\n",
  );
  assert.ok(buildPrompt({ title: "x" }).includes(DEFAULT_RULES[1]));
  assert.throws(() => buildPrompt({ title: "  " }), /标题不能为空/);
});

test("loadRoleDocs：岗位说明只取节点章程，不读仓库部门文件", async () => {
  const repo = temp("repo");
  try {
    mkdirSync(join(repo, ".agents/modules"), { recursive: true });
    mkdirSync(join(repo, ".agents/concerns"), { recursive: true });
    writeFileSync(join(repo, ".agents/README.md"), "根说明");
    writeFileSync(join(repo, ".agents/modules/web.md"), "仓库里的旧 web 说明");
    writeFileSync(join(repo, ".agents/concerns/安全.md"), "仓库里的旧安全说明");
    const db = new DatabaseSync(":memory:");
    ensureOrgTables(db);
    addNode(
      db,
      { slug: "org", kind: "org", name: "组织", reason: "创建" },
      "u1",
    );
    addNode(
      db,
      {
        parent: "o1",
        slug: "atrium",
        kind: "project",
        name: "Atrium",
        repos: [repo],
        reason: "创建",
      },
      "u1",
    );
    addNode(
      db,
      {
        parent: "o2",
        slug: "web",
        kind: "module",
        name: "web",
        reason: "创建",
      },
      "u1",
    );
    editDoc(
      db,
      "o3",
      "charter",
      { fields: {}, body: "节点章程", reason: "导入" },
      "u1",
    );
    const node = (role: string) => taskNode(db, { node_id: null, role, repo });
    assert.deepEqual(await loadRoleDocs(repo, node("atrium/web")), {
      roleDoc: "节点章程",
      rootDoc: "根说明",
      rolePath: "o3",
    });
    for (const role of ["web", "modules/web", "o3"])
      assert.equal(
        (await loadRoleDocs(repo, node(role))).roleDoc,
        "节点章程",
        `旧写法 ${role} 在节点存在时取节点章程`,
      );
    assert.equal(node("concerns/安全"), undefined);
    assert.deepEqual(
      await loadRoleDocs(repo, node("concerns/安全")),
      { roleDoc: "", rootDoc: "根说明" },
      "没有节点时不回退读仓库文件",
    );
    db.close();
    assert.deepEqual(await loadRoleDocs(repo), {
      roleDoc: "",
      rootDoc: "根说明",
    });
    rmSync(join(repo, ".agents"), { recursive: true });
    assert.deepEqual(await loadRoleDocs(repo), { roleDoc: "", rootDoc: "" });
    await assert.rejects(loadRoleDocs("relative"), /绝对路径/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const profile = (max_risk?: "low" | "medium" | "high"): EffectiveProfile => ({
  rules: max_risk ? { max_risk } : {},
  body: "",
  layers: [],
  warnings: [],
});
const pace = (spare: Record<string, number | null>) =>
  Object.entries(spare).map(([providerId, sparePercent]) => ({
    providerId,
    sparePercent,
  }));

test("pickWorker：按富余选，跳过没装与风险不允许的", () => {
  const all = [...TOOLS];
  const byPace = pickWorker({
    installed: all,
    pace: pace({ claude: 10, codex: 50, opencode: 58.8, grok: 33, kimi: -39 }),
    risk: "low",
    profiles: {},
  });
  assert.deepEqual(
    [byPace.ok && byPace.tool, byPace.ok && byPace.basis],
    ["opencode", "pace"],
  );

  const risky = pickWorker({
    installed: all,
    pace: pace({ opencode: 58.8, claude: 54.3, codex: -6 }),
    risk: "high",
    profiles: {
      opencode: profile("medium"),
      claude: profile("high"),
      kimi: profile("low"),
    },
  });
  assert.ok(risky.ok);
  assert.equal(risky.tool, "claude");
  assert.deepEqual(
    risky.skipped.map((s) => s.tool),
    ["opencode", "kimi"],
  );

  // 同一 provider 多个窗口取最紧的。
  assert.equal(
    spareByProvider([
      ...pace({ codex: 80 }),
      { providerId: "codex", sparePercent: 5 },
    ]).get("codex"),
    5,
  );

  // 没有富余数据的工具排在有数据的之后。
  const partial = pickWorker({
    installed: ["claude", "grok"],
    pace: pace({ grok: -20 }),
    risk: "low",
    profiles: {},
  });
  assert.ok(partial.ok && partial.tool === "grok");
});

test("pickWorker：已用额度触及保留线时跳过，边界与多窗口都生效", () => {
  const chosen = pickWorker({
    installed: ["grok", "codex", "kimi"],
    pace: [
      { providerId: "grok", usedPercent: 79.9, sparePercent: 1 },
      { providerId: "codex", usedPercent: 79, sparePercent: 60 },
      { providerId: "codex", usedPercent: 80, sparePercent: 80 },
      { providerId: "kimi", usedPercent: null, sparePercent: 70 },
    ],
    risk: "low",
    profiles: {},
  });
  assert.ok(chosen.ok);
  assert.equal(chosen.tool, "kimi");
  assert.deepEqual(chosen.available, ["kimi", "grok"]);
  assert.match(
    chosen.skipped.find((skip) => skip.tool === "codex")!.reason,
    /80%.*留 20%/,
  );
  const stricter = pickWorker({
    installed: ["grok", "codex"],
    pace: [
      { providerId: "grok", usedPercent: 79.9, sparePercent: 1 },
      { providerId: "codex", usedPercent: 79, sparePercent: 60 },
    ],
    risk: "low",
    profiles: {},
    reservePercent: 25,
  });
  assert.equal(stricter.ok, false);
});

test("pickWorker：pace 缺失按固定顺序，全部没装报不可用", () => {
  const fallback = pickWorker({
    installed: { codex: "/bin/codex", kimi: "/bin/kimi" },
    risk: "low",
    profiles: {},
  });
  assert.ok(fallback.ok);
  assert.deepEqual([fallback.tool, fallback.basis], ["codex", "fallback"]);
  const onlyNull = pickWorker({
    installed: ["grok", "opencode"],
    pace: pace({ grok: null }),
    risk: "low",
    profiles: {},
  });
  assert.ok(
    onlyNull.ok &&
      onlyNull.tool === "opencode" &&
      onlyNull.basis === "fallback",
  );

  const none = pickWorker({
    installed: [],
    pace: pace({ claude: 90 }),
    risk: "low",
    profiles: {},
  });
  assert.equal(none.ok, false);
  assert.equal(none.skipped.length, TOOLS.length);
  const blocked = pickWorker({
    installed: ["kimi"] as Tool[],
    risk: "medium",
    profiles: { kimi: profile("low") },
  });
  assert.equal(blocked.ok, false);
  assert.throws(
    () => pickWorker({ installed: [], risk: "extreme" as "low", profiles: {} }),
    /risk/,
  );
});

test("readPace / parsePace：失败返回 undefined", async () => {
  assert.equal(await readPace("/nonexistent/openquota"), undefined);
  const dir = temp("pace");
  try {
    const bin = join(dir, "openquota");
    writeFileSync(
      bin,
      `#!/bin/sh\necho '[{"providerId":"codex","sparePercent":12.5,"usedPercent":89,"windowId":"weekly"},{"providerId":"copilot","sparePercent":null}]'\n`,
    );
    chmodSync(bin, 0o755);
    assert.deepEqual(await readPace(bin), [
      {
        providerId: "codex",
        sparePercent: 12.5,
        usedPercent: 89,
        windowId: "weekly",
      },
      {
        providerId: "copilot",
        sparePercent: null,
        usedPercent: null,
        windowId: null,
      },
    ]);
    writeFileSync(bin, "#!/bin/sh\necho oops\n");
    assert.equal(await readPace(bin), undefined);
    writeFileSync(bin, "#!/bin/sh\nexit 3\n");
    assert.equal(await readPace(bin), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(parsePace('{"a":1}'), undefined);
  assert.deepEqual(parsePace('[1, {"providerId": 2}]'), []);
});

test("worktreePlan：路径、分支与 slug", () => {
  assert.deepEqual(worktreePlan("/repo/atrium", 12, "Add Login Page!"), {
    path: "/repo/atrium-t12-add-login-page",
    branch: "task-t12-add-login-page",
    slug: "add-login-page",
  });
  assert.equal(
    worktreePlan("/repo/atrium/", 3, "修复 登录").path,
    "/repo/atrium-t3-task",
  );
  // 中文标题滤不出内容：依次用 role、再用 task，分支不再全是 task-tN-task。
  assert.equal(
    worktreePlan("/repo/atrium/", 2, "修复 登录", "modules/cli").branch,
    "task-t2-modules-cli",
  );
  assert.equal(
    worktreePlan("/repo/atrium/", 4, "修复 登录", "安全").slug,
    "task",
    "role 也滤不出内容时才退回 task",
  );
  assert.equal(
    worktreePlan("/repo/atrium/", 6, "修复 登录", "concerns/安全").slug,
    "concerns",
    "role 整体转 slug：滤掉的部分不留残渣",
  );
  assert.equal(
    worktreePlan("/repo/atrium/", 5, "Add 登录", "modules/cli").branch,
    "task-t5-add",
    "标题有内容时不用 role",
  );
  assert.equal(slugify("修复 登录"), "task");
  assert.equal(slugify("Café  --  API v2 / 中文"), "cafe-api-v2");
  const long = slugify("a".repeat(30) + " " + "b".repeat(30));
  assert.equal(
    long.length <= 40 && /^[a-z0-9-]+$/.test(long) && !long.endsWith("-"),
    true,
  );
  assert.equal(slugify("x".repeat(39) + " yyy"), "x".repeat(39));
  assert.throws(() => worktreePlan("repo", 1, "x"), /绝对路径/);
  assert.throws(() => worktreePlan("/repo", 0, "x"), /任务编号/);
});
