import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, packageRoot, readService } from "../server/service-state.ts";
import { trackFixture, untrackFixture } from "./fixture-signal.ts";
import { childEnv } from "./child-env.ts";

const exec = promisify(execFile);
/**
 * 单条命令的等待上限。每条命令都是一个独立 node 进程：自身冷启动，再请求服务；
 * 机器越忙越慢——本机实测同时有 20 份本文件在跑、后台再跑一次完整 npm test 时，
 * 单条要 5～25 秒，25 秒会把还在正常跑的命令判死。
 */
const commandBudget = 60000;
/** 跑十来条命令的用例的墙钟预算，理由同 commandBudget。 */
const manyCommands = 300000;
/**
 * 等夹具自己的服务真的能应答。命令行按需拉起服务时最多等 60 秒（server/service.ts），
 * 但命令本身有 commandBudget；机器负载高时冷启动（tsx 加载整个服务、再开 SQLite）仍可能挤爆它。
 * 按服务自己登记的进程与实例号轮询，不用命令行那条命令的成败当判据。
 */
async function waitService(data: string) {
  const deadline = Date.now() + 45000;
  let last = "服务没有登记";
  while (Date.now() < deadline) {
    const record = readService(data);
    if (record && alive(record.pid)) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${record.port}/api/service`,
          {
            headers: { authorization: `Bearer ${record.token}` },
            signal: AbortSignal.timeout(2000),
          },
        );
        const body = (await response.json()) as { pid?: number };
        if (response.ok && body.pid === record.pid) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    await delay(200);
  }
  throw new Error(
    `等夹具服务就绪超时（45 秒）：${last}；日志：${join(data, "service.log")}`,
  );
}
/**
 * 与 service.test.ts 同一种夹具：隔离数据目录、随机端口、假的 Pi 模板，Pi 命令指向不存在的路径。
 * 返回的 `warm` 把这个数据目录的服务起热并等它就绪：命令按需拉起的服务只肯等 12 秒，
 * 负载高时一次冷启动会超过它，服务其实随后就好了。要断言「第一条命令把服务拉起来」
 * 或「被拒的命令不碰数据目录」的用例别调它，它改的就是这两件事的初始状态。
 */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-cli-"));
  const signal = trackFixture(join(root, "data"), root);
  const data = join(root, "data");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const builtin = join(root, "pi-template");
  mkdirSync(builtin);
  writeFileSync(join(builtin, "settings.json"), '{"packages":[]}');
  writeFileSync(join(builtin, "SYSTEM.md"), "builtin rules");
  const env: NodeJS.ProcessEnv = childEnv({
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: builtin,
    PI_ACP_DIR: join(root, "acp"),
    PI_ACP_PI_COMMAND: join(root, "no-such-pi"),
    // 服务白名单会丢掉 PI_*；ATRIUM_PI_BIN 是服务侧的保留开关（#213）。
    ATRIUM_PI_BIN: join(root, "no-such-pi"),
  });
  const cli = async (...args: string[]) => {
    try {
      const output = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        { env, cwd: root, timeout: commandBudget },
      );
      return { ...output, code: 0 };
    } catch (error) {
      const failure = error as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      return {
        stdout: failure.stdout,
        stderr: failure.stderr,
        code: failure.code,
      };
    }
  };
  // 冷启动慢过命令行 12 秒窗口时那条命令会以 503 收场，但它已经把服务拉起来了：
  // 回执不等，只等服务真的能应答，之后每条命令都打在热服务上，命令的成败只反映命令本身。
  const warm = async () => {
    const started = cli("task", "ls");
    await waitService(data);
    await started;
  };
  t.after(async () => {
    await cli("stop");
    const record = readService(data);
    if (record && record.pid !== process.pid && alive(record.pid))
      process.kill(record.pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
    untrackFixture(signal);
  });
  return { root, data, env, cli, signal, warm };
}

test(
  "task add 的下一步：带 --parent 建出的子任务提示派活，顶层任务仍提示拆子任务",
  { timeout: manyCommands },
  async (t) => {
    const f = await fixture(t);
    await f.warm();
    const top = await f.cli("task", "add", "登录模块");
    assert.equal(top.code, 0, top.stderr);
    assert.match(
      top.stdout.trimEnd().split("\n").at(-1)!,
      /^拆子任务：atrium task add 标题 --parent t1$/,
    );
    const child = await f.cli("task", "add", "拆出登录表单", "--parent", "t1");
    assert.equal(child.code, 0, child.stderr);
    assert.match(
      child.stdout.trimEnd().split("\n").at(-1)!,
      /^派活：atrium task run t2$/,
    );
    const json = await f.cli(
      "task",
      "add",
      "再拆一个",
      "--parent",
      "t1",
      "--json",
    );
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).next, "atrium task run t3");
  },
);
