import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mountSkills, type Mount } from "../skills/mount.ts";
import { fillSkillSlot, type SkillMountAck } from "../skills/remote.ts";
import { ADAPTERS } from "../tasks/adapters/index.ts";
import { ensureWorktree, firstLine, type Exec } from "../tasks/git.ts";
import { spawnWorker } from "../tasks/spawn.ts";
import { workerEnvironment } from "../tasks/worker-env.ts";
import { buildLaunch } from "../tasks/workspace.ts";
import type { Assignment } from "../hosts/protocol.ts";
import { withSecrets } from "../secrets/model.ts";

/**
 * 代理在自己机器上拉起一次运行（#358 第 1 步）：克隆或更新仓库、建工作树、写提示词，
 * 按适配器算出进程调用，用白名单环境拉起。建工作树、算调用、拉起与本机派活是同一份代码
 * （git.ts ensureWorktree、workspace.ts buildLaunch、spawn.ts spawnWorker、worker-env.ts）。
 * 带了组织技能的（t232）用本机派活同一个 skills/mount.ts 挂在这台的任务目录里，挂不上照样拉起，回执写明原因。
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
  /** 带了技能时的挂载结果。 */
  skills?: SkillMountAck;
};

/** 仓库还没克隆就克隆（大仓库可能要几分钟）；已克隆的交给 ensureWorktree 去 fetch。 */
export async function ensureClone(url: string, clone: string, run: Exec) {
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

/** 同一克隆上的 git 操作排成一串（按克隆目录）。 */
export type CloneLock = <T>(
  clone: string,
  work: () => Promise<T>,
) => Promise<T>;

/** 按克隆目录排队：前一件做完（成功或失败）才做下一件，不同克隆互不等。 */
export function cloneLock(): CloneLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(clone: string, work: () => Promise<T>) => {
    const next = (tails.get(clone) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    tails.set(clone, settled);
    void settled.then(() => {
      if (tails.get(clone) === settled) tails.delete(clone);
    });
    return next;
  };
}

export async function launchAssignment(
  assignment: Assignment,
  ctx: { env: NodeJS.ProcessEnv; run: Exec; withClone?: CloneLock },
): Promise<Launched> {
  const adapter = ADAPTERS[assignment.tool];
  mkdirSync(assignment.dir, { recursive: true, mode: 0o700 });
  if (assignment.repo) {
    const { url, clone, worktree, branch, base } = assignment.repo;
    // 两件任务同时拉起时各自 fetch 同一克隆会抢 refs/remotes/origin/<base> 的锁（t229）：
    // 克隆、fetch、建工作树与按提交检查排成一串。
    const withClone: CloneLock = ctx.withClone ?? ((_clone, work) => work());
    await withClone(clone, async () => {
      await ensureClone(url, clone, ctx.run);
      await ensureWorktree(
        clone,
        { path: worktree, branch, slug: "" },
        base,
        ctx.run,
      );
    });
  } else mkdirSync(assignment.cwd, { recursive: true });
  // 组织技能（t232）：与本机同一套挂载；挂不上不拦拉起，提示词与回执写明。
  let mount: Mount | undefined;
  let skills: SkillMountAck | undefined;
  if (assignment.skills?.length) {
    try {
      mount = mountSkills(
        assignment.dir,
        assignment.tool,
        assignment.skills,
        ctx.env.HOME || homedir(),
      );
      skills = {
        mounted: (mount?.skills ?? []).map((s) => `${s.slug}@r${s.rev}`),
      };
    } catch (error) {
      skills = {
        mounted: [],
        error: `挂技能失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const prompt = fillSkillSlot(
    assignment.prompt,
    mount
      ? { section: mount.section }
      : skills?.error
        ? { error: skills.error }
        : undefined,
  );
  const promptFile = join(assignment.dir, "prompt.md");
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  const resultFile = join(assignment.dir, "last-message.md");
  // 远程运行的捎话按轮次续上（after_turn），不开标准输入流。
  const launch = buildLaunch(
    adapter,
    {
      promptFile,
      prompt,
      cwd: assignment.cwd,
      model: assignment.model,
      effort: assignment.effort,
      resultFile,
      live: false,
      ...(assignment.endpoint ? { endpoint: assignment.endpoint } : {}),
    },
    assignment.resume
      ? { ...assignment.resume, file: join(assignment.dir, "tell.md") }
      : undefined,
  );
  if (mount) {
    launch.args.push(...mount.args);
    if (Object.keys(mount.env).length)
      launch.env = { ...launch.env, ...mount.env };
  }
  const logFile = join(assignment.dir, "log");
  const append = !!assignment.resume;
  const offset = append && existsSync(logFile) ? statSync(logFile).size : 0;
  const { child } = await spawnWorker(
    { launch, logFile, worker: { id: assignment.worker } },
    withSecrets(workerEnvironment(ctx.env), assignment.secrets),
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
    ...(skills ? { skills } : {}),
  };
}
