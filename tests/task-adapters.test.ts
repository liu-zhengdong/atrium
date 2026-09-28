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
import { delimiter, join } from "node:path";
import {
  ADAPTERS,
  ARG_PROMPT_MAX_BYTES,
  detectInstalled,
  TOOLS,
  type Tool,
} from "../server/tasks/adapters/index.ts";
import { parseFrontmatter } from "../server/tasks/frontmatter.ts";
import { profileDb } from "./profile-fixture.ts";
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
  loadRootDoc,
  parsePace,
  pickWorker,
  readPace,
  slugify,
  spareByProvider,
  worktreePlan,
} from "../server/tasks/prepare.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { removeTemp } from "./temp-dir.ts";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `atrium-${name}-`));
/** codex 的最后消息文件放在提示词旁（按平台拼路径）。 */
const LAST_MESSAGE = join("/tmp/t1", "last-message.md");
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
        LAST_MESSAGE,
        "-",
      ],
      cwd: "/w/repo-t1-x",
      stdin: "/tmp/t1/prompt.md",
      resultFile: LAST_MESSAGE,
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
    const codex = writeFakeBin(join(dir, "codex"), "#!/bin/sh\n");
    writeFileSync(join(dir, "kimi"), "not executable");
    chmodSync(join(dir, "kimi"), 0o644);
    mkdirSync(join(dir, "grok"));
    assert.deepEqual(detectInstalled(`/nonexistent${delimiter}${dir}`), {
      codex,
    });
    assert.deepEqual(detectInstalled(""), {});
  } finally {
    removeTemp(dir);
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
  file: `${l}/x`,
  rev: 1,
  rules,
  body,
  notes: "",
  warnings: [],
});

test("档案合并：后层覆盖，trust、max_risk、checks、limits 以最具体一层为准", () => {
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
  // 组合层放宽了模型层的 trust、max_risk，checks、limits 整项取组合层。
  assert.equal(merged.rules.trust, "high");
  assert.equal(merged.rules.max_risk, "medium");
  assert.deepEqual(merged.rules.checks, ["finished"]);
  assert.deepEqual(merged.rules.limits, { max_file_added_lines: 500 });
  assert.equal(merged.rules.invoke, "b");
  assert.equal(merged.rules.cost, "free");
  assert.equal(merged.body, "工具层\n\n模型层\n\n组合层");
  assert.deepEqual(mergeLayers([]).rules, {});
  assert.equal(
    mergeLayers([
      layer("harness", { trust: "high" }),
      layer("models", { trust: "unknown" }),
    ]).rules.trust,
    "unknown",
  );
  // 后层没写的沿用前层；写空的 checks、limits 表示撤销前层的加查与上限。
  const relaxed = mergeLayers([
    layer("harness", {
      trust: "low",
      max_risk: "low",
      checks: ["pr_exists", "file_growth"],
      limits: { max_file_added_lines: 300 },
    }),
    layer("models", { trust: "medium" }),
    layer("combos", { checks: [], limits: {} }),
  ]).rules;
  assert.equal(relaxed.trust, "medium");
  assert.equal(relaxed.max_risk, "low");
  assert.deepEqual(relaxed.checks, []);
  assert.deepEqual(relaxed.limits, {});
  // billing 任一层是 metered 就按 metered（花钱与否是事实，不随层放宽）。
  assert.equal(
    mergeLayers([
      layer("harness", { billing: "metered" }),
      layer("combos", { billing: "subscription" }),
    ]).rules.billing,
    "metered",
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

    const db = profileDb(dir);
    const oc = await resolveWorker("opencode", db);
    assert.equal(oc.model, "opencode-go/mimo-v2.6-flash");
    assert.equal(oc.cliModel, "opencode-go/mimo-v2.6-flash");
    assert.equal(oc.id, "opencode+opencode-go/mimo-v2.6-flash");
    // checks 取最具体的组合层；工具层的 ci 不再是关卡，解析时提示。
    assert.deepEqual(oc.profile.rules.checks, ["finished", "screenshots"]);
    assert.equal(oc.profile.warnings.length, 1);
    assert.match(
      oc.profile.warnings[0]!,
      /harness\/opencode：checks 里的 ci 不是关卡，派活时忽略/,
    );
    assert.equal(oc.profile.rules.max_risk, "medium");
    assert.equal(oc.profile.body, "工具的坑\n\n记得提交");

    const gk = await resolveWorker("grok:high", db);
    assert.equal(gk.model, "grok-4.6");
    assert.equal(gk.effort, "high");
    assert.equal(gk.profile.rules.max_risk, "low");
    assert.deepEqual(gk.profile.rules.limits, { max_file_added_lines: 300 });
    assert.equal(gk.profile.warnings.length, 1);
    assert.match(gk.profile.warnings[0], /trust/);

    // 库里没有档案：退回适配器默认模型，规则为空。
    const cx = await resolveWorker("codex+gpt-6-astra", db);
    assert.equal(cx.cliModel, "gpt-6-astra");
    assert.deepEqual(cx.profile.layers, []);
    const km = await resolveWorker("kimi", profileDb(join(dir, "missing")));
    assert.equal(km.model, undefined);
    assert.equal(km.id, "kimi");
  } finally {
    removeTemp(dir);
  }
});

test("buildPrompt：按段拼接，空段省略", () => {
  const prompt = buildPrompt({
    title: " 加登录 ",
    brief: "详述",
    role: "",
    points: "规矩（…）：\n[组织]\n1. 不花钱",
    rootDoc: "组织",
    rules: ["规则一"],
  });
  assert.equal(
    prompt,
    "# 任务：加登录\n\n## 任务详述\n\n详述\n\n## 规矩\n\n规矩（…）：\n[组织]\n1. 不花钱\n\n## 组织说明（.agents/README.md）\n\n组织\n\n## 通用约束\n\n- 规则一\n",
  );
  // 端到端验证在交付前、在隔离环境里跑，输出贴进 PR。
  assert.match(
    buildPrompt({ title: "x" }),
    /交付前做端到端验证：在隔离环境里.*原样贴进 PR 正文「## 端到端验证」一节/,
  );
  assert.ok(buildPrompt({ title: "x" }).includes(DEFAULT_RULES[1]));
  // 组合说明（t236）：执行者在 PR 正文写「碰到哪些已有能力」，没碰到写「无」。
  assert.match(
    buildPrompt({ title: "x" }),
    /PR 正文写「## 碰到哪些已有能力」一节.*没碰到写「无」/,
  );
  assert.throws(() => buildPrompt({ title: "  " }), /标题不能为空/);
});

test("loadRootDoc：只读仓库根的 .agents/README.md，不读部门文件", async () => {
  const repo = temp("repo");
  try {
    mkdirSync(join(repo, ".agents/modules"), { recursive: true });
    writeFileSync(join(repo, ".agents/README.md"), "根说明");
    writeFileSync(join(repo, ".agents/modules/web.md"), "仓库里的旧 web 说明");
    assert.equal(await loadRootDoc(repo), "根说明");
    rmSync(join(repo, ".agents"), { recursive: true });
    assert.equal(await loadRootDoc(repo), "");
    await assert.rejects(loadRootDoc("relative"), /绝对路径/);
  } finally {
    removeTemp(repo);
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

  // 旧数不算富余：有新数的排在旧数之前；只剩旧数时整体按固定顺序。
  const stale = pickWorker({
    installed: ["claude", "grok", "kimi"],
    pace: [
      { providerId: "claude", sparePercent: -30, stale: true },
      { providerId: "grok", sparePercent: 90, stale: true },
      { providerId: "kimi", sparePercent: 5 },
    ],
    risk: "low",
    profiles: {},
  });
  assert.ok(stale.ok);
  assert.deepEqual(stale.available, ["kimi", "claude", "grok"]);
  assert.equal(stale.basis, "pace");
  const allStale = pickWorker({
    installed: ["claude", "grok"],
    pace: [
      { providerId: "claude", sparePercent: -30, stale: true },
      { providerId: "grok", sparePercent: 90, stale: true },
    ],
    risk: "low",
    profiles: {},
  });
  assert.ok(allStale.ok);
  assert.deepEqual(
    [allStale.tool, allStale.basis, allStale.spare],
    ["claude", "fallback", undefined],
  );
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
    const bin = writeFakeBin(
      join(dir, "openquota"),
      `#!/bin/sh\necho '[{"providerId":"codex","sparePercent":12.5,"usedPercent":89,"windowId":"weekly"},{"providerId":"copilot","sparePercent":null}]'\n`,
    );
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
    writeFakeBin(join(dir, "openquota"), "#!/bin/sh\necho oops\n");
    assert.equal(await readPace(bin), undefined);
    writeFakeBin(join(dir, "openquota"), "#!/bin/sh\nexit 3\n");
    assert.equal(await readPace(bin), undefined);
  } finally {
    removeTemp(dir);
  }
  assert.equal(parsePace('{"a":1}'), undefined);
  assert.deepEqual(parsePace('[1, {"providerId": 2}]'), []);
  assert.deepEqual(
    parsePace(
      '[{"providerId":"cursor","sparePercent":40,"stale":true,"refreshedHoursAgo":3.2},{"providerId":"grok","sparePercent":1,"stale":"yes"},{"providerId":"kimi","sparePercent":2,"stale":true}]',
    ),
    [
      {
        providerId: "cursor",
        sparePercent: 40,
        usedPercent: null,
        windowId: null,
        stale: true,
        refreshedHoursAgo: 3.2,
      },
      {
        providerId: "grok",
        sparePercent: 1,
        usedPercent: null,
        windowId: null,
      },
      {
        providerId: "kimi",
        sparePercent: 2,
        usedPercent: null,
        windowId: null,
        stale: true,
        refreshedHoursAgo: null,
      },
    ],
  );
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
    "role 整体转 slug：滤掉的部门不留残渣",
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
