import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Problem } from "../problem.ts";
import {
  ADAPTERS,
  detectInstalled,
  findExecutable,
  type Adapter,
  type Launch,
  type Tool,
} from "./adapters/index.ts";
import { defaultBranch, ensureWorktree, exec, type Exec } from "./git.ts";
import type { Task } from "./ledger.ts";
import {
  DEFAULT_RULES,
  buildPrompt,
  loadRoleDocs,
  pickWorker,
  readPace,
  worktreePlan,
  type PaceEntry,
} from "./prepare.ts";
import {
  RISKS,
  isRisk,
  resolveWorker,
  type ResolvedWorker,
  type Risk,
} from "./profiles.ts";

/**
 * 派活的准备与拉起（#262）：解析执行者 → 校验 max_risk → 建 worktree → 写提示词 → 拉起进程。
 * 进程以独立进程组拉起、输出直接写进日志文件（不经管道），服务重启也不会把它带走。
 */

/** 派给执行者的额外约束：停在 PR，不碰安装版服务。 */
export const RUN_RULES: readonly string[] = [
  ...DEFAULT_RULES,
  "停在 PR：不要合入、不要改默认分支、不要发版。",
  "不要启动、停止或更新 4310 端口上的 Atrium 服务，也不要执行没有隔离 ATRIUM_PORT / ATRIUM_DATA 的 atrium 命令。",
];

export type RunRequest = { worker?: string; risk?: string };

export function runRequest(body: unknown): RunRequest {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "请求体应为 JSON 对象", "usage");
  const input = body as Record<string, unknown>;
  const extra = Object.keys(input).filter(
    (key) => key !== "worker" && key !== "risk",
  );
  if (extra.length)
    throw new Problem(
      400,
      `不认识的字段：${extra.join("、")}；可用 worker、risk`,
      "usage",
    );
  const text = (key: string) => {
    const value = input[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string")
      throw new Problem(400, `${key}: 应为文本`, "usage");
    return value.trim();
  };
  const risk = text("risk");
  if (risk !== undefined && !isRisk(risk))
    throw new Problem(400, `risk: 只能是 ${RISKS.join("、")}`, "usage");
  return { worker: text("worker"), risk };
}

export type LaunchOptions = {
  data: string;
  workersDir: string;
  env: NodeJS.ProcessEnv;
  run?: Exec;
  pace?: () => Promise<PaceEntry[] | undefined>;
};

export type Prepared = {
  worker: ResolvedWorker;
  adapter: Adapter;
  risk: Risk;
  cwd: string;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  dir: string;
  promptFile: string;
  logFile: string;
  launch: Launch;
};

export const taskDir = (data: string, id: number) =>
  join(data, "tasks", String(id));

/** 解析执行者：写了就按写的（须已装），没写按额度富余挑；再按档案校验 max_risk。 */
export async function chooseWorker(
  request: RunRequest,
  options: LaunchOptions,
): Promise<{ worker: ResolvedWorker; risk: Risk }> {
  const risk: Risk = (request.risk as Risk | undefined) ?? "low";
  const path = options.env.PATH ?? "";
  let worker: ResolvedWorker;
  if (request.worker) {
    worker = await resolveWorker(request.worker, options.workersDir);
    if (!findExecutable(ADAPTERS[worker.tool].executable, path))
      throw new Problem(
        400,
        `执行者 ${worker.tool} 没装：PATH 上找不到 ${ADAPTERS[worker.tool].executable}`,
        "usage",
      );
  } else {
    const installed = detectInstalled(path);
    const tools = Object.keys(installed) as Tool[];
    const profiles = Object.fromEntries(
      await Promise.all(
        tools.map(async (tool) => [
          tool,
          (await resolveWorker(tool, options.workersDir)).profile,
        ]),
      ),
    );
    const pace = await (options.pace ?? (() => readPace()))();
    const picked = pickWorker({ installed, pace, risk, profiles });
    if (!picked.ok)
      throw new Problem(
        409,
        `${picked.reason}（${picked.skipped.map((skip) => `${skip.tool}：${skip.reason}`).join("；")}）`,
        "conflict",
      );
    worker = await resolveWorker(picked.tool, options.workersDir);
  }
  const max = worker.profile.rules.max_risk;
  if (max && RISKS.indexOf(max) < RISKS.indexOf(risk))
    throw new Problem(
      400,
      `执行者 ${worker.id} 的档案 max_risk=${max}，接不了 risk=${risk} 的任务；换执行者或降低 --risk`,
      "usage",
    );
  return { worker, risk };
}

async function readBrief(task: Task) {
  if (!task.brief_path) return undefined;
  const file = isAbsolute(task.brief_path)
    ? task.brief_path
    : task.repo
      ? join(task.repo, task.brief_path)
      : undefined;
  if (!file)
    throw new Problem(
      400,
      `brief_path 是相对路径但任务没有仓库：${task.brief_path}`,
      "usage",
    );
  try {
    return await readFile(file, "utf8");
  } catch {
    throw new Problem(400, `任务详述读不到：${file}`, "usage");
  }
}

/** 建工作目录、写提示词、算出进程调用；不拉起。 */
export async function prepareRun(
  task: Task,
  chosen: { worker: ResolvedWorker; risk: Risk },
  options: LaunchOptions,
): Promise<Prepared> {
  const run = options.run ?? exec;
  const { worker } = chosen;
  const adapter = ADAPTERS[worker.tool];
  const dir = taskDir(options.data, task.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const brief = await readBrief(task);
  let cwd: string;
  let worktree: string | null = null;
  let branch: string | null = null;
  let base: string | null = null;
  if (task.repo) {
    if (!existsSync(task.repo))
      throw new Problem(400, `任务仓库不存在：${task.repo}`, "usage");
    const plan = worktreePlan(task.repo, task.id, task.title);
    base = await defaultBranch(task.repo, run);
    await ensureWorktree(task.repo, plan, base, run);
    cwd = worktree = plan.path;
    branch = plan.branch;
  } else {
    cwd = join(dir, "work");
    mkdirSync(cwd, { recursive: true });
  }
  const docs = task.repo
    ? await loadRoleDocs(worktree ?? task.repo, task.role ?? undefined)
    : { roleDoc: "", rootDoc: "" };
  const where = branch
    ? `工作目录：${cwd}（分支 ${branch}，基于 origin/${base}）。`
    : `工作目录：${cwd}（没有仓库，结果写在最后的回复里）。`;
  const prompt = buildPrompt({
    title: task.title,
    brief,
    roleDoc: docs.roleDoc,
    rootDoc: docs.rootDoc,
    profileBody: worker.profile.body,
    rules: [where, ...RUN_RULES],
  });
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  const logFile = join(dir, "log");
  const launch = adapter.build({
    promptFile,
    prompt,
    cwd,
    model: worker.cliModel,
    effort: worker.effort,
    resultFile: join(dir, "last-message.md"),
  });
  return {
    worker,
    adapter,
    risk: chosen.risk,
    cwd,
    worktree,
    branch,
    base,
    dir,
    promptFile,
    logFile,
    launch,
  };
}

/**
 * 拉起执行者：独立进程组、白名单环境、stdout/stderr 直接写日志文件。
 * 上一次运行的日志改名留档，本次日志从抬头开始。
 */
export async function spawnWorker(
  prepared: Prepared,
  env: NodeJS.ProcessEnv,
  taskRefText: string,
): Promise<ChildProcess> {
  const { launch, logFile } = prepared;
  if (existsSync(logFile)) renameSync(logFile, `${logFile}-${Date.now()}`);
  const command =
    findExecutable(launch.command, env.PATH ?? "") ?? launch.command;
  writeFileSync(
    logFile,
    `[atrium] ${taskRefText} · ${prepared.worker.id} · ${new Date().toISOString()}\n[atrium] cwd ${launch.cwd}\n[atrium] ${[command, ...launch.args.map((arg) => (arg.length > 80 ? `${arg.slice(0, 77)}…` : arg))].join(" ")}\n`,
    { mode: 0o600 },
  );
  const out = openSync(logFile, "a");
  const input = launch.stdin ? openSync(launch.stdin, "r") : "ignore";
  let child: ChildProcess;
  try {
    child = spawn(command, launch.args, {
      cwd: launch.cwd,
      env,
      detached: true,
      stdio: [input, out, out],
    });
  } finally {
    closeSync(out);
    if (typeof input === "number") closeSync(input);
  }
  if (!child.pid) {
    const error = await new Promise<Error>((resolve) =>
      child.once("error", resolve),
    );
    throw new Problem(
      500,
      `拉起 ${prepared.worker.id} 失败：${error.message}`,
      "internal",
    );
  }
  child.unref();
  return child;
}

/** 进程组整体发信号；进程已不在时静默。 */
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 已退出。
    }
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
