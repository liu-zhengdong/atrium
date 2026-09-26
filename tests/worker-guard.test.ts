import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WORKER_REFUSAL, workerGuard } from "../cli/worker-guard.ts";
import { workerEnvironment } from "../server/tasks/worker-env.ts";

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
      ATRIUM_DATA: join(homedir(), ".pi", "atrium", "data"),
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

test(
  "执行者防护实测：需要服务的命令一律拒绝，不拉起服务、不建数据目录；显式隔离实例照常",
  { timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "atrium-worker-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
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
      ["list"],
      ["events", "wait", "--timeout", "0"],
      ["task", "run", "t1"],
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
