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
import type { LocalCheck } from "../server/tasks/local-check.ts";
import { fixture } from "./task-fixture.ts";

/**
 * 检查派到哪台的运行时（#358 第 2 步，交付后与合入队列共用）：真 git 仓库 + 假的远程连接。
 * 覆盖：只有本机不碰 git、没推送的提交带 bundle、已在远端的不带、有未提交改动只在本机、
 * 那台没跑成换一台再回本机、不知道基础分支只在本机。
 */

const local = (over: Partial<CheckCandidate> = {}): CheckCandidate => ({
  id: 1,
  kind: "local",
  connection: "local",
  paused: false,
  repos: ["*"],
  cpus: 8,
  load: 100,
  running: 0,
  max: 1,
  busy: null,
  ...over,
});
const remote = (id: number): CheckCandidate => ({
  id,
  kind: "remote",
  connection: "online",
  paused: false,
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

  // 工作树有没提交的改动：只能在本机检查（远程拿不到这些改动）。
  writeFileSync(join(fx.repo, "dirty.txt"), "x\n");
  await dispatch.run(request);
  assert.equal(sent.length, 2);
  assert.equal(locals.length, 2);

  // 不知道基础分支：只在本机。
  await dispatch.run({ ...request, base: null });
  assert.equal(sent.length, 2);
  assert.equal(locals.length, 3);
});
