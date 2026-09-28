import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { leaderRule } from "../server/leaders/scope.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { resolveWorker, splitDeliveryNotes } from "../server/tasks/profiles.ts";
import {
  editProfile,
  profileView,
} from "../server/tasks/worker-profile-edit.ts";
import {
  importWorkerProfiles,
  listProfiles,
  parseProfileRef,
  patchFront,
  profileHistory,
  profileNameProblem,
  PROFILE_MAX_BYTES,
  readProfile,
  writeProfile,
} from "../server/tasks/worker-profiles.ts";
import { profileDb } from "./profile-fixture.ts";
import { removeTemp } from "./temp-dir.ts";

function legacyDir(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "atrium-workers-legacy-"));
  t.after(() => removeTemp(dir));
  for (const sub of ["harness", "models", "combos"]) mkdirSync(join(dir, sub));
  const write = (file: string, text: string) =>
    writeFileSync(join(dir, file), text);
  write(
    "harness/codex.md",
    "---\nchecks: [pr_exists, finished]   # 注释\n---\n（工具层）按常规约束执行。\n",
  );
  write(
    "models/grok-4.6.md",
    "---\ntrust: medium\nmax_risk: low\n---\n别堆上帝组件。\n\n## 交付记录\n- 2026-09-27 一次通过\n\n## 叮嘱\n拆文件。\n",
  );
  write(
    "combos/opencode+mimo-v2.6-flash.md",
    "---\ntrust: low\nmodel: opencode-go/mimo-v2.6-flash\n---\n记得提交。\n",
  );
  // 个别行写错：照旧导入，只作警告（不丢整份档案的限制）。
  write("harness/kimi.md", "---\nmax_risk: low\n这行坏了\n---\n");
  // 坏记录：名字不合法、超限、软链接、空字符，各自跳过。
  write("harness/gemini.md", "---\ntrust: high\n---\n");
  write("models/big.md", "x".repeat(PROFILE_MAX_BYTES + 1));
  write("models/nul.md", "---\ntrust: low\n---\n\0");
  symlinkSync(join(dir, "harness/codex.md"), join(dir, "combos/codex+x.md"));
  write("combos/README.txt", "不是档案");
  return dir;
}

test("档案名与 层/名（纯函数）：合法的放行，破坏输入给原因", () => {
  assert.equal(profileNameProblem("harness", "codex"), null);
  // 不是内置工具的名字也可以（档案接入的新工具，#418），名字写法不对才拒。
  assert.equal(profileNameProblem("harness", "gemini"), null);
  assert.match(profileNameProblem("harness", "Gemini")!, /工具层/);
  assert.match(profileNameProblem("harness", "gemini+x")!, /工具层/);
  assert.equal(profileNameProblem("models", "gpt-6-sol"), null);
  assert.equal(profileNameProblem("models", "mimo-v2.6-flash"), null);
  assert.match(profileNameProblem("models", ".hidden")!, /模型层/);
  assert.match(profileNameProblem("models", "a/b")!, /模型层/);
  assert.match(profileNameProblem("models", "")!, /模型层/);
  assert.equal(profileNameProblem("combos", "codex+gpt-6-sol"), null);
  assert.match(profileNameProblem("combos", "codex")!, /组合层/);
  assert.match(profileNameProblem("combos", "nope+x")!, /组合层/);
  assert.match(profileNameProblem("combos", "codex+../x")!, /组合层/);
  assert.match(profileNameProblem("combos", "codex+.x")!, /组合层/);
  assert.deepEqual(parseProfileRef("combos/codex+gpt-6-sol"), {
    layer: "combos",
    name: "codex+gpt-6-sol",
  });
  for (const bad of [
    "codex",
    "tools/codex",
    "/etc/passwd",
    "harness/../x",
    "models/../../etc",
    "models/.ssh",
    "harness/",
  ])
    assert.throws(() => parseProfileRef(bad), /层|档案名/, bad);
});

test("patchFront（纯函数）：改、加、删一个键，没有 frontmatter 就补一段", () => {
  assert.equal(patchFront("", "trust", "low"), "---\ntrust: low\n---\n");
  assert.equal(
    patchFront("正文", "trust", "low"),
    "---\ntrust: low\n---\n\n正文",
  );
  assert.equal(patchFront("正文", "trust", undefined), "正文");
  const doc = "---\ntrust: low\nmax_risk: low\n---\n正文\n";
  assert.equal(
    patchFront(doc, "trust", "high"),
    "---\ntrust: high\nmax_risk: low\n---\n正文\n",
  );
  assert.equal(
    patchFront(doc, "checks", "[ci]"),
    "---\ntrust: low\nmax_risk: low\nchecks: [ci]\n---\n正文\n",
  );
  assert.equal(
    patchFront(doc, "trust", undefined),
    "---\nmax_risk: low\n---\n正文\n",
  );
  assert.equal(
    patchFront("---\ntrust: low\n---\n", "trust", undefined),
    "---\n---\n",
  );
  assert.equal(
    patchFront("---\n---\n正文", "trust", "low"),
    "---\ntrust: low\n---\n正文",
  );
  assert.throws(() => patchFront("---\ntrust: low\n", "trust", "x"), /不完整/);
});

test("splitDeliveryNotes（纯函数）：交付记录段作备注拆出，其余正文保留", () => {
  assert.deepEqual(splitDeliveryNotes("叮嘱"), { body: "叮嘱", notes: "" });
  assert.deepEqual(
    splitDeliveryNotes("叮嘱\n\n## 交付记录\n- 一次通过\n- 打回一次"),
    { body: "叮嘱", notes: "- 一次通过\n- 打回一次" },
  );
  assert.deepEqual(
    splitDeliveryNotes(
      "叮嘱\n## 交付记录\n- a\n### 细节\n- b\n## 其他\n拆文件",
    ),
    { body: "叮嘱\n## 其他\n拆文件", notes: "- a\n### 细节\n- b" },
  );
  // 正文里顺带提到「交付记录」不算标题。
  assert.deepEqual(splitDeliveryNotes("还没有交付记录。"), {
    body: "还没有交付记录。",
    notes: "",
  });
});

test("写档案留修订：内容没变不加修订，修订只增不改", () => {
  const db = profileDb();
  const first = writeProfile(db, {
    layer: "harness",
    name: "codex",
    source: "---\ntrust: low\n---\n",
    author: "u1",
    reason: "新建",
  });
  assert.deepEqual(first, { rev: 1, changed: true, created: true });
  assert.deepEqual(
    writeProfile(db, {
      layer: "harness",
      name: "codex",
      source: "---\ntrust: low\n---\n",
      author: "u1",
      reason: "没变",
    }),
    { rev: 1, changed: false, created: false },
  );
  writeProfile(db, {
    layer: "harness",
    name: "codex",
    source: "---\ntrust: high\n---\n",
    author: "a1",
    reason: "放宽",
  });
  assert.deepEqual(
    profileHistory(db, "harness", "codex").map((h) => [h.rev, h.author]),
    [
      [2, "a1"],
      [1, "u1"],
    ],
  );
  assert.throws(
    () => db.exec("DELETE FROM worker_profile_revisions"),
    /append only/,
  );
  assert.throws(
    () => db.exec("UPDATE worker_profile_revisions SET reason='x'"),
    /append only/,
  );
});

test("首次启动导入旧目录：坏记录跳过记日志、其余照常；幂等；导入后删目录一切照常", async (t) => {
  const dir = legacyDir(t);
  const db = profileDb();
  const logs: string[] = [];
  const result = importWorkerProfiles(db, dir, (m) => logs.push(m))!;
  assert.equal(result.imported, 4);
  assert.deepEqual(
    result.skipped
      .map((s) => relative(dir, s.file).split(sep).join("/"))
      .sort(),
    [
      "combos/codex+x.md",
      "harness/gemini.md",
      "models/big.md",
      "models/nul.md",
    ],
  );
  assert.equal(logs.filter((m) => m.includes("未导入")).length, 4);
  assert.match(logs.at(-1)!, /导入 4 份，跳过 4 份/);
  assert.deepEqual(
    listProfiles(db).map((p) => `${p.layer}/${p.name}`),
    [
      "harness/codex",
      "harness/kimi",
      "models/grok-4.6",
      "combos/opencode+mimo-v2.6-flash",
    ],
  );
  assert.equal(readProfile(db, "harness", "codex")!.updated_by, "import");
  // 再启动不再读目录：改了文件也不覆盖库里的。
  writeFileSync(join(dir, "harness/codex.md"), "---\ntrust: high\n---\n");
  assert.equal(
    importWorkerProfiles(db, dir, (m) => logs.push(m)),
    null,
  );
  assert.doesNotMatch(readProfile(db, "harness", "codex")!.source, /high/);

  removeTemp(dir);
  const grok = await resolveWorker("grok", db);
  assert.equal(grok.model, "grok-4.6");
  assert.equal(grok.profile.rules.max_risk, "low");
  assert.equal(grok.profile.rules.trust, "medium");
  // 交付记录段不进提示词，作备注保留。
  assert.equal(grok.profile.body, "别堆上帝组件。\n\n## 叮嘱\n拆文件。");
  assert.equal(grok.profile.layers[0]!.notes, "- 2026-09-27 一次通过");
  const kimi = await resolveWorker("kimi", db);
  assert.equal(kimi.profile.rules.max_risk, "low");
  assert.match(kimi.profile.warnings[0]!, /harness\/kimi：无法解析的行/);
  const oc = await resolveWorker("opencode+mimo-v2.6-flash", db);
  assert.equal(oc.cliModel, "opencode-go/mimo-v2.6-flash");
  assert.equal(oc.profile.rules.trust, "low");
  // 库里没有的：内置缺省。
  const claude = await resolveWorker("claude", db);
  assert.deepEqual(claude.profile.layers, []);
});

test("旧目录不存在：什么都不导入、不记导入，之后出现的目录仍可导入一次", (t) => {
  const db = profileDb();
  const missing = join(tmpdir(), "atrium-no-such-workers-dir");
  assert.equal(
    importWorkerProfiles(db, missing, () => {}),
    null,
  );
  assert.equal(
    importWorkerProfiles(db, undefined, () => {}),
    null,
  );
  const dir = legacyDir(t);
  assert.equal(importWorkerProfiles(db, dir, () => {})!.imported, 4);
});

test("改档案：整份替换或按字段改，校验不过不写，留修订", () => {
  const db = profileDb();
  const created = editProfile(
    db,
    "combos/codex+gpt-6-sol",
    {
      set: { trust: "medium", checks: "[pr_exists, finished]" },
      reason: "试用",
    },
    "u1",
  );
  assert.deepEqual(created, {
    ref: "combos/codex+gpt-6-sol",
    rev: 1,
    changed: true,
    created: true,
  });
  const view = profileView(db, "combos/codex+gpt-6-sol");
  assert.equal(view.trust, "medium");
  assert.deepEqual(view.checks, ["pr_exists", "finished"]);
  assert.equal(view.history[0]!.reason, "试用");
  editProfile(db, "combos/codex+gpt-6-sol", { unset: ["checks"] }, "u1");
  assert.equal(profileView(db, "combos/codex+gpt-6-sol").checks, null);
  const replaced = editProfile(
    db,
    "combos/codex+gpt-6-sol",
    { source: "---\ntrust: high\n---\n叮嘱\n\n## 交付记录\n- 好\n" },
    "u1",
  );
  assert.equal(replaced.rev, 3);
  const after = profileView(db, "combos/codex+gpt-6-sol");
  assert.equal(after.body, "叮嘱");
  assert.equal(after.notes, "- 好");
  assert.deepEqual(
    after.history.map((h) => h.reason),
    ["整份替换", "改字段 checks", "试用"],
  );
  // 破坏输入：一律 400，库里不变。
  const bad: [string, unknown, RegExp][] = [
    ["combos/codex+gpt-6-sol", { set: { trust: "bogus" } }, /trust 只能是/],
    ["combos/codex+gpt-6-sol", { source: "---\n坏行\n---\n" }, /无法解析的行/],
    [
      "combos/codex+gpt-6-sol",
      { source: "x".repeat(PROFILE_MAX_BYTES + 1) },
      /超过/,
    ],
    [
      "combos/codex+gpt-6-sol",
      { source: "a", set: { trust: "low" } },
      /二选一/,
    ],
    ["combos/codex+gpt-6-sol", {}, /二选一/],
    ["combos/codex+gpt-6-sol", { set: { "a b": "x" } }, /键不合法/],
    [
      "combos/codex+gpt-6-sol",
      { set: { trust: "low\nmax_risk: high" } },
      /一行/,
    ],
    ["harness/gemini", { set: { trust: "low" } }, /工具层/],
    ["harness/../../etc", { set: { trust: "low" } }, /工具层/],
  ];
  for (const [ref, body, pattern] of bad)
    assert.throws(() => editProfile(db, ref, body, "u1"), pattern);
  assert.equal(profileView(db, "combos/codex+gpt-6-sol").rev, 3);
  assert.throws(() => profileView(db, "models/nope"), /不存在/);
  // 新写不认识的关卡名（含已删掉的 ci）拒绝；库里原有的不挡改别的字段，视图照样提示。
  assert.throws(
    () =>
      editProfile(
        db,
        "combos/codex+gpt-6-sol",
        { set: { checks: "[pr_exists, ci]" } },
        "u1",
      ),
    /checks 里的 ci 不是关卡，派活时忽略/,
  );
  writeProfile(db, {
    layer: "harness",
    name: "codex",
    source: "---\ntrust: low\nchecks: [pr_exists, ci]\n---\n",
    author: "u1",
    reason: "旧档案",
  });
  editProfile(db, "harness/codex", { set: { trust: "medium" } }, "u1");
  const legacy = profileView(db, "harness/codex");
  assert.equal(legacy.trust, "medium");
  assert.match(legacy.warnings.join("\n"), /checks 里的 ci 不是关卡/);
});

test("接口：带旧运行时表的库启动时导入档案，ls/show/edit 走库，leader 不能改档案", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-profiles-app-"));
  t.after(() => removeTemp(data));
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(
    "CREATE TABLE deliveries (id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE agents (id TEXT PRIMARY KEY);",
  );
  legacy.close();
  const dir = legacyDir(t);
  const { app } = await createApp({
    data,
    tasks: { pace: async () => undefined, workersDir: dir },
  });
  t.after(() => app.close());
  const headers = {
    host: "127.0.0.1",
    authorization: `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`,
  };
  const call = async (method: "GET" | "PUT", url: string, payload?: object) => {
    const res = await app.inject({ method, url, headers, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const listed = await call("GET", "/api/workers/profiles");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.profiles.length, 4);
  const shown = await call("GET", "/api/workers/profiles/models/grok-4.6");
  assert.equal(shown.body.trust, "medium");
  assert.equal(shown.body.history[0].author, "import");
  const edited = await call(
    "PUT",
    `/api/workers/profiles/combos/${encodeURIComponent("codex+gpt-6-sol")}`,
    { set: { trust: "low" }, reason: "试用" },
  );
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.rev, 1);
  const effective = await call("GET", "/api/workers/codex+gpt-6-sol");
  assert.equal(effective.body.profile.rules.trust, "low");
  assert.equal(
    (
      await call("PUT", "/api/workers/profiles/harness/codex", {
        set: { trust: "nope" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("GET", "/api/workers/profiles/harness/..%2F..%2Fetc")).status,
    400,
  );
  assert.equal(leaderRule("PUT", "/api/workers/profiles/:layer/:name"), "deny");
  // 旧表原样保留。
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='deliveries'").get(),
  );
});
