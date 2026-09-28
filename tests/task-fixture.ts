import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createApp } from "../server/app.ts";
import { exec, type Exec } from "../server/tasks/git.ts";
import type { PaceEntry } from "../server/tasks/dispatch/prepare.ts";
import type { RunnerOptions } from "../server/tasks/runner.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { tempDir } from "./temp-dir.ts";

/** 派活集成测试的夹具（#262）：本地 bare origin + 临时仓库 + PATH 前置的假执行者 + 临时档案。 */

type After = { after: (fn: () => void | Promise<void>) => void };

export function fixture(t: After) {
  const root = tempDir(t, "atrium-runner-");
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  const env = {
    PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}`,
    HOME: home,
    HERDR_PANE: "9",
    CLAUDECODE: "1",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    }).trim();
  execFileSync("git", [
    "init",
    "--bare",
    "-q",
    "-b",
    "main",
    join(root, "origin.git"),
  ]);
  mkdirSync(join(root, "repo"));
  git(join(root, "repo"), "init", "-q", "-b", "main");
  writeFileSync(join(root, "repo", "README.md"), "# demo\n");
  git(join(root, "repo"), "add", ".");
  git(join(root, "repo"), "commit", "-qm", "init");
  git(join(root, "repo"), "remote", "add", "origin", join(root, "origin.git"));
  git(join(root, "repo"), "push", "-q", "-u", "origin", "main");
  mkdirSync(join(root, "bin"));
  const script = (name: string, body: string) => {
    writeFakeBin(join(root, "bin", name), `#!/bin/sh\n${body}\n`);
  };
  // 假 kimi：记下环境、改一个文件并提交，汇报提交号；不开 PR。提交失败即非零退出，不冒充完成。
  script(
    "kimi",
    'set -e\nenv > "$PWD/../env-seen.txt"\necho working\necho hi > done.txt\ngit add done.txt\ngit commit -qm done\necho "完成，提交 $(git rev-parse --short HEAD)"',
  );
  // 假 grok：故意什么都不输出，也不改文件。
  script("grok", "sleep 30");
  // 假 opencode：独占工具，输出结构化步骤后退出。
  script(
    "opencode",
    'echo \'{"type":"step_start","part":{}}\'\nsleep 0.6\necho \'{"type":"text","part":{"text":"ok"}}\'',
  );
  const workers = join(root, "workers");
  mkdirSync(join(workers, "harness"), { recursive: true });
  writeFileSync(
    join(workers, "harness", "kimi.md"),
    "---\nmax_risk: low\nchecks: [pr_exists, claims_verified]\n---\n假 kimi 的叮嘱\n",
  );
  writeFileSync(
    join(workers, "harness", "grok.md"),
    "---\nlimits: {startup_minutes: 0.01}\n---\n",
  );
  writeFileSync(
    join(workers, "harness", "opencode.md"),
    "---\nchecks: []\n---\n",
  );
  // gh 一律当作非 GitHub 仓库：pr_exists 应判不过并写明原因。
  const run: Exec = (command, args, options) =>
    command === "gh"
      ? Promise.resolve({
          ok: false,
          stdout: "",
          stderr:
            "none of the git remotes configured for this repository point to a known GitHub host",
        })
      : exec(command, args, options);
  return { root, repo: join(root, "repo"), env, workers, run, script };
}

/** 断言失败时附上任务的事件轨迹（kind 与 detail 前 300 字），在别的平台挂了也能看出原因。 */
export function eventTrail(task: {
  status?: string;
  events?: { kind: string; detail?: string | null }[];
}) {
  return `任务 ${task.status}，事件：\n${(task.events ?? [])
    .map((event) => `${event.kind} ${(event.detail ?? "").slice(0, 300)}`)
    .join("\n")}`;
}

export async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 用夹具起一个内存服务：看门狗 100 毫秒一巡，gh 桩成非 GitHub 仓库；tweak 可在起服务前改夹具。 */
export async function startApp(
  t: After,
  tweak?: (fx: ReturnType<typeof fixture>) => void,
  pace: () => Promise<PaceEntry[] | undefined> = async () => undefined,
  usagePace: () => Promise<PaceEntry[] | undefined> = async () => undefined,
  tasks: Partial<RunnerOptions> = {},
) {
  const fx = fixture(t);
  tweak?.(fx);
  const data = join(fx.root, "data");
  const { app, taskRunner } = await createApp({
    data,

    auth: false,
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      tickMs: 100,
      killGraceMs: 200,
      pace,
      usagePace,
      ...tasks,
    },
  });
  t.after(() => app.close());
  const call = async (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.json() };
  };
  return { fx, data, call, app, taskRunner };
}
