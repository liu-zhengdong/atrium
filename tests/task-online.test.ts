import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { exec, type Exec } from "../server/tasks/git.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import {
  firstRelease,
  includedInVersion,
  onlineMessage,
  planOnline,
  RELEASE_OVERDUE_MS,
  selfRepoFlag,
  selfUpdateEnabled,
  verificationSection,
} from "../server/tasks/online.ts";
import {
  OnlineWatch,
  type DeployResult,
} from "../server/tasks/online-runtime.ts";
import { eventLine } from "../cli/events.ts";
import { claimService } from "../server/service-state.ts";
import { topRows, countRows } from "../server/tasks/top.ts";
import { startApp } from "./task-fixture.ts";

test("自身仓库的写法", () => {
  assert.equal(
    selfRepoFlag("github:liu-zhengdong/atrium"),
    "liu-zhengdong/atrium",
  );
  assert.equal(selfRepoFlag("https://github.com/acme/demo.git"), "acme/demo");
  assert.equal(
    selfRepoFlag("git@ghe.example.com:acme/demo.git"),
    "ghe.example.com/acme/demo",
  );
  assert.equal(selfRepoFlag("/tmp/local-repo"), null);
  assert.equal(selfRepoFlag("github:../x"), null);
});

test("自升级开关：显式设置优先，缺省只在用默认数据目录的安装版上开", () => {
  const installed = { gitCheckout: false, defaultData: true };
  const checkout = { gitCheckout: true, defaultData: true };
  const isolated = { gitCheckout: false, defaultData: false };
  assert.equal(selfUpdateEnabled("0", installed), false);
  assert.equal(selfUpdateEnabled("0", checkout), false);
  assert.equal(selfUpdateEnabled("1", checkout), true);
  assert.equal(selfUpdateEnabled("1", isolated), true);
  assert.equal(selfUpdateEnabled(undefined, installed), true);
  assert.equal(selfUpdateEnabled(undefined, checkout), false);
  // 测试与隔离服务另给 ATRIUM_DATA：即使包目录不是 git 检出也不自升级。
  assert.equal(selfUpdateEnabled(undefined, isolated), false);
  assert.equal(
    selfUpdateEnabled(undefined, { gitCheckout: true, defaultData: false }),
    false,
  );
  assert.equal(selfUpdateEnabled("yes", installed), true);
  assert.equal(selfUpdateEnabled("yes", isolated), false);
});

test("含合入提交的最早版本", () => {
  assert.equal(firstRelease(""), null);
  assert.equal(firstRelease("v0.1.65\nv0.1.64\nv0.1.100\n"), "0.1.64");
  assert.equal(firstRelease("v0.1.10\nv0.1.9"), "0.1.9");
  assert.equal(
    firstRelease("latest\n0.1.3\nvbad\nv0.2.0-rc.1\n"),
    "0.2.0-rc.1",
  );
  assert.equal(firstRelease("v1.0.0\nv1.0.0-rc.1"), "1.0.0-rc.1");
  assert.equal(includedInVersion("v0.1.1\nv0.1.2", "0.1.2"), true);
  assert.equal(includedInVersion("v0.1.1\nv0.1.3", "0.1.2"), false);
});

test("端到端验证一节的提取", () => {
  assert.equal(verificationSection(null), null);
  assert.equal(verificationSection("## 实现\n\n改了"), null);
  assert.equal(verificationSection("## 端到端验证\n\n"), null);
  assert.equal(
    verificationSection(
      "## 实现\nx\n\n## 端到端验证（上线后）\n\n```bash\n# 注释不是标题\natrium task wait t1\n```\n\n### 预期\n显示 [已上线]\n\n## 其他\n不要",
    ),
    "```bash\n# 注释不是标题\natrium task wait t1\n```\n\n### 预期\n显示 [已上线]",
  );
  assert.equal(
    verificationSection("### 端到端验证\r\n跑 a\r\n## 下一节\r\nb"),
    "跑 a",
  );
  assert.equal(
    verificationSection(
      "## 端到端验证\n跑 a\n\nRefs #325\n\n🤖 Generated with [Claude Code](x)\n",
    ),
    "跑 a",
  );
  assert.equal(
    verificationSection(`## 端到端验证\n${"x".repeat(5000)}`)!.length,
    4000,
  );
});

test("上线判定：已发版、需升级、升级过仍旧、不自升级、合入中", () => {
  const empty = {
    online: [],
    failed: [],
    deploy: null,
    deploying: [],
    skipped: [],
  };
  assert.deepEqual(
    planOnline([], "0.1.0", { selfUpdate: true, busy: false }),
    empty,
  );
  // 还没发版的不动。
  assert.deepEqual(
    planOnline([{ id: 1, release: null, attempted: null }], "0.1.0", {
      selfUpdate: true,
      busy: false,
    }),
    empty,
  );
  const tasks = [
    { id: 1, release: "0.1.5", attempted: null },
    { id: 2, release: "0.1.6", attempted: null },
    { id: 3, release: "0.1.8", attempted: null },
    { id: 4, release: "0.1.7", attempted: null },
    { id: 5, release: "0.1.9", attempted: "0.1.9" },
    { id: 6, release: "0.1.9", attempted: "0.1.8" },
  ];
  assert.deepEqual(
    planOnline(tasks, "0.1.6", { selfUpdate: true, busy: false }),
    {
      online: [1, 2],
      failed: [5],
      deploy: "0.1.9",
      deploying: [3, 4, 6],
      skipped: [],
    },
  );
  assert.deepEqual(
    planOnline(tasks, "0.1.6", { selfUpdate: true, busy: true }),
    { ...empty, online: [1, 2], failed: [5] },
  );
  assert.deepEqual(
    planOnline(tasks, "0.1.6", { selfUpdate: false, busy: false }),
    { ...empty, online: [1, 2], failed: [5], skipped: [3, 4, 6] },
  );
  // 升级后新服务版本已到：全部上线。
  assert.deepEqual(
    planOnline(tasks, "0.1.9", { selfUpdate: true, busy: false }),
    { ...empty, online: [1, 2, 3, 4, 5, 6] },
  );
  assert.equal(onlineMessage("t7", "0.1.64"), "t7 已上线（v0.1.64）");
});

/** 账本里造一条已合入、等上线的任务。 */
function merged(
  db: DatabaseSync,
  fields: { commit?: string | null; at?: number; result?: string } = {},
) {
  const now = fields.at ?? Date.now();
  const id = Number(
    db
      .prepare(
        "INSERT INTO tasks(title,repo,deliver,status,pr_url,result,delivery_stage,merge_commit,online_wait,created_at,updated_at) VALUES ('上线',?,'pr','done','https://github.com/acme/demo/pull/1',?,'merged',?,1,?,?)",
      )
      .run(
        "/repo",
        fields.result ?? null,
        fields.commit === undefined ? "abc1234" : fields.commit,
        now,
        now,
      ).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO task_events(task_id,at,kind,detail) VALUES (?,?,'merged',NULL)",
  ).run(id, now);
  return id;
}

function watcher(
  db: DatabaseSync,
  options: {
    tags?: string;
    version?: string;
    selfUpdate?: boolean;
    busy?: boolean;
    deploy?: (version: string) => Promise<DeployResult>;
    body?: string;
    now?: () => number;
    fetchFails?: boolean;
    tagsForCommit?: Record<string, string>;
    otherRepo?: string;
  } = {},
) {
  const calls: string[][] = [];
  const published: {
    id: number;
    kind: string;
    detail: Record<string, unknown>;
  }[] = [];
  const deployed: string[] = [];
  const run: Exec = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args.includes("get-url"))
      return {
        ok: true,
        stdout: args.includes("/other")
          ? `https://github.com/${options.otherRepo ?? "acme/demo"}.git\n`
          : "https://github.com/acme/demo.git\n",
        stderr: "",
      };
    if (command === "git" && args.includes("fetch"))
      return options.fetchFails
        ? { ok: false, stdout: "", stderr: "network down" }
        : { ok: true, stdout: "", stderr: "" };
    if (command === "git" && args.includes("tag"))
      return {
        ok: true,
        stdout:
          options.tagsForCommit?.[args[args.indexOf("--contains") + 1]!] ??
          options.tags ??
          "",
        stderr: "",
      };
    if (command === "gh" && args.includes("mergeCommit"))
      return {
        ok: true,
        stdout: JSON.stringify({ mergeCommit: { oid: "def5678" } }),
        stderr: "",
      };
    if (command === "gh" && args.includes("body"))
      return options.body === undefined
        ? { ok: false, stdout: "", stderr: "gh down" }
        : {
            ok: true,
            stdout: JSON.stringify({ body: options.body }),
            stderr: "",
          };
    return { ok: false, stdout: "", stderr: `unexpected ${command}` };
  };
  const watch = new OnlineWatch(db, {
    run,
    version: () => options.version ?? "0.1.0",
    selfUpdate: options.selfUpdate ?? true,
    selfRepo: "acme/demo",
    busy: () => options.busy ?? false,
    deploy:
      options.deploy ??
      (async (version) => {
        deployed.push(version);
        return { ok: true };
      }),
    restartError: (version) =>
      version === "0.1.1" ? "自升级重启已回滚到 v0.1.0：健康检查未通过" : null,
    publish: (id, kind, detail) => published.push({ id, kind, detail }),
    changed: () => {},
    now: options.now,
  });
  return { watch, calls, published, deployed };
}

function memory() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  return db;
}

const row = (db: DatabaseSync, id: number) =>
  db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<
    string,
    unknown
  >;
const kinds = (db: DatabaseSync, id: number) =>
  (
    db
      .prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY id")
      .all(id) as { kind: string }[]
  ).map((event) => event.kind);

test("已发版且版本已在运行：标记上线并附 PR 里的端到端验证", async () => {
  const db = memory();
  const id = merged(db);
  const { watch, calls, published } = watcher(db, {
    tags: "v0.1.0\n",
    version: "0.1.2",
    body: "## 实现\nx\n## 端到端验证\natrium task show t1\n期望：已上线",
  });
  await watch.tick();
  assert.equal(row(db, id).delivery_stage, "online");
  assert.equal(row(db, id).online_wait, 0);
  assert.equal(row(db, id).release_version, "0.1.0");
  assert.deepEqual(kinds(db, id), ["merged", "released", "online"]);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.kind, "online");
  assert.equal(published[0]!.detail.message, "t1 已上线（v0.1.2）");
  assert.equal(
    published[0]!.detail.verification,
    "atrium task show t1\n期望：已上线",
  );
  assert.ok(
    calls.some(
      (call) =>
        call[0] === "git" &&
        call.includes("--contains") &&
        call.includes("abc1234"),
    ),
  );
  // gh 查询带 -R。
  for (const call of calls.filter((call) => call[0] === "gh"))
    assert.equal(call[call.indexOf("-R") + 1], "acme/demo");
  // 已上线的不再处理。
  await watch.tick();
  assert.equal(published.length, 1);
});

test("历史合入任务只在提交属于运行版本时补已上线状态，不补通知", async () => {
  const db = memory();
  const old = merged(db);
  db.prepare("UPDATE tasks SET online_wait=0 WHERE id=?").run(old);
  const future = merged(db, { commit: "def5678" });
  db.prepare("UPDATE tasks SET online_wait=0 WHERE id=?").run(future);
  const unrelated = merged(db, { commit: "987abcd" });
  db.prepare("UPDATE tasks SET online_wait=0,repo='/other' WHERE id=?").run(
    unrelated,
  );
  const { watch, published } = watcher(db, {
    version: "0.1.1",
    tagsForCommit: { abc1234: "v0.1.1", def5678: "v0.1.2" },
    otherRepo: "other/project",
  });
  // firstRelease 只认确实含合入提交的标签，且运行版本必须达到它。
  await watch.tick();
  assert.equal(row(db, old).delivery_stage, "online");
  assert.equal(row(db, old).release_version, "0.1.1");
  assert.deepEqual(kinds(db, old), ["merged", "online_backfilled"]);
  const top = topRows(db, Date.now()).rows;
  assert.equal(
    top.find((task) => task.ref === `t${old}`)?.delivery_stage,
    "online",
  );
  assert.equal(countRows(top).online, 1);
  assert.equal(row(db, future).delivery_stage, "merged");
  assert.equal(row(db, unrelated).delivery_stage, "merged");
  assert.deepEqual(published, []);
});

test("PR 正文读不到时退回执行者汇报；都没有写明请自行验证", async () => {
  const db = memory();
  const a = merged(db, { result: "完成。\n\n## 端到端验证\n运行 atrium top" });
  const b = merged(db);
  const { watch, published } = watcher(db, {
    tags: "v0.1.0",
    version: "0.1.0",
  });
  await watch.tick();
  assert.deepEqual(
    published.map((event) => [event.id, event.kind, event.detail.version]),
    [
      [a, "online", "0.1.0"],
      [b, "online", "0.1.0"],
    ],
  );
  assert.equal(
    published.find((event) => event.id === a)!.detail.verification,
    "运行 atrium top",
  );
  assert.match(
    String(published.find((event) => event.id === b)!.detail.verification),
    /没有写「端到端验证」/,
  );
});

test("版本比运行中的新：先记账再自升级到最高版本，同一进程不重复升级", async () => {
  const db = memory();
  const a = merged(db);
  const b = merged(db);
  let tags = "v0.1.1";
  const { watch, deployed, published } = watcher(db, {
    get tags() {
      return tags;
    },
    version: "0.1.0",
    deploy: async (version) => {
      // 升级发起时账上已经记下尝试版本。
      assert.equal(row(db, a).online_attempt, version);
      deployed.push(version);
      return { ok: true };
    },
  });
  await watch.tick();
  assert.deepEqual(deployed, ["0.1.1"]);
  assert.equal(row(db, b).online_attempt, "0.1.1");
  assert.ok(kinds(db, a).includes("online_deploy"));
  tags = "v0.1.2";
  await watch.tick();
  assert.deepEqual(deployed, ["0.1.1"], "等待重启期间不再升级");
  assert.equal(published.length, 0);
});

test("新服务版本到了：已上线；版本没变（回滚）：上线失败并写明原因", async () => {
  for (const [version, expect] of [
    ["0.1.1", "online"],
    ["0.1.0", "online_failed"],
  ] as const) {
    const db = memory();
    const id = merged(db);
    db.prepare(
      "UPDATE tasks SET release_version='0.1.1',online_attempt='0.1.1' WHERE id=?",
    ).run(id);
    const { watch, deployed, published } = watcher(db, { version });
    await watch.tick();
    assert.deepEqual(deployed, [], "同一版本不重复升级");
    assert.equal(published.length, 1);
    assert.equal(published[0]!.kind, expect);
    assert.equal(row(db, id).online_wait, 0);
    if (expect === "online_failed") {
      assert.equal(row(db, id).delivery_stage, "merged");
      assert.match(String(published[0]!.detail.reason), /已回滚到 v0\.1\.0/);
    } else assert.equal(row(db, id).delivery_stage, "online");
  }
});

test("自升级命令失败：立即判上线失败，凭据抹掉", async () => {
  const db = memory();
  const id = merged(db);
  const { watch, published } = watcher(db, {
    tags: "v0.2.0",
    deploy: async () => ({
      ok: false,
      reason:
        "atrium update：第一行失败\n详情：token ghp_abcdefghijklmnopqrstuvwxyz0123456789 无效\n最后一行",
    }),
  });
  await watch.tick();
  assert.equal(published[0]!.kind, "online_failed");
  assert.match(String(published[0]!.detail.reason), /自升级到 v0\.2\.0 失败/);
  assert.match(
    String(published[0]!.detail.reason),
    /第一行失败\n详情：token \*\*\* 无效\n最后一行/,
  );
  assert.doesNotMatch(String(published[0]!.detail.reason), /ghp_abcdef/);
  assert.equal(row(db, id).online_wait, 0);
});

test("合入进行中先不重启；不自升级的服务停在已合入", async () => {
  const busyDb = memory();
  const busy = merged(busyDb);
  const first = watcher(busyDb, { tags: "v0.2.0", busy: true });
  await first.watch.tick();
  assert.deepEqual(first.deployed, []);
  assert.equal(row(busyDb, busy).online_wait, 1);
  assert.equal(row(busyDb, busy).online_attempt, null);

  const devDb = memory();
  const dev = merged(devDb);
  const second = watcher(devDb, { tags: "v0.2.0", selfUpdate: false });
  await second.watch.tick();
  assert.deepEqual(second.deployed, []);
  assert.equal(row(devDb, dev).online_wait, 0);
  assert.equal(row(devDb, dev).delivery_stage, "merged");
  assert.ok(kinds(devDb, dev).includes("online_skipped"));
  assert.equal(second.published.length, 0);
});

test("缺合入提交时向 gh 补查；长时间没发版提醒一次；拉标签失败不误判", async () => {
  const db = memory();
  let now = Date.now();
  const id = merged(db, { commit: null, at: now });
  const { watch, published, calls } = watcher(db, { now: () => now });
  await watch.tick();
  assert.equal(row(db, id).merge_commit, "def5678");
  assert.equal(published.length, 0);
  now += RELEASE_OVERDUE_MS + 1;
  await watch.tick();
  await watch.tick();
  assert.deepEqual(
    published.map((event) => event.kind),
    ["release_overdue"],
  );
  assert.equal(
    calls.filter((call) => call[0] === "gh" && call.includes("mergeCommit"))
      .length,
    1,
  );

  const failing = memory();
  const other = merged(failing);
  const broken = watcher(failing, { fetchFails: true });
  await broken.watch.tick();
  assert.equal(row(failing, other).release_version, null);
  assert.equal(row(failing, other).online_wait, 1);
  assert.equal(
    broken.calls.filter((call) => call.includes("--contains")).length,
    0,
  );
});

test("已上线事件行附端到端验证", () => {
  const line = eventLine({
    id: 3,
    task: "t5",
    kind: "online",
    count: 1,
    delivered_at: 1,
    acked_at: null,
    updated_at: Date.now(),
    detail: {
      title: "自动上线",
      message: "t5 已上线（v0.1.64）",
      verification: "atrium top --once\n期望：已上线 1",
    },
  } as never);
  assert.match(line, /t5 online 自动上线 .*t5 已上线（v0\.1\.64）/);
  assert.match(
    line,
    /\n {2}端到端验证：\n {4}atrium top --once\n {4}期望：已上线 1$/,
  );
});

for (const scenario of ["online", "rolled_back"] as const)
  test(`隔离服务与假 gh/执行者：合入 → 发版 → 自升级 → 重启后${scenario === "online" ? "已上线" : "判上线失败"}`, async (t) => {
    let merged = false;
    let headBranch = "";
    let mergeCommit = "";
    const deployed: string[] = [];
    const online = {
      selfRepo: "acme/demo",
      selfUpdate: true,
      version: () => "0.1.0",
      pollMs: 100,
      deploy: async (version: string): Promise<DeployResult> => {
        deployed.push(version);
        return { ok: true };
      },
    };
    const { fx, call, app, data } = await startApp(
      t,
      (fixture) => {
        const git = (...args: string[]) =>
          execFileSync("git", args, {
            cwd: fixture.repo,
            encoding: "utf8",
          }).trim();
        // 可信执行者、低风险：不经审阅直接进合入队列（审阅分支见 task-review.test.ts）。
        writeFileSync(
          join(fixture.workers, "harness", "kimi.md"),
          "---\ntrust: medium\nmax_risk: low\nchecks: [pr_exists, claims_verified]\n---\n",
        );
        git("config", "user.name", "test");
        git("config", "user.email", "test@example.com");
        writeFileSync(
          join(fixture.repo, "package.json"),
          JSON.stringify({ scripts: { check: "true" } }),
        );
        git("add", ".");
        git("commit", "-qm", "检查夹具");
        git("push", "-q", "origin", "main");
        fixture.script(
          "kimi",
          "set -e\necho change >> done.txt\ngit add done.txt\ngit commit -qm 修复\ngit push -q -u origin HEAD\necho 完成",
        );
        const origin = join(fixture.root, "origin.git");
        const remoteHead = () =>
          execFileSync(
            "git",
            ["--git-dir", origin, "rev-parse", `refs/heads/${headBranch}`],
            { encoding: "utf8" },
          ).trim();
        fixture.run = async (command, args, options) => {
          if (command === "git" && args.includes("get-url"))
            return {
              ok: true,
              stdout: "https://github.com/acme/demo.git\n",
              stderr: "",
            };
          if (command !== "gh") return exec(command, args, options);
          assert.equal(args[args.indexOf("-R") + 1], "acme/demo");
          if (args[0] === "pr" && args[1] === "list") {
            headBranch = args[args.indexOf("--head") + 1]!;
            return {
              ok: true,
              stdout: JSON.stringify([
                {
                  number: 1,
                  url: "https://github.com/acme/demo/pull/1",
                  state: "OPEN",
                },
              ]),
              stderr: "",
            };
          }
          if (args[0] === "pr" && args[1] === "view")
            return {
              ok: true,
              stdout: JSON.stringify({
                state: merged ? "MERGED" : "OPEN",
                headRefOid: remoteHead(),
                headRefName: headBranch,
                baseRefName: "main",
                isCrossRepository: false,
                mergeCommit: merged ? { oid: mergeCommit } : null,
                body: "## 端到端验证\natrium task show t1\n期望：[已上线]",
              }),
              stderr: "",
            };
          if (args[0] === "pr" && args[1] === "merge") {
            // 模拟 squash 合入与发版工作流：main 上多一个提交，随后打 v0.1.1 标签。
            git("fetch", "-q", "origin");
            git("merge", "-q", "--ff-only", `origin/${headBranch}`);
            git("push", "-q", "origin", "main");
            mergeCommit = git("rev-parse", "HEAD");
            git("tag", "v0.1.1");
            git("push", "-q", "origin", "v0.1.1");
            git("tag", "-d", "v0.1.1");
            merged = true;
            return { ok: true, stdout: "merged", stderr: "" };
          }
          return {
            ok: false,
            stdout: "",
            stderr: `unexpected gh ${args.join(" ")}`,
          };
        };
      },
      undefined,
      undefined,
      undefined,
      { online },
    );
    assert.equal(
      (
        await call("POST", "/api/org/nodes", {
          slug: "org",
          kind: "org",
          name: "组织",
          reason: "测试",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call("POST", "/api/org/nodes", {
          parent: "o1",
          slug: "atrium",
          kind: "project",
          name: "Atrium",
          reason: "测试",
        })
      ).status,
      201,
    );
    const ref = (
      await call("POST", "/api/tasks", {
        title: "上线测试",
        repo: fx.repo,
        part: "o2",
      })
    ).body.ref as string;
    assert.equal(
      (await call("POST", `/api/tasks/${ref}/run`, { worker: "kimi" })).status,
      200,
    );
    const waited = await call("GET", `/api/tasks/${ref}/wait?timeout=30`);
    assert.equal(
      waited.body.task.delivery_stage,
      "merged",
      JSON.stringify(
        waited.body.task.events.map((e: { kind: string; detail: unknown }) => [
          e.kind,
          e.detail,
        ]),
      ),
    );
    const end = Date.now() + 15_000;
    while (!deployed.length) {
      assert.ok(Date.now() < end, "等待自升级超时");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(deployed, ["0.1.1"]);
    assert.equal(
      (
        await call("POST", "/api/leaders", {
          name: "Atrium 负责人",
          worker: "kimi",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/org/nodes/o2",
          payload: { leader: "a1", reason: "测试投递" },
        })
      ).statusCode,
      200,
    );
    await app.close();

    // 「重启」：同一数据目录起新服务；成功时新服务报新版本，回滚时仍是旧版本。
    const next = await createApp({
      data,
      auth: false,
      leaders: { pollMs: 60_000 },
      tasks: {
        env: fx.env,
        workersDir: fx.workers,
        exec: fx.run,
        tickMs: 100,
        diskFreeGb: async () => 1000,
        online: {
          ...online,
          version: () => (scenario === "online" ? "0.1.1" : "0.1.0"),
        },
      },
    });
    t.after(() => next.app.close());
    let serviceRecord: ReturnType<typeof claimService>["record"] | undefined;
    next.app.get("/api/service", () => ({
      instance: serviceRecord?.instance,
      pid: process.pid,
      userAuth: "user-v1",
    }));
    const url = await next.app.listen({ host: "127.0.0.1", port: 0 });
    const port = Number(new URL(url).port);
    const claimed = claimService(data, port);
    serviceRecord = claimed.record;
    t.after(() => {
      if (existsSync(data)) claimed.release();
    });
    const get = async (url: string) =>
      (
        await next.app.inject({
          method: "GET",
          url,
          headers: { host: "127.0.0.1" },
        })
      ).json();
    const until = Date.now() + 15_000;
    let task = await get(`/api/tasks/${ref}`);
    while (
      !task.events.some((event: { kind: string }) =>
        ["online", "online_failed"].includes(event.kind),
      )
    ) {
      assert.ok(Date.now() < until, "等待上线结论超时");
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = await get(`/api/tasks/${ref}`);
    }
    assert.deepEqual(deployed, ["0.1.1"], "重启后不重复升级同一版本");
    const events = (await get("/api/events?as=secretary")).events as {
      kind: string;
      detail: Record<string, unknown>;
    }[];
    const last = events.find((event) =>
      ["online", "online_failed"].includes(event.kind),
    )!;
    const wait = async (as: string) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          join(import.meta.dirname, "..", "bin", "atrium.mjs"),
          "events",
          "wait",
          "--as",
          as,
          "--timeout",
          "1",
          "--settle",
          "0",
          "--json",
        ],
        {
          env: { ...process.env, ATRIUM_DATA: data, ATRIUM_PORT: String(port) },
        },
      );
      return (
        JSON.parse(stdout) as {
          result: {
            events: {
              kind: string;
              task: string;
              detail: Record<string, unknown>;
            }[];
          };
        }
      ).result.events;
    };
    const leaderEvents = await wait("a1");
    const secretaryEvents = await wait("secretary");
    assert.equal(
      leaderEvents.find((event) => event.kind === last.kind)?.task,
      ref,
    );
    assert.equal(
      secretaryEvents.find((event) => event.kind === last.kind)?.task,
      ref,
    );
    assert.equal(
      secretaryEvents.find((event) => event.kind === last.kind)?.detail.pr_url,
      "https://github.com/acme/demo/pull/1",
    );
    if (scenario === "online")
      assert.equal(
        secretaryEvents.find((event) => event.kind === "online")?.detail
          .verification,
        "atrium task show t1\n期望：[已上线]",
      );
    if (scenario === "online") {
      assert.equal(task.delivery_stage, "online");
      assert.equal(last.kind, "online");
      assert.equal(last.detail.message, `${ref} 已上线（v0.1.1）`);
      assert.equal(
        last.detail.verification,
        "atrium task show t1\n期望：[已上线]",
      );
    } else {
      assert.equal(task.delivery_stage, "merged");
      assert.equal(last.kind, "online_failed");
      assert.match(String(last.detail.reason), /运行版本仍是 v0\.1\.0/);
    }
    claimed.release();
  });
