import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../problem.ts";
import {
  ADAPTERS,
  type Adapter,
  type Launch,
  type LaunchInput,
} from "./adapters/index.ts";
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
import { alsoOf } from "./also.ts";
import { getJobRole } from "./job-roles.ts";
import { skillsForTask } from "../skills/task-skills.ts";
import { mountSkills } from "../skills/mount.ts";
import { homedir } from "node:os";
import { listTells, unsent } from "./tell-ledger.ts";
import { TELL_RULE, tellModeOf, tellSection } from "./tell.ts";
import type { TellMode } from "./adapters/index.ts";
import { checklists } from "./concerns.ts";
import { concernSection } from "./concern-gate.ts";
import { patrolRun } from "./patrol.ts";
import { firstLine } from "./git.ts";
import { remoteLayout } from "../hosts/state.ts";

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
  env: NodeJS.ProcessEnv;
  /** 隔离服务显式指定的数据与端口，巡检进程据此连回该服务。 */
  patrolServiceEnv?: NodeJS.ProcessEnv;
  run?: Exec;
  pace?: () => Promise<PaceEntry[] | undefined>;
  /** 用量快照单独采样；测试可注入假 OpenQuota，不改变挑人采样次数。 */
  usagePace?: () => Promise<PaceEntry[] | undefined>;
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
  /** 派到远程主机（#358）：cwd、worktree 是那台机器上的路径，launch 在代理回执后换成它实际的调用。 */
  remote?: RemotePlan;
};

/** 远程主机（#358）：系统与代理数据目录决定那台机器上的路径。 */
export type RemoteSite = { host: number; os: string; data_dir: string };

/** 交给代理的：提示词、那台机器上的任务目录，有仓库时怎么克隆、在哪建工作树。 */
export type RemotePlan = {
  host: number;
  prompt: string;
  dir: string;
  resume?: ResumeWith;
  repo?: {
    url: string;
    clone: string;
    worktree: string;
    branch: string;
    base: string;
  };
};

/** 续上原会话：带着这段补充，不重发整份提示词。 */
export type ResumeWith = { session: string; text: string };

/** 详述只读库里的内容（#355）；只有来源路径没有内容，是旧任务回填时没读到，让用户补上。 */
function briefOf(task: Task) {
  if (task.brief != null) return task.brief;
  if (!task.brief_path) return undefined;
  throw new Problem(
    400,
    `${task.ref} 的任务详述没有进库（原文件 ${task.brief_path} 读不到）`,
    "usage",
    undefined,
    `atrium task set ${task.ref} --brief 文件`,
  );
}

/**
 * 按适配器算出进程调用；续上会话时把补充写进 tellFile，以它为这次的提示词。
 * 本机派活与远程代理（server/agent/）共用这一份。
 */
export function buildLaunch(
  adapter: Adapter,
  input: LaunchInput,
  resume?: ResumeWith & { file: string },
): Launch {
  if (!resume) return adapter.build(input);
  if (!adapter.resume)
    throw new Problem(400, `${adapter.tool} 不支持续上会话`, "usage");
  writeFileSync(resume.file, resume.text, { mode: 0o600 });
  return adapter.resume({
    ...input,
    promptFile: resume.file,
    prompt: resume.text,
    session: resume.session,
  });
}

/**
 * 建工作目录、写提示词、算出进程调用；不拉起。
 * 给了 site（远程主机）时不在本机建工作树、不挂技能：只算那台机器上的路径、写好提示词，交给代理去建和拉起。
 */
export async function prepareRun(
  task: Task,
  chosen: { worker: ResolvedWorker; risk: Risk },
  options: LaunchOptions,
  resume?: ResumeWith,
  site?: RemoteSite,
): Promise<Prepared> {
  const run = options.run ?? exec;
  const { worker } = chosen;
  const adapter = ADAPTERS[worker.tool];
  const tellMode = tellModeOf(adapter, worker.profile.rules.tell);
  const tells = options.db ? listTells(options.db, task.id) : [];
  const dir = taskDir(options.data, task.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const brief = briefOf(task);
  let cwd: string;
  let worktree: string | null = null;
  let branch: string | null = null;
  let base: string | null = null;
  let remote: RemotePlan | undefined;
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
    if (site) {
      const origin = await run(
        "git",
        ["-C", task.repo, "remote", "get-url", "origin"],
        { timeoutMs: 10_000 },
      );
      const url = origin.ok ? origin.stdout.trim() : "";
      if (!url)
        throw new Problem(
          409,
          `读不到仓库 ${task.repo} 的 origin 远端，远程主机无从克隆：${firstLine(origin.stderr) || "没有 origin"}`,
          "conflict",
        );
      const layout = remoteLayout(site, { id: task.id, slug: plan.slug }, url);
      cwd = worktree = layout.worktree!;
      remote = {
        host: site.host,
        prompt: "",
        dir: layout.dir,
        repo: {
          url,
          clone: layout.clone!,
          worktree: layout.worktree!,
          branch: plan.branch,
          base,
        },
      };
    } else {
      await ensureWorktree(task.repo, plan, base, run);
      cwd = worktree = plan.path;
    }
    branch = plan.branch;
  } else if (site) {
    const layout = remoteLayout(site, { id: task.id, slug: null }, null);
    cwd = layout.cwd;
    remote = { host: site.host, prompt: "", dir: layout.dir };
  } else {
    cwd = join(dir, "work");
    mkdirSync(cwd, { recursive: true });
  }
  const node = options.db ? taskNode(options.db, task) : undefined;
  const origin =
    options.db && task.origin_node_id !== null
      ? nodeDoc(options.db, task.origin_node_id)
      : undefined;
  const job =
    options.db && task.job_id
      ? getJobRole(options.db, `r${task.job_id}`)
      : undefined;
  const patrol = options.db ? patrolRun(options.db, task.id) : undefined;
  // 远程的工作树不在本机：说明文件读本机仓库的。
  const docs = task.repo
    ? await loadRoleDocs(site ? task.repo : (worktree ?? task.repo), node)
    : { roleDoc: node?.body ?? "", rootDoc: "" };
  // 组织技能：节点链上绑定的 ∪ 档案指定的，拷进任务目录，只对这次运行生效。
  const picked =
    options.db && !patrol
      ? skillsForTask(options.db, task, {
          ...worker.profile.rules,
          skills: [
            ...new Set([
              ...(Array.isArray(worker.profile.rules.skills)
                ? worker.profile.rules.skills
                : []),
              ...(job?.skills ?? []),
            ]),
          ],
        })
      : undefined;
  // 远程主机上暂不挂载组织技能（技能副本在本机任务目录），记一笔。
  if (site && options.db && picked?.skills.length)
    noteTask(options.db, task.id, "skills_skipped", {
      host: `h${site.host}`,
      reason: "远程主机上暂不挂载组织技能",
      skills: picked.skills.map((skill) => skill.slug),
    });
  const mount =
    picked && !site
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
    brief: patrol
      ? `节点：o${patrol.node_id}\n本轮场景：${patrol.scenario}\n一件事怎么走完：${(JSON.parse(patrol.flow) as string[]).map((step, i) => `${i + 1}. ${step}`).join("\n") || "按场景自行走通"}\n\n按场景实际操作；只读全景、帮助和命令回执。遇到问题用 atrium patrol report ${task.ref} --phenomenon 简短现象 --step 哪一步 --command '实际命令' --expected '预期' --actual '实际' --kind broken|awkward 记录。无发现也正常结束。`
      : brief,
    tells: tellSection(tells),
    roleDoc: [
      patrol
        ? "# 体验巡检\n\n把自己当用户使用 Atrium，找核心体验上的毛病。不读代码、不改代码、不查凭据或权限边界。不直接建改动任务；发现交给节点 leader。"
        : "",
      job
        ? `# 干活的专员：${job.name}\n\n${job.body}\n\n交付要求：${job.checks.join("、") || "按任务与档案要求"}`
        : "",
      patrol ? "" : docs.roleDoc,
    ]
      .filter(Boolean)
      .join("\n\n"),
    charter:
      options.db && !patrol
        ? withContext(
            node ? charterBrief(options.db, node.id) : undefined,
            taskContext(
              options.db,
              task.part_id ?? node?.id ?? null,
              alsoOf(options.db, task.id),
            ),
          )
        : undefined,
    concerns: options.db
      ? concernSection(checklists(options.db, task.id))
      : undefined,
    originDoc: origin
      ? `本任务由 ${origin.ref} ${origin.name} 投来。\n\n${origin.body}`
      : undefined,
    skills: patrol ? undefined : mount?.section,
    rootDoc: patrol ? undefined : docs.rootDoc,
    profileBody: patrol ? undefined : worker.profile.body,
    rules: patrol
      ? [
          "直接使用当前服务与真实数据。只看 atrium map / org show 的人话字段、atrium --help、atrium guide 和命令回执；不读仓库代码。只运行与本轮场景有关的命令；有副作用的操作只按场景实际需要执行。",
          "每个不同现象只报告一次；结束后报告你走过的步骤。",
        ]
      : [where, ...deliveryRules(task), TELL_RULE],
  });
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  const logFile = join(dir, "log");
  if (remote)
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
      launch: { command: adapter.executable, args: [], cwd },
      tellMode,
      tellIds: resume ? [] : unsent(tells).map((tell) => tell.id),
      remote: { ...remote, prompt, ...(resume ? { resume } : {}) },
    };
  const launch = buildLaunch(
    adapter,
    {
      promptFile,
      prompt,
      cwd,
      model: worker.cliModel,
      effort: worker.effort,
      resultFile: join(dir, "last-message.md"),
      live: tellMode === "stdin",
    },
    resume ? { ...resume, file: join(dir, "tell.md") } : undefined,
  );
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
