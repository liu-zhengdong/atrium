import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { legacyDir, legacyWorkersDir } from "../server/imports/index.ts";
import { leaderWakeEnabled } from "../server/leaders/runtime.ts";
import { isDefaultData, packageRoot } from "../server/service-state.ts";
import { quotaReserve } from "../server/tasks/budget.ts";
import { userTokenPath } from "../server/user-auth.ts";
import { childEnv } from "./child-env.ts";
import {
  assertNoFixtureLeaks,
  finishFixture,
  trackFixture,
} from "./fixture-signal.ts";

/**
 * 隔离服务不读主目录（t128）：另给 ATRIUM_DATA 的服务不导入 ~/Atrium 的根章程与执行者档案，
 * 库里有 leader 也不起真进程；只有显式的 ATRIUM_LEGACY_DIR、ATRIUM_WORKERS_DIR、ATRIUM_LEADER_WAKE=1 才开。
 */

const exec = promisify(execFile);
after(assertNoFixtureLeaks);

test("旧目录只在默认数据目录缺省读；隔离数据目录要显式给", () => {
  const home = "/h";
  assert.equal(legacyDir({}, home), "/h/Atrium");
  assert.equal(legacyDir({ ATRIUM_DATA: "/h/.atrium" }, home), "/h/Atrium");
  assert.equal(legacyDir({ ATRIUM_DATA: "/tmp/iso" }, home), undefined);
  assert.equal(
    legacyDir({ ATRIUM_DATA: "/tmp/iso", ATRIUM_LEGACY_DIR: "/x" }, home),
    "/x",
  );
  assert.equal(legacyDir({ NODE_TEST_CONTEXT: "child" }, home), undefined);
  assert.equal(legacyWorkersDir({}, home), "/h/Atrium/workers");
  assert.equal(
    legacyWorkersDir({ ATRIUM_LEGACY_DIR: "/x" }, home),
    "/x/workers",
  );
  assert.equal(legacyWorkersDir({ ATRIUM_DATA: "/tmp/iso" }, home), undefined);
  assert.equal(
    legacyWorkersDir(
      { ATRIUM_DATA: "/tmp/iso", ATRIUM_WORKERS_DIR: "/w" },
      home,
    ),
    "/w",
  );
  assert.equal(isDefaultData("/h/.atrium", "/h"), true);
  assert.equal(isDefaultData("/h/.atrium/", "/h"), true);
  assert.equal(isDefaultData("/tmp/iso", "/h"), false);
});

test("leader 唤醒：缺省只在默认数据目录开，ATRIUM_LEADER_WAKE 显式开关", () => {
  assert.equal(leaderWakeEnabled(undefined, { defaultData: true }), true);
  assert.equal(leaderWakeEnabled(undefined, { defaultData: false }), false);
  assert.equal(leaderWakeEnabled("", { defaultData: false }), false);
  assert.equal(leaderWakeEnabled("1", { defaultData: false }), true);
  assert.equal(leaderWakeEnabled("0", { defaultData: true }), false);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test(
  "隔离服务：HOME 下的 ~/Atrium 章程与档案不导入，登记的 leader 不起真进程；显式开关才读、才唤醒",
  { timeout: 120_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-isohome-")));
    const data = join(root, "data");
    const fixture = trackFixture(data, root);
    t.after(() => finishFixture(fixture));
    // 假主目录：哨兵章程（预算 37%）与哨兵执行者档案。
    const home = join(root, "home");
    const legacy = join(home, "Atrium");
    mkdirSync(join(legacy, "workers", "harness"), { recursive: true });
    writeFileSync(
      join(legacy, "charter.md"),
      "---\nbudget:\n  quota_reserve_percent: 37\n---\n# 哨兵章程\n",
    );
    writeFileSync(
      join(legacy, "workers", "harness", "claude.md"),
      "---\ntrust: high\n---\nSENTINEL-t128 哨兵档案\n",
    );
    // 假 claude：被拉起就留下记号（leader 进程只带白名单环境，记号路径写死在脚本里）。
    const bin = join(root, "bin");
    const mark = join(root, "claude-ran");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\necho ran >> '${mark}'\ncat > /dev/null\nexit 0\n`,
      { mode: 0o755 },
    );
    const env = childEnv({
      ATRIUM_DATA: data,
      ATRIUM_PORT: String(await freePort()),
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      ATRIUM_LEADER_BATCH_SECONDS: "0",
      ATRIUM_QUOTA_READERS: "off",
      ATRIUM_OPENQUOTA_BIN: join(root, "no-openquota"),
    });
    // 按生产服务的缺省走：不带测试标记，也不带显式的旧目录与开关。
    for (const key of [
      "NODE_TEST_CONTEXT",
      "ATRIUM_WORKERS_DIR",
      "ATRIUM_LEGACY_DIR",
      "ATRIUM_LEADER_WAKE",
    ])
      delete env[key];
    const cli = async (extra: NodeJS.ProcessEnv, ...args: string[]) => {
      try {
        const output = await exec(
          process.execPath,
          [join(packageRoot, "bin/atrium.mjs"), ...args],
          { env: { ...env, ...extra }, cwd: root, timeout: 30_000 },
        );
        return { ...output, code: 0 };
      } catch (error) {
        const failure = error as Error & {
          stdout: string;
          stderr: string;
          code: number;
        };
        return { ...failure, code: failure.code };
      }
    };
    const start = async (extra: NodeJS.ProcessEnv = {}) => {
      const started = await cli(extra, "--no-open");
      assert.equal(started.code, 0, started.stderr);
    };
    const stop = async () => {
      const stopped = await cli({}, "stop");
      assert.equal(stopped.code, 0, stopped.stderr);
    };
    const inspect = <T>(fn: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(join(data, "atrium.sqlite"), {
        readOnly: true,
      });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    const profiles = () =>
      inspect(
        (db) =>
          db
            .prepare("SELECT layer, name, source FROM worker_profiles")
            .all() as { source: string }[],
      );

    await start();
    // 根章程导入要等根节点建好：建树，登记一位 leader 并给它一条要处理的事件，再重启。
    const token = readFileSync(userTokenPath(data), "utf8").trim();
    const url = `http://127.0.0.1:${env.ATRIUM_PORT}`;
    const created = await fetch(`${url}/api/org/nodes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: "org",
        kind: "org",
        name: "组织",
        reason: "建树",
      }),
    });
    assert.equal(created.status, 201, await created.text());
    await stop();
    const seed = new DatabaseSync(join(data, "atrium.sqlite"));
    const now = Date.now();
    seed
      .prepare(
        "INSERT INTO org_leaders(id,name,worker,created_at,updated_at) VALUES (1,'哨兵 leader','claude',?,?)",
      )
      .run(now, now);
    seed
      .prepare(
        "INSERT INTO task_inbox(subscriber,source,kind,dedupe_key,detail,created_at,updated_at,ready_at) VALUES ('a1','task','failed','t128-sentinel','{}',?,?,?)",
      )
      .run(now, now, now);
    seed.close();

    await start();
    // leader 巡检每 2 秒一轮、攒批 0 秒：等过几轮。
    await delay(6000);
    assert.equal(existsSync(mark), false, "隔离服务不该拉起 claude");
    assert.equal(
      inspect((db) => quotaReserve(db).percent),
      20,
    );
    assert.equal(
      profiles().some((p) => p.source.includes("SENTINEL-t128")),
      false,
    );
    assert.equal(
      inspect(
        (db) =>
          (
            db
              .prepare(
                "SELECT delivered_at FROM task_inbox WHERE dedupe_key='t128-sentinel'",
              )
              .get() as { delivered_at: number | null }
          ).delivered_at,
      ),
      null,
    );
    assert.match(
      readFileSync(join(data, "service.log"), "utf8"),
      /隔离数据目录不唤醒 leader/,
    );
    await stop();

    // 对照：显式给旧目录与唤醒开关才导入、才拉起，证明上面的断言确实查得出来。
    await start({
      ATRIUM_LEGACY_DIR: legacy,
      ATRIUM_WORKERS_DIR: join(legacy, "workers"),
      ATRIUM_LEADER_WAKE: "1",
    });
    for (let i = 0; i < 100 && !existsSync(mark); i++) await delay(200);
    assert.equal(existsSync(mark), true, "显式开唤醒后应拉起 leader");
    assert.equal(
      inspect((db) => quotaReserve(db).percent),
      37,
    );
    assert.equal(
      profiles().some((p) => p.source.includes("SENTINEL-t128")),
      true,
    );
  },
);
