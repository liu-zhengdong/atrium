import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, packageRoot, readService } from "../server/service-state.ts";
import {
  assertNoFixtureLeaks,
  finishFixture,
  trackFixture,
} from "./fixture-signal.ts";
import { childEnv } from "./child-env.ts";

const exec = promisify(execFile);
after(assertNoFixtureLeaks);
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
  const cliWith = async (extra: NodeJS.ProcessEnv, ...args: string[]) => {
    try {
      const output = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        { env: { ...env, ...extra }, cwd: root, timeout: commandBudget },
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
  const cli = (...args: string[]) => cliWith({}, ...args);
  // 冷启动慢过命令行 12 秒窗口时那条命令会以 503 收场，但它已经把服务拉起来了：
  // 回执不等，只等服务真的能应答，之后每条命令都打在热服务上，命令的成败只反映命令本身。
  const warm = async () => {
    const started = cli("task", "ls");
    await waitService(data);
    await started;
  };
  t.after(() => finishFixture(signal));
  return { root, data, env, cli, cliWith, signal, warm };
}

test(
  "task add 的下一步：带 --parent 建出的子任务提示看候选，顶层任务仍提示拆子任务",
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
      /^看候选并派活：atrium task pick t2$/,
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
    assert.equal(JSON.parse(json.stdout).next, "atrium task pick t3");
  },
);

test(
  "task note、ls、show 与 set --pr 共用隔离服务账本",
  { timeout: manyCommands },
  async (t) => {
    const f = await fixture(t);
    await f.warm();
    assert.equal((await f.cli("task", "add", "浸泡验证")).code, 0);
    const noted = await f.cli("task", "note", "t1", "等 fork 浸泡结果");
    assert.equal(noted.code, 0, noted.stderr);
    assert.match(noted.stdout, /u1.*等 fork 浸泡结果/);
    const forged = await f.cli("task", "note", "t1", "冒名", "--as", "a2");
    assert.equal(forged.code, 1);
    assert.match(forged.stderr, /只能以自己的身份（u1）写入/);
    const ls = await f.cli("task", "ls");
    assert.equal(ls.code, 0, ls.stderr);
    assert.match(ls.stdout, /备注（u1.*等 fork 浸泡结果/);
    const show = await f.cli("task", "show", "t1");
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /最新备注：等 fork 浸泡结果/);
    const pr = "https://github.com/fork-owner/atrium/pull/7";
    const patched = await f.cli("task", "set", "t1", "--pr", pr, "--json");
    assert.equal(patched.code, 0, patched.stderr);
    assert.equal(JSON.parse(patched.stdout).result.pr_url, pr);
  },
);

test(
  "statusline：服务不在只说未运行、不拉起；在跑时给一屏概况；task show 的详述读库里的内容",
  { timeout: manyCommands },
  async (t) => {
    const f = await fixture(t);
    const idle = await f.cli("statusline");
    assert.equal(idle.code, 0, idle.stderr);
    assert.equal(idle.stdout, "Atrium 未运行\n");
    assert.equal(readService(f.data), null);
    await f.warm();
    const brief = join(f.root, "详述.md");
    writeFileSync(brief, "# 要做\n按清单做");
    const added = await f.cli("task", "add", "状态栏任务", "--brief", brief);
    assert.equal(added.code, 0, added.stderr);
    writeFileSync(brief, "文件后来改了");
    const shown = await f.cli("task", "show", "t1");
    assert.match(shown.stdout, /详述来源：.*详述\.md/);
    assert.match(shown.stdout, /详述：\n  # 要做\n  按清单做/);
    assert.match(shown.stdout, /球在谁手里：待派：等 秘书 派活/);
    const line = await f.cli("statusline");
    assert.equal(line.code, 0, line.stderr);
    // 待派的任务不在看板行里，只进「接下来」；末行是下一步命令（有就绪的看排期）。
    // 隔离服务没有秘书挂着 events wait，首行带「秘书没在听」（t242）。
    assert.equal(
      line.stdout,
      "Atrium 在做 0 · 秘书没在听\n接下来：就绪 1 · 等待中 0\n下一步：atrium task plan\n",
    );
    const json = await f.cli("statusline", "--json");
    assert.equal(json.code, 0, json.stderr);
    assert.equal(
      JSON.parse(json.stdout.trim().split("\n").at(-1)!).next,
      "atrium task plan",
    );
    // 状态栏的输出进 Claude Code 的管道，不是终端也上色；只有 NO_COLOR 关掉颜色。
    const colored = await f.cliWith({ NO_COLOR: "" }, "statusline");
    assert.equal(colored.code, 0, colored.stderr);
    assert.equal(
      colored.stdout,
      "Atrium 在做 0 · \x1b[2m秘书没在听\x1b[0m\n\x1b[2m接下来：就绪 1 · 等待中 0\x1b[0m\n下一步：atrium task plan\n",
    );
  },
);
