import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  WORKER_FLAG,
  WORKER_REFUSAL,
  defaultSubscriber,
  leaderCommandGuard,
  leaderSession,
  workerGuard,
} from "../cli/worker-guard.ts";
import { leaderEnvironment } from "../server/leaders/runtime.ts";
import { workerEnvironment } from "../server/tasks/worker-env.ts";
import { dataDirectory } from "../server/service-state.ts";
import { childEnv } from "./child-env.ts";
import { removeTemp } from "./temp-dir.ts";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin", "atrium.mjs");

test("执行者防护：带 ATRIUM_WORKER 标记时必须显式给隔离的 ATRIUM_DATA 与 ATRIUM_PORT", () => {
  assert.equal(workerEnvironment({ PATH: "/bin" }).ATRIUM_WORKER, "1");
  assert.equal(workerEnvironment({ ATRIUM_WORKER: "0" }).ATRIUM_WORKER, "1");
  workerGuard({});
  workerGuard({ ATRIUM_WORKER: "0" });
  workerGuard({
    ATRIUM_WORKER: "1",
    ATRIUM_DATA: "/tmp/x",
    ATRIUM_PORT: "4555",
  });
  for (const env of [
    { ATRIUM_WORKER: "1" },
    { ATRIUM_WORKER: "1", ATRIUM_DATA: "/tmp/x" },
    { ATRIUM_WORKER: "1", ATRIUM_PORT: "4555" },
    { ATRIUM_WORKER: "1", ATRIUM_DATA: " ", ATRIUM_PORT: "4555" },
    { ATRIUM_WORKER: "1", ATRIUM_DATA: "/tmp/x", ATRIUM_PORT: "4310" },
    {
      ATRIUM_WORKER: "1",
      ATRIUM_DATA: dataDirectory({}),
      ATRIUM_PORT: "4555",
    },
  ])
    assert.throws(
      () => workerGuard(env),
      (error: Error & { code?: string }) => {
        assert.equal(error.message, WORKER_REFUSAL);
        assert.equal(error.code, "worker_environment");
        return true;
      },
    );
});

test("测试夹具起的子进程环境摘掉 ATRIUM_WORKER，不受执行者防护影响", () => {
  const previous = process.env[WORKER_FLAG];
  process.env[WORKER_FLAG] = "1";
  try {
    assert.equal(childEnv()[WORKER_FLAG], undefined);
    const isolated = childEnv({ ATRIUM_DATA: "/tmp/x", ATRIUM_PORT: "4599" });
    assert.equal(isolated[WORKER_FLAG], undefined);
    assert.equal(isolated.ATRIUM_DATA, "/tmp/x");
    assert.equal(isolated.ATRIUM_PORT, "4599");
    // 摘掉标记后照常放行：夹具本来就用隔离的数据目录与端口。
    workerGuard(isolated);
  } finally {
    if (previous === undefined) delete process.env[WORKER_FLAG];
    else process.env[WORKER_FLAG] = previous;
  }
});

test(
  "执行者防护实测：需要服务的命令一律拒绝，不拉起服务、不建数据目录；显式隔离实例照常",
  { timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "atrium-worker-home-"));
    t.after(() => removeTemp(home));
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      LANG: "zh_CN.UTF-8",
      ATRIUM_WORKER: "1",
    };
    const cli = async (args: string[], extra: Record<string, string> = {}) => {
      try {
        const out = await run(process.execPath, [bin, ...args], {
          env: { ...env, ...extra },
          cwd: home,
          timeout: 20000,
        });
        return { code: 0, out: out.stdout + out.stderr };
      } catch (error) {
        const failure = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        return { code: failure.code, out: failure.stdout + failure.stderr };
      }
    };
    for (const args of [
      ["task", "ls"],
      ["--no-open"],
      ["status"],
      ["stop"],
      ["org", "tree"],
      ["events", "wait", "--timeout", "0"],
      ["task", "run", "t1"],
      ["task", "note", "t1", "备注"],
      ["task", "tell", "t1", "补充"],
    ]) {
      const result = await cli(args);
      assert.equal(result.code, 4, `${args.join(" ")}：${result.out}`);
      assert.match(
        result.out,
        /执行者环境里不能操作用户的 Atrium 服务，如需隔离实例请显式设置 ATRIUM_DATA 与 ATRIUM_PORT/,
      );
    }
    const json = await cli(["task", "ls", "--json"]);
    assert.equal(
      JSON.parse(json.out.split("\n")[0]!).error.code,
      "worker_environment",
    );
    const port = await cli(["task", "ls"], {
      ATRIUM_DATA: join(home, "iso"),
      ATRIUM_PORT: "4310",
    });
    assert.equal(port.code, 4, "显式指向 4310 也拒绝");
    assert.deepEqual(
      readdirSync(home),
      [],
      "没有建任何数据目录，也没有服务留下的文件",
    );
    assert.equal(existsSync(join(home, ".pi")), false);

    assert.equal((await cli(["--help"])).code, 0, "帮助不受限");
    const isolated = await cli(["status"], {
      ATRIUM_DATA: join(home, "iso"),
      ATRIUM_PORT: "45999",
    });
    assert.equal(isolated.code, 0, isolated.out);
    assert.doesNotMatch(isolated.out, /执行者环境/);
  },
);

test("leader 环境：令牌、身份与本机地址对得上才算 leader 会话；服务控制命令一律拒绝", () => {
  const token = `a3.${"f".repeat(64)}`;
  const env = {
    ATRIUM_LEADER: "a3",
    ATRIUM_LEADER_TOKEN: token,
    ATRIUM_LEADER_URL: "http://127.0.0.1:4310",
  };
  assert.equal(leaderSession({}), null);
  assert.deepEqual(leaderSession(env), {
    leader: "a3",
    url: "http://127.0.0.1:4310",
    bearer: `Bearer ${token}`,
  });
  assert.equal(defaultSubscriber(env), "a3");
  assert.equal(defaultSubscriber({}), "secretary");
  for (const bad of [
    { ...env, ATRIUM_LEADER: "a4" },
    { ...env, ATRIUM_LEADER: "" },
    { ...env, ATRIUM_LEADER_URL: "http://example.com:4310" },
    { ...env, ATRIUM_LEADER_URL: "" },
  ])
    assert.throws(() => leaderSession(bad), /leader 环境不完整/);
  for (const name of [
    undefined,
    "--no-open",
    "stop",
    "restart",
    "update",
    "auth",
    "chat",
  ])
    assert.throws(
      () => leaderCommandGuard(name, env),
      (error: Error & { code?: string }) =>
        error.code === "leader_scope" && /上交秘书/.test(error.message),
    );
  for (const name of [
    "task",
    "events",
    "leader",
    "org",
    "map",
    "top",
    "status",
  ])
    leaderCommandGuard(name, env);
  leaderCommandGuard("restart", {});
  // leader 进程的环境：执行者白名单，不带 ATRIUM_WORKER 与继承来的凭据，只加本次唤醒的身份。
  const child = leaderEnvironment(
    { PATH: "/bin", ATRIUM_WORKER: "1", GH_TOKEN: "x", ATRIUM_DATA: "/d" },
    { leader: "a3", token, url: "http://127.0.0.1:4310" },
  );
  assert.equal(child.ATRIUM_WORKER, undefined);
  assert.equal(child.GH_TOKEN, undefined);
  assert.equal(child.ATRIUM_DATA, undefined);
  assert.equal(child.ATRIUM_LEADER, "a3");
  assert.equal(child.ATRIUM_LEADER_TOKEN, token);
  assert.equal(child.ATRIUM_LEADER_URL, "http://127.0.0.1:4310");
});
