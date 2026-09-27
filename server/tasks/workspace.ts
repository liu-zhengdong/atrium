import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import { ADAPTERS, type Adapter, type Launch } from "./adapters/index.ts";
import { taskDir } from "./active.ts";
import { defaultBranch, ensureWorktree, exec, type Exec } from "./git.ts";
import { noteTask, type Task } from "./ledger.ts";
import {
  DEFAULT_RULES,
  buildPrompt,
  loadRoleDocs,
  worktreePlan,
  type PaceEntry,
} from "./prepare.ts";
import type { ResolvedWorker, Risk } from "./profiles.ts";
import { nodeDoc, taskNode } from "../org/task-node.ts";
import { charterBrief, withContext } from "../org/brief.ts";
import { taskContext } from "../map/context.ts";
import { skillsForTask } from "../skills/task-skills.ts";
import { mountSkills } from "../skills/mount.ts";
import { homedir } from "node:os";
import { listTells, unsent } from "./tell-ledger.ts";
import { TELL_RULE, tellModeOf, tellSection } from "./tell.ts";
import type { TellMode } from "./adapters/index.ts";
import { checklists } from "./concerns.ts";
import { concernSection } from "./concern-gate.ts";

/**
 * 派活的工作区（#262）：建 worktree（无仓库时用任务目录下的 work/）、写提示词、算出进程调用；不拉起。
 */

/** 派给执行者的额外约束：停在 PR，不碰安装版服务。 */
export const RUN_RULES: readonly string[] = [
  ...DEFAULT_RULES,
  "停在 PR：不要合入、不要改默认分支、不要发版。",
  "不要启动、停止或更新 4310 端口上的 Atrium 服务，也不要执行没有隔离 ATRIUM_PORT / ATRIUM_DATA 的 atrium 命令。",
];

export function deliveryRules(task: Task): readonly string[] {
  if (task.deliver === "pr") return RUN_RULES;
  const common = DEFAULT_RULES.filter((rule) => !rule.startsWith("做完后依次"));
  return [
    ...common,
    task.deliver === "comment"
      ? `交付物是在 issue #${task.issue} 发布一条评论；完成后附评论链接，不要求提交、推送或开 PR。`
      : "交付物是最终摘要；完成后写明调查结果，不要求提交、推送或开 PR。",
    RUN_RULES.at(-1)!,
  ];
}

export type LaunchOptions = {
  db?: DatabaseSync;
  data: string;
  workersDir: string;
  env: NodeJS.ProcessEnv;
  run?: Exec;
  pace?: () => Promise<PaceEntry[] | undefined>;
  /** 用量快照单独采样；测试可注入假 OpenQuota，不改变挑人采样次数。 */
  usagePace?: () => Promise<PaceEntry[] | undefined>;
  charterPath?: string;
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
  /** 这次运行的捎话送达方式（适配器缺省，档案 tell 可改）。 */
  tellMode: TellMode;
  /** 这次写进提示词、拉起成功后即算送达的捎话。 */
  tellIds: number[];
};

/** 续上原会话：带着这段补充，不重发整份提示词。 */
export type ResumeWith = { session: string; text: string };

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
  resume?: ResumeWith,
): Promise<Prepared> {
  const run = options.run ?? exec;
  const { worker } = chosen;
  const adapter = ADAPTERS[worker.tool];
  const tellMode = tellModeOf(adapter, worker.profile.rules.tell);
  const tells = options.db ? listTells(options.db, task.id) : [];
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
    const plan = worktreePlan(
      task.repo,
      task.id,
      task.title,
      task.role ?? undefined,
    );
    base = await defaultBranch(task.repo, run);
    await ensureWorktree(task.repo, plan, base, run);
    cwd = worktree = plan.path;
    branch = plan.branch;
  } else {
    cwd = join(dir, "work");
    mkdirSync(cwd, { recursive: true });
  }
  const node = options.db ? taskNode(options.db, task) : undefined;
  const origin =
    options.db && task.origin_node_id !== null
      ? nodeDoc(options.db, task.origin_node_id)
      : undefined;
  const docs = task.repo
    ? await loadRoleDocs(worktree ?? task.repo, node)
    : { roleDoc: node?.body ?? "", rootDoc: "" };
  // 组织技能：节点链上绑定的 ∪ 档案指定的，拷进任务目录，只对这次运行生效。
  const picked = options.db
    ? skillsForTask(options.db, task, worker.profile.rules)
    : undefined;
  const mount = picked
    ? mountSkills(
        dir,
        worker.tool,
        picked.skills,
        options.env.HOME ?? homedir(),
      )
    : undefined;
  if (
    options.db &&
    picked &&
    (mount || picked.dropped.length || picked.unknown.length)
  )
    noteTask(options.db, task.id, "skills_mounted", {
      worker: worker.id,
      skills: mount?.skills.map((s) => `${s.slug}@r${s.rev}`) ?? [],
      ...(picked.dropped.length
        ? { dropped: picked.dropped.map((d) => d.slug) }
        : {}),
      ...(picked.unknown.length ? { unknown: picked.unknown } : {}),
    });
  const where = branch
    ? `工作目录：${cwd}（分支 ${branch}，基于 origin/${base}）。`
    : `工作目录：${cwd}（没有仓库，结果写在最后的回复里）。`;
  const prompt = buildPrompt({
    title: task.title,
    brief,
    tells: tellSection(tells),
    roleDoc: docs.roleDoc,
    charter: options.db
      ? withContext(
          node ? charterBrief(options.db, node.id) : undefined,
          taskContext(options.db, task.part_id ?? node?.id ?? null),
        )
      : undefined,
    concerns: options.db
      ? concernSection(checklists(options.db, task.id))
      : undefined,
    originDoc: origin
      ? `本任务由 ${origin.ref} ${origin.name} 投来。\n\n${origin.body}`
      : undefined,
    skills: mount?.section,
    rootDoc: docs.rootDoc,
    profileBody: worker.profile.body,
    rules: [where, ...deliveryRules(task), TELL_RULE],
  });
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  const logFile = join(dir, "log");
  const input = {
    promptFile,
    prompt,
    cwd,
    model: worker.cliModel,
    effort: worker.effort,
    resultFile: join(dir, "last-message.md"),
    live: tellMode === "stdin",
  };
  let launch: Launch;
  if (resume) {
    if (!adapter.resume)
      throw new Problem(400, `${adapter.tool} 不支持续上会话`, "usage");
    const tellFile = join(dir, "tell.md");
    writeFileSync(tellFile, resume.text, { mode: 0o600 });
    launch = adapter.resume({
      ...input,
      promptFile: tellFile,
      prompt: resume.text,
      session: resume.session,
    });
  } else launch = adapter.build(input);
  if (mount) {
    launch.args.push(...mount.args);
    if (Object.keys(mount.env).length)
      launch.env = { ...launch.env, ...mount.env };
  }
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
    tellMode,
    tellIds: resume ? [] : unsent(tells).map((tell) => tell.id),
  };
}
