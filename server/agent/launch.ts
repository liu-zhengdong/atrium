import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADAPTERS } from "../tasks/adapters/index.ts";
import { ensureWorktree, firstLine, type Exec } from "../tasks/git.ts";
import { spawnWorker } from "../tasks/spawn.ts";
import { workerEnvironment } from "../tasks/worker-env.ts";
import { buildLaunch } from "../tasks/workspace.ts";
import type { Assignment } from "../hosts/protocol.ts";

/**
 * 代理在自己机器上拉起一次运行（#358 第 1 步）：克隆或更新仓库、建工作树、写提示词，
 * 按适配器算出进程调用，用白名单环境拉起。建工作树、算调用、拉起与本机派活是同一份代码
 * （git.ts ensureWorktree、workspace.ts buildLaunch、spawn.ts spawnWorker、worker-env.ts）。
 */

export type Launched = {
  child: ChildProcess;
  pid: number;
  /** 本轮日志从远程日志文件的哪个字节开始（新一轮为 0，续上会话为原日志长度）。 */
  offset: number;
  logFile: string;
  resultFile: string;
  launch: {
    command: string;
    args: string[];
    cwd: string;
    input?: "stream-json";
  };
};

/** 仓库还没克隆就克隆（大仓库可能要几分钟）；已克隆的交给 ensureWorktree 去 fetch。 */
async function ensureClone(url: string, clone: string, run: Exec) {
  if (existsSync(join(clone, ".git")) || existsSync(join(clone, "HEAD")))
    return;
  mkdirSync(dirname(clone), { recursive: true, mode: 0o700 });
  const cloned = await run("git", ["clone", "--quiet", url, clone], {
    timeoutMs: 10 * 60_000,
  });
  if (!cloned.ok)
    throw new Error(
      `克隆 ${url} 失败：${firstLine(cloned.stderr) || "git 失败"}`,
    );
}

export async function launchAssignment(
  assignment: Assignment,
  ctx: { env: NodeJS.ProcessEnv; run: Exec },
): Promise<Launched> {
  const adapter = ADAPTERS[assignment.tool];
  mkdirSync(assignment.dir, { recursive: true, mode: 0o700 });
  if (assignment.repo) {
    const { url, clone, worktree, branch, base } = assignment.repo;
    await ensureClone(url, clone, ctx.run);
    await ensureWorktree(
      clone,
      { path: worktree, branch, slug: "" },
      base,
      ctx.run,
    );
  } else mkdirSync(assignment.cwd, { recursive: true });
  const promptFile = join(assignment.dir, "prompt.md");
  writeFileSync(promptFile, assignment.prompt, { mode: 0o600 });
  const resultFile = join(assignment.dir, "last-message.md");
  // 远程运行的捎话按轮次续上（after_turn），不开标准输入流。
  const launch = buildLaunch(
    adapter,
    {
      promptFile,
      prompt: assignment.prompt,
      cwd: assignment.cwd,
      model: assignment.model,
      effort: assignment.effort,
      resultFile,
      live: false,
    },
    assignment.resume
      ? { ...assignment.resume, file: join(assignment.dir, "tell.md") }
      : undefined,
  );
  const logFile = join(assignment.dir, "log");
  const append = !!assignment.resume;
  const offset = append && existsSync(logFile) ? statSync(logFile).size : 0;
  const { child } = await spawnWorker(
    { launch, logFile, worker: { id: assignment.worker } },
    workerEnvironment(ctx.env),
    assignment.ref,
    append,
  );
  return {
    child,
    pid: child.pid!,
    offset,
    logFile,
    resultFile,
    launch: {
      command: launch.command,
      args: launch.args.map((arg) =>
        arg.length > 200 ? `${arg.slice(0, 197)}…` : arg,
      ),
      cwd: launch.cwd,
      ...(launch.input ? { input: launch.input } : {}),
    },
  };
}
