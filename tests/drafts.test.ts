import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { createApp } from "../server/app.ts";
import { addNode, charterFields } from "../server/org/write.ts";
import { editMap } from "../server/map/write.ts";
import {
  changesOf,
  DRAFT_FILE,
  draftBrief,
  githubSlug,
  isSecretName,
  parseDraft,
  stripUserinfo,
  type Materials,
} from "../server/drafts/plan.ts";
import { checkRepo, repoMaterials } from "../server/drafts/materials.ts";
import { renderDraft } from "../cli/drafts.ts";
import type { DraftView } from "../server/drafts/store.ts";
import { fixture, until } from "./task-fixture.ts";

test("像凭据的文件名：环境变量、密钥证书、登录配置、名字带 secret / credential 的都算", () => {
  for (const name of [
    ".env",
    ".env.local",
    "env.production",
    "server.pem",
    "tls.key",
    "store.p12",
    "release.keystore",
    "id_rsa",
    "id_ed25519.pub",
    ".npmrc",
    "netrc",
    ".git-credentials",
    "secrets.json",
    "secret.yaml",
    "aws-credentials",
    "db_password.txt",
    "private-key.txt",
    "service-account-prod.json",
  ])
    assert.equal(isSecretName(name), true, name);
  for (const name of [
    "README.md",
    "src",
    "environment.ts",
    "keyboard.ts",
    "tokenizer.ts",
    "secretary.ts",
    "package.json",
    "monkey.ts",
    "id.ts",
  ])
    assert.equal(isSecretName(name), false, name);
});

test("origin：去掉内嵌凭据，认出 GitHub 的 owner/name", () => {
  assert.equal(
    stripUserinfo("https://me:ghp_secret@github.com/a/b.git\n"),
    "https://github.com/a/b.git",
  );
  assert.equal(
    stripUserinfo("git@github.com:a/b.git"),
    "git@github.com:a/b.git",
  );
  assert.equal(githubSlug("https://github.com/a/b.git"), "a/b");
  assert.equal(githubSlug("https://github.com/a/b"), "a/b");
  assert.equal(githubSlug("git@github.com:a/b.git"), "a/b");
  assert.equal(githubSlug("ssh://git@github.com/a/b-c.d.git"), "a/b-c.d");
  assert.equal(githubSlug("https://gitlab.com/a/b.git"), null);
  assert.equal(githubSlug("/tmp/origin.git"), null);
  assert.equal(githubSlug(null), null);
});

const good = {
  name: "OpenQuota",
  alias: "额度表",
  analogy: "像看流量还剩多少",
  what: "看清各家订阅还剩多少额度。",
  uses: ["看额度", " 换人 "],
  flow: ["读登录", "问用量", "汇总"],
  parts: [{ name: "读取器", analogy: "去各家查用量" }, { name: "汇总表" }],
};

test("初稿文件：缺了、空的、坏 JSON、不是对象、字段不合格都给中文原因；合格的去空白、忽略未知字段", () => {
  const error = (raw: string | null) => {
    const parsed = parseDraft(raw);
    assert.equal(parsed.ok, false, String(raw));
    return (parsed as { error: string }).error;
  };
  assert.match(error(null), new RegExp(`没有在工作目录写 ${DRAFT_FILE}`));
  assert.match(error("  \n"), /是空的/);
  assert.match(error("{oops"), /不是合法的 JSON/);
  assert.match(error("[1]"), /应为 JSON 对象/);
  assert.match(error("{}"), /what 必填；uses 应为文本列表；flow 应为文本列表/);
  assert.match(
    error(JSON.stringify({ ...good, what: "长".repeat(301) })),
    /what 超过 300 字/,
  );
  assert.match(
    error(JSON.stringify({ ...good, uses: ["", "  "] })),
    /uses 至少写一条/,
  );
  assert.match(
    error(JSON.stringify({ ...good, flow: Array(13).fill("步") })),
    /flow 超过 12 条/,
  );
  assert.match(
    error(JSON.stringify({ ...good, uses: [1] })),
    /uses\[0\] 应为文本/,
  );
  assert.match(error(JSON.stringify({ ...good, alias: 3 })), /alias 应为文本/);
  assert.match(
    error(JSON.stringify({ ...good, parts: [{ analogy: "x" }, "y"] })),
    /parts\[0\]\.name 必填；parts\[1\] 应为/,
  );
  assert.match(
    error(JSON.stringify({ ...good, parts: Array(13).fill({ name: "x" }) })),
    /parts 超过 12 块/,
  );
  assert.match(
    error(JSON.stringify({ ...good, parts: [{ name: "名".repeat(41) }] })),
    /parts\[0\]\.name 超过 40 字/,
  );
  const ok = parseDraft(
    `﻿${JSON.stringify({ ...good, extra: "忽略", alias: "  " })}`,
  );
  assert.equal(ok.ok, true);
  const draft = (ok as { draft: Record<string, unknown> }).draft;
  assert.deepEqual(draft, {
    name: "OpenQuota",
    analogy: "像看流量还剩多少",
    what: "看清各家订阅还剩多少额度。",
    uses: ["看额度", "换人"],
    flow: ["读登录", "问用量", "汇总"],
    parts: [{ name: "读取器", analogy: "去各家查用量" }, { name: "汇总表" }],
  });
  // parts 可省。
  const { parts: _parts, ...noParts } = good;
  const bare = parseDraft(JSON.stringify(noParts));
  assert.equal(bare.ok, true);
  assert.deepEqual((bare as { draft: { parts: unknown[] } }).draft.parts, []);
});

test("写入前的对比：只列会变的字段，没写过的标原来没写，组成部分不算字段", () => {
  const draft = (parseDraft(JSON.stringify(good)) as { draft: any }).draft;
  assert.deepEqual(
    changesOf({ what: "看清各家订阅还剩多少额度。", uses: ["旧"] }, draft).map(
      (c) => [c.field, c.before],
    ),
    [
      ["alias", null],
      ["analogy", null],
      ["uses", ["旧"]],
      ["flow", null],
    ],
  );
  assert.deepEqual(changesOf({ ...draft }, draft), []);
});

const materials = (over: Partial<Materials> = {}): Materials => ({
  repo: "/r/demo",
  name: "demo",
  origin: "https://github.com/me/demo.git",
  readme: { file: "README.md", text: "# demo\n一个示例", truncated: false },
  tree: ["README.md", "src/", "  src/main.ts"],
  tree_truncated: false,
  skipped: 2,
  commits: ["abc1234 2026-09-27 首次提交"],
  ...over,
});

test("起草详述：只读与不碰凭据的规矩在前，交付格式、材料在后；GitHub 仓库给 issue 命令，空材料写（没有）", () => {
  const brief = draftBrief(materials());
  assert.match(brief, /起草「demo」这一块的人话介绍。仓库在 \/r\/demo/);
  assert.match(brief, /只读仓库：不改、不删、不新建/);
  assert.match(brief, /不碰凭据：不打开 \.env/);
  assert.match(brief, new RegExp(`写 ${DRAFT_FILE.replace(".", "\\.")}`));
  assert.match(brief, /gh issue list -R me\/demo --state open --limit 30/);
  assert.match(brief, /### README（README\.md）\n# demo\n一个示例/);
  assert.match(
    brief,
    /### 目录（两层；2 个像凭据的文件没列）\nREADME\.md\nsrc\//,
  );
  assert.match(brief, /- abc1234 2026-09-27 首次提交/);
  assert.ok(brief.indexOf("## 交付") < brief.indexOf("## 材料"));
  const bare = draftBrief(
    materials({
      origin: null,
      readme: null,
      tree: [],
      skipped: 0,
      commits: [],
      tree_truncated: true,
    }),
  );
  assert.match(bare, /origin 不是 GitHub，没有可查的 issue/);
  assert.match(bare, /### README\n（没有）/);
  assert.match(bare, /### 目录（两层，太多只列了前面）\n（没有）/);
  assert.match(bare, /### 最近提交（新的在前）\n（没有）/);
  const long = draftBrief(
    materials({
      readme: { file: "readme.txt", text: "x", truncated: true },
    }),
  );
  assert.match(long, /### README（readme\.txt，只取了开头）/);
});

test("仓库路径：要绝对路径、不含 ..、存在且是目录", (t) => {
  const fx = fixture(t);
  assert.throws(() => checkRepo(""), /仓库路径: 必填/);
  assert.throws(() => checkRepo(3), /仓库路径: 必填/);
  assert.throws(() => checkRepo("repo"), /应为绝对路径/);
  assert.throws(
    () => checkRepo(`${fx.repo}${sep}..${sep}repo`),
    /不能包含 \.\./,
  );
  assert.throws(() => checkRepo(join(fx.root, "nope")), /不存在/);
  assert.throws(() => checkRepo(join(fx.repo, "README.md")), /不是目录/);
  assert.equal(checkRepo(` ${fx.repo} `), fx.repo);
});

/** 在夹具仓库里放凭据类文件、依赖目录、软链接与带令牌的 README，并提交。 */
function seedRepo(repo: string, outside: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, HOME: join(repo, "..", "home") },
    }).trim();
  writeFileSync(
    join(repo, "README.md"),
    "# demo\n看额度的小工具。\nAPI_TOKEN=abcdef123456 例子\n",
  );
  writeFileSync(join(repo, ".env"), "OPENAI_API_KEY=sk-leak-leak-leak-leak\n");
  writeFileSync(join(repo, "secrets.json"), '{"k":"leak"}');
  writeFileSync(join(repo, "server.pem"), "leak");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "main.ts"), "export {};\n");
  writeFileSync(join(repo, "src", "id_rsa"), "leak");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(repo, ".github"));
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "stolen.txt"), "leak");
  try {
    symlinkSync(outside, join(repo, "linked"), "junction");
  } catch {
    /* 没有建软链接的权限（Windows）就不测这一条。 */
  }
  git("add", "README.md", "src/main.ts", ".gitignore");
  git("commit", "-qm", "加入额度读取");
  git(
    "remote",
    "set-url",
    "origin",
    "https://me:ghp_abcdefghijklmnopqrstuvwx@github.com/me/demo.git",
  );
}

test("材料：README 开头抹掉令牌，目录不列隐藏、凭据类与软链接，依赖目录不展开，origin 去掉凭据", async (t) => {
  const fx = fixture(t);
  seedRepo(fx.repo, join(fx.root, "outside"));
  const m = await repoMaterials(fx.repo);
  assert.equal(m.name, "repo");
  assert.equal(m.origin, "https://github.com/me/demo.git");
  assert.equal(m.readme?.file, "README.md");
  assert.match(m.readme!.text, /看额度的小工具/);
  assert.doesNotMatch(m.readme!.text, /abcdef123456/);
  assert.deepEqual(m.tree, ["README.md", "node_modules/", "src/", "  main.ts"]);
  assert.equal(m.skipped, 4);
  assert.match(m.commits[0]!, /^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} 加入额度读取$/);
  assert.match(m.commits[1]!, / init$/);
  const brief = draftBrief(m);
  assert.doesNotMatch(brief, /leak|ghp_|abcdef123456/);
  assert.match(brief, /gh issue list -R me\/demo/);
});

test("初稿的文字版：状态、人话字段、组成部分与会改哪些字段", () => {
  const draft = (parseDraft(JSON.stringify(good)) as { draft: any }).draft;
  const base: DraftView = {
    task: "t3",
    repo: "/r/demo",
    status: "ready",
    draft,
    error: null,
    node: "o2",
    node_name: "OpenQuota",
    changes: [
      { field: "what", before: "旧", after: draft.what },
      { field: "uses", before: null, after: draft.uses },
    ],
    applied_at: null,
    applied_by: null,
    dry_run: true,
  };
  const text = renderDraft(base).join("\n");
  assert.match(text, /^t3 全景初稿 · 读自 \/r\/demo · 待你确认/);
  assert.match(text, /能用它做什么：\n {2}- 看额度\n {2}- 换人/);
  assert.match(text, /一件事怎么走完：\n {2}1\. 读登录/);
  assert.match(
    text,
    /由哪几部分组成（建节点时用，这次不写）：\n {2}- 读取器——去各家查用量\n {2}- 汇总表/,
  );
  assert.match(
    text,
    /写进 o2 OpenQuota 会改：是什么（覆盖原来的）、能用它做什么（原来没写）/,
  );
  assert.match(
    renderDraft({ ...base, node: null, node_name: null, changes: null }).join(
      "\n",
    ),
    /还没定写到哪个节点：用 --node 指定/,
  );
  assert.match(
    renderDraft({ ...base, changes: [] }).join("\n"),
    /和现在一样，不会改动/,
  );
  assert.deepEqual(renderDraft({ ...base, status: "drafting", draft: null }), [
    "t3 全景初稿 · 读自 /r/demo · 还在起草",
  ]);
  assert.match(
    renderDraft({ ...base, status: "failed", draft: null, error: "坏了" }).join(
      "\n",
    ),
    /没有可用的初稿\n原因：坏了/,
  );
  assert.doesNotMatch(
    renderDraft({ ...base, status: "applied" }).join("\n"),
    /会改/,
  );
});

test("隔离服务：map draft 读好材料派一次性执行者，完成后登记初稿；看过再确认才写进节点，只写一次；目标仓库不被改动", async (t) => {
  const fx = fixture(t);
  seedRepo(fx.repo, join(fx.root, "outside"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", fx.repo, ...args], { encoding: "utf8" }).trim();
  const before = {
    head: git("rev-parse", "HEAD"),
    branches: git("branch", "--list"),
    worktrees: git("worktree", "list", "--porcelain"),
    status: git("status", "--porcelain"),
  };
  fx.script(
    "opencode",
    `cat > ${DRAFT_FILE} <<'JSON'\n${JSON.stringify(good)}\nJSON\necho '{"type":"text","part":{"text":"写好了"}}'`,
  );
  const { app, db } = await createApp({
    data: join(fx.root, "data"),
    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      pace: async () => undefined,
      usagePace: async () => undefined,
      tickMs: 100,
    },
  });
  t.after(() => app.close());
  const call = async (
    method: "GET" | "POST",
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
  const doneDetail = async (id: number) => {
    await until(
      () =>
        !!db
          .prepare("SELECT 1 FROM task_inbox WHERE task_id=? AND kind='done'")
          .get(id),
      15_000,
    );
    const row = db
      .prepare(
        "SELECT subscriber,detail FROM task_inbox WHERE task_id=? AND kind='done'",
      )
      .get(id) as { subscriber: string; detail: string };
    return { subscriber: row.subscriber, ...JSON.parse(row.detail) };
  };
  addNode(db, { slug: "org", kind: "org", name: "组织", reason: "建" }, "u1");
  addNode(
    db,
    {
      parent: "o1",
      slug: "oq",
      kind: "project",
      name: "OpenQuota",
      reason: "建",
    },
    "u1",
  );
  editMap(db, "o2", { what: "旧的一句话", now: "现状保留" }, "u1");

  // 破坏输入：相对路径、..、不存在、未知字段、专员节点都在建任务前拒绝。
  for (const [payload, pattern] of [
    [{ repo: "repo" }, /应为绝对路径/],
    [{ repo: `${fx.repo}${sep}..${sep}repo` }, /不能包含 \.\./],
    [{ repo: join(fx.root, "nope") }, /不存在/],
    [{ repo: fx.repo, push: true }, /push: 是未知字段/],
    [{ repo: fx.repo, node: "o99" }, /o99/],
  ] as const) {
    // 带上假执行者：万一漏判也不会挑到本机真实的 CLI。
    const bad = await call("POST", "/api/drafts", {
      ...payload,
      worker: "opencode",
    });
    assert.equal(
      bad.status >= 400 && bad.status < 500,
      true,
      JSON.stringify(bad),
    );
    assert.match(bad.body.error, pattern);
  }
  assert.equal(
    (db.prepare("SELECT count(*) n FROM tasks").get() as { n: number }).n,
    0,
  );

  const started = await call("POST", "/api/drafts", {
    repo: fx.repo,
    node: "o2",
    worker: "opencode",
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const task = started.body.task;
  assert.equal(task.deliver, "none");
  assert.equal(task.repo, null);
  assert.equal(task.part_ref, "o2");
  assert.equal(task.title, "起草全景初稿：repo");
  assert.match(task.brief, /看额度的小工具/);
  assert.doesNotMatch(task.brief, /leak|ghp_|abcdef123456/);

  // 还没好：看得到「还在起草」，写入被拒并给等待命令。
  const early = await call("GET", `/api/drafts/${task.ref}`);
  if (early.body.status === "drafting") {
    const refused = await call("POST", `/api/drafts/${task.ref}/apply`, {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.nextCommand ?? "", /atrium task wait/);
  }

  const done = await doneDetail(task.id);
  assert.equal(done.draft, "ready");
  assert.equal(done.next, `atrium map apply ${task.ref} --dry-run`);
  assert.equal(done.subscriber, "secretary");

  // --dry-run：给看初稿与会改什么，节点不动。
  const preview = await call("GET", `/api/drafts/${task.ref}`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.status, "ready");
  assert.equal(preview.body.node, "o2");
  assert.equal(preview.body.draft.what, good.what);
  assert.deepEqual(
    preview.body.changes.map((c: { field: string }) => c.field),
    ["alias", "analogy", "what", "uses", "flow"],
  );
  assert.equal(charterFields(db, 2).what, "旧的一句话");
  // 破坏输入：不是起草任务、未知字段、节点不存在。
  assert.equal((await call("GET", "/api/drafts/t99")).status, 404);
  assert.equal(
    (await call("POST", `/api/drafts/${task.ref}/apply`, { force: true }))
      .status,
    400,
  );
  assert.equal(
    (await call("POST", `/api/drafts/${task.ref}/apply`, { node: "o99" }))
      .status,
    404,
  );

  // 确认写入：人话字段覆盖，没给的（now）不动，组成部分不建节点。
  const applied = await call("POST", `/api/drafts/${task.ref}/apply`, {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.status, "applied");
  assert.equal(applied.body.applied_by, "u1");
  const node = charterFields(db, 2) as Record<string, unknown>;
  assert.equal(node.what, good.what);
  assert.deepEqual(node.uses, ["看额度", "换人"]);
  assert.deepEqual(node.flow, good.flow);
  assert.equal(node.alias, "额度表");
  assert.equal(node.now, "现状保留");
  assert.equal(
    (db.prepare("SELECT count(*) n FROM org_nodes").get() as { n: number }).n,
    2,
  );
  const again = await call("POST", `/api/drafts/${task.ref}/apply`, {});
  assert.equal(again.status, 409);
  assert.match(again.body.error, /已写进 o2/);

  // 执行者没写文件：任务照常完成，错误随完成事件给出；没有节点也能起草。
  fx.script("opencode", `echo '{"type":"text","part":{"text":"没写"}}'`);
  const second = (
    await call("POST", "/api/drafts", { repo: fx.repo, worker: "opencode" })
  ).body.task;
  assert.equal(second.part_ref ?? null, null);
  const missing = await doneDetail(second.id);
  assert.match(missing.draft_error, /没有在工作目录写 overview\.json/);
  assert.equal(missing.next, `重新起草：atrium map draft ${fx.repo}`);
  assert.equal(
    (await call("GET", `/api/tasks/${second.ref}`)).body.status,
    "done",
  );
  assert.equal(
    (await call("GET", `/api/drafts/${second.ref}`)).body.status,
    "failed",
  );
  const refused = await call("POST", `/api/drafts/${second.ref}/apply`, {
    node: "o2",
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /没有可用的初稿/);

  // 目标仓库原样：提交、分支、worktree、工作区都没变。
  assert.deepEqual(
    {
      head: git("rev-parse", "HEAD"),
      branches: git("branch", "--list"),
      worktrees: git("worktree", "list", "--porcelain"),
      status: git("status", "--porcelain"),
    },
    before,
  );
});
