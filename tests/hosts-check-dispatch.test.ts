import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckDispatch } from "../server/hosts/check-runtime.ts";
import type { CheckCandidate } from "../server/hosts/check-plan.ts";
import type { CheckReply, CheckSource } from "../server/hosts/protocol.ts";
import type { RemoteHosts } from "../server/hosts/remote.ts";
import { exec } from "../server/tasks/git.ts";
import {
  LocalCheckQueue,
  type LocalCheck,
} from "../server/tasks/local-check.ts";
import type { QuietEvent } from "../server/tasks/check-quiet-watch.ts";
import { fixture } from "./task-fixture.ts";

/**
 * 检查派到哪台的运行时（#358 第 2 步，交付后与合入队列共用）：真 git 仓库 + 假的远程连接。
 * 覆盖：只有本机不碰 git、没推送的提交带 bundle、已在远端的不带、有未提交改动只在本机、
 * 那台没跑成换一台再回本机、不知道基础分支只在本机、别的平台的主机不接把关检查（t201）。
 */

const local = (over: Partial<CheckCandidate> = {}): CheckCandidate => ({
  id: 1,
  kind: "local",
  connection: "local",
  paused: false,
  platform: "darwin",
  repos: ["*"],
  cpus: 8,
  load: 100,
  running: 0,
  max: 1,
  busy: null,
  ...over,
});
const remote = (id: number, platform = "darwin"): CheckCandidate => ({
  id,
  kind: "remote",
  connection: "online",
  paused: false,
  platform,
  repos: ["*"],
  cpus: 4,
  load: 0,
  running: 0,
  max: 1,
  busy: null,
});

type Sent = {
  host: number;
  source?: CheckSource;
  logFile: string;
};

function fakeRemote(replies: (host: number) => CheckReply) {
  const sent: Sent[] = [];
  const hosts = {
    site: () => ({ os: "linux", data_dir: "/srv/agent" }),
    check: async (host: number, input: Sent) => {
      sent.push({ host, source: input.source, logFile: input.logFile });
      return replies(host);
    },
  } as unknown as RemoteHosts;
  return { hosts, sent };
}

function setup(t: { after: (fn: () => void) => void }) {
  const fx = fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", fx.repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: join(fx.root, "home") },
    }).trim();
  git("fetch", "-q", "origin");
  const taskDir = join(fx.root, "data", "tasks", "1");
  mkdirSync(taskDir, { recursive: true });
  const locals: string[] = [];
  const runLocal = async (input: {
    worktree: string;
    onStatus?: (status: "queued" | "started", log: string) => void;
  }): Promise<LocalCheck> => {
    locals.push(input.worktree);
    input.onStatus?.("started", join(taskDir, "local-check.log"));
    return {
      status: "passed",
      command: "true",
      log: join(taskDir, "local-check.log"),
      detail: "检查通过",
      failedTests: [],
    };
  };
  return { fx, git, taskDir, locals, runLocal };
}

const passed = (host: number): CheckReply => ({
  status: "passed",
  command: "npm run check",
  log: "/x",
  detail: "检查通过",
  failedTests: [],
  host: `h${host}`,
  commit: "c",
});

test("检查派发：只有本机时不碰 git 直接在本机跑；远程有空时带上没推送的提交派过去", async (t) => {
  const { fx, git, taskDir, locals, runLocal } = setup(t);
  const calls: string[][] = [];
  const counting: typeof exec = (command, args, options) => {
    calls.push([command, ...args]);
    return exec(command, args, options);
  };
  const { hosts, sent } = fakeRemote(passed);
  let candidates = [local()];
  const dispatch = new CheckDispatch({
    remote: hosts,
    candidates: () => candidates,
    run: counting,
    runLocal,
  });
  const statuses: string[] = [];
  const request = {
    task: 1,
    worktree: fx.repo,
    taskDir,
    base: "main",
    onStatus: (status: string, _log: string, host: string) =>
      statuses.push(`${status}@${host}`),
  };
  const alone = await dispatch.run(request);
  assert.equal(alone.host, "h1");
  assert.deepEqual(locals, [fx.repo]);
  assert.deepEqual(calls, []);
  assert.deepEqual(statuses, ["started@h1"]);

  // 本机一个没推送的提交：派到 h2，bundle 带过去，克隆路径按那台的数据目录算。
  writeFileSync(join(fx.repo, "new.txt"), "x\n");
  git("add", "new.txt");
  git("commit", "-qm", "unpushed");
  candidates = [local(), remote(2)];
  const result = await dispatch.run(request);
  assert.equal(result.host, "h2");
  assert.equal(sent.length, 1);
  const source = sent[0]!.source!;
  assert.equal(source.commit, git("rev-parse", "HEAD"));
  assert.equal(source.base, "main");
  assert.equal(source.url, join(fx.root, "origin.git"));
  assert.match(source.clone, /^\/srv\/agent\/repos\//);
  assert.ok(source.bundle && source.bundle.length > 0);
  assert.equal(sent[0]!.logFile, join(taskDir, "local-check.log"));
  assert.deepEqual(statuses.slice(-1), ["started@h2"]);
  // 回执里的 infra 不往外带。
  assert.equal("infra" in result, false);

  // 推上去以后：提交已在远端，不带 bundle。
  git("push", "-q", "origin", "HEAD:main");
  git("fetch", "-q", "origin");
  await dispatch.run(request);
  assert.equal(sent[1]!.source!.bundle, undefined);
});

test("检查派发：那台没跑成换一台，都不行回本机；有未提交改动或不知道基础分支只在本机", async (t) => {
  const { fx, taskDir, locals, runLocal } = setup(t);
  const { hosts, sent } = fakeRemote((host) =>
    host === 2
      ? {
          status: "error",
          command: "",
          log: "",
          detail: "h2 离线",
          failedTests: [],
          infra: "h2 离线超过 60 秒，检查没跑完",
        }
      : {
          status: "error",
          command: "",
          log: "",
          detail: "取不到提交",
          failedTests: [],
          infra: "这台取不到提交",
        },
  );
  const moved: string[] = [];
  const dispatch = new CheckDispatch({
    remote: hosts,
    candidates: () => [local(), remote(2), remote(3)],
    run: exec,
    runLocal,
  });
  const request = {
    task: 1,
    worktree: fx.repo,
    taskDir,
    base: "main",
    onMoved: (from: string, reason: string) => moved.push(`${from}:${reason}`),
  };
  const result = await dispatch.run(request);
  assert.deepEqual(
    sent.map((s) => s.host),
    [2, 3],
  );
  assert.deepEqual(moved, [
    "h2:h2 离线超过 60 秒，检查没跑完",
    "h3:这台取不到提交",
  ]);
  assert.equal(result.host, "h1");
  assert.equal(result.status, "passed");
  assert.equal(locals.length, 1);

  // 上一轮在 h2 没跑成（t204）：重跑先不派给它。
  await dispatch.run({ ...request, avoid: [2] });
  assert.deepEqual(
    sent.slice(2).map((s) => s.host),
    [3],
  );
  assert.equal(locals.length, 2);

  // 工作树有没提交的改动：只能在本机检查（远程拿不到这些改动）。
  writeFileSync(join(fx.repo, "dirty.txt"), "x\n");
  await dispatch.run(request);
  assert.equal(sent.length, 3);
  assert.equal(locals.length, 3);

  // 不知道基础分支：只在本机。
  await dispatch.run({ ...request, base: null });
  assert.equal(sent.length, 3);
  assert.equal(locals.length, 4);
});

test("检查派发：与检查基准不同平台的主机不接把关检查；仓库 .agents/check-platform 可另配基准", async (t) => {
  const { fx, git, taskDir, locals, runLocal } = setup(t);
  const calls: string[][] = [];
  const counting: typeof exec = (command, args, options) => {
    calls.push([command, ...args]);
    return exec(command, args, options);
  };
  const { hosts, sent } = fakeRemote(passed);
  const dispatch = new CheckDispatch({
    remote: hosts,
    // 本机（darwin）很忙，唯一空着的远程是 Windows。
    candidates: () => [local(), remote(3, "win32")],
    run: counting,
    runLocal,
  });
  const request = { task: 1, worktree: fx.repo, taskDir, base: "main" };
  // 基准缺省取本机平台：Windows 那台不接，也不碰 git，回本机排队。
  const result = await dispatch.run(request);
  assert.equal(result.host, "h1");
  assert.equal(sent.length, 0);
  assert.deepEqual(calls, []);
  assert.equal(locals.length, 1);

  // 仓库把检查基准配成 win32：派到 Windows 那台，本机不同平台不优先。
  mkdirSync(join(fx.repo, ".agents"), { recursive: true });
  writeFileSync(join(fx.repo, ".agents", "check-platform"), "win32\n");
  git("add", ".agents/check-platform");
  git("commit", "-qm", "check platform");
  const moved = await dispatch.run(request);
  assert.equal(moved.host, "h3");
  assert.deepEqual(
    sent.map((s) => s.host),
    [3],
  );
});

test("检查派发：远程检查的日志在服务这边盯，太久没输出提醒并带主机；本机的交给 runLocalCheck", async (t) => {
  const { fx, git, taskDir } = setup(t);
  writeFileSync(join(fx.repo, "new.txt"), "x\n");
  git("add", "new.txt");
  git("commit", "-qm", "unpushed");
  const hosts = {
    site: () => ({ os: "linux", data_dir: "/srv/agent" }),
    check: async (host: number, input: Sent) => {
      // 真实的 remote.check 一开始就把日志清空；之后代理续传的内容写进来（这里一直没有）。
      writeFileSync(input.logFile, "");
      await new Promise((resolve) => setTimeout(resolve, 700));
      return passed(host);
    },
  } as unknown as RemoteHosts;
  const quietSeen: QuietEvent[] = [];
  const localQuiet: unknown[] = [];
  const dispatch = new CheckDispatch({
    remote: hosts,
    candidates: () => [local(), remote(2)],
    run: exec,
    queue: new LocalCheckQueue(1, 60_000, { warnMs: 200, stallMs: 400 }),
    runLocal: async (input) => {
      localQuiet.push(input.onQuiet);
      return {
        status: "passed",
        command: "true",
        log: join(taskDir, "local-check.log"),
        detail: "检查通过",
        failedTests: [],
      };
    },
  });
  const hostsSeen: string[] = [];
  const result = await dispatch.run({
    task: 1,
    worktree: fx.repo,
    taskDir,
    base: "main",
    quietPollMs: 30,
    onQuiet: (event, host) => {
      quietSeen.push(event);
      hostsSeen.push(host);
    },
  });
  // 服务这边只提醒不结束：结束由那台的代理按它的配置做。
  assert.equal(result.status, "passed");
  assert.equal(result.host, "h2");
  assert.equal(quietSeen.length, 1);
  assert.equal(quietSeen[0]!.kind, "quiet");
  assert.deepEqual(hostsSeen, ["h2"]);

  // 只有本机：提醒回调交给 runLocalCheck。
  const alone = new CheckDispatch({
    remote: hosts,
    candidates: () => [local()],
    run: exec,
    runLocal: async (input) => {
      localQuiet.push(input.onQuiet);
      input.onQuiet?.({ kind: "quiet", quietMs: 1, at: null });
      return {
        status: "passed",
        command: "true",
        log: join(taskDir, "local-check.log"),
        detail: "检查通过",
        failedTests: [],
      };
    },
  });
  await alone.run({
    task: 1,
    worktree: fx.repo,
    taskDir,
    base: "main",
    onQuiet: (_event, host) => hostsSeen.push(host),
  });
  assert.equal(typeof localQuiet.at(-1), "function");
  assert.deepEqual(hostsSeen, ["h2", "h1"]);
});
