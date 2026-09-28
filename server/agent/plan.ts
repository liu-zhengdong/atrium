import { secretNameProblem } from "../secrets/model.ts";
import {
  MAX_BUNDLE_BYTES,
  type AgentCommand,
  type Assignment,
  type CheckSource,
} from "../hosts/protocol.ts";
import { insideData, isKnownTool } from "../hosts/state.ts";
import { targetsRefusal } from "../tasks/leftovers.ts";

/**
 * 代理这一侧的判定（#358 第 1 步）：服务派来的指令能不能照做。纯函数，穷举测试。
 * 服务是用户自己的，但代理仍只照做五种指令，路径必须落在代理数据目录里，git 只跑查询与清理用的子命令，
 * 清残留进程只结束清单里核对得上的执行者（leftovers.ts）。
 */

/** 服务查事实、探进展、清理工作树用到的 git 子命令。 */
const GIT_SUBCOMMANDS = new Set([
  "remote",
  "diff",
  "status",
  "rev-list",
  "rev-parse",
  "ls-remote",
  "cat-file",
  "worktree",
  "branch",
  "symbolic-ref",
  "show-ref",
  "log",
]);

/** 允许的 git 调用：前面只能有 `--no-optional-locks` 与 `-C <代理数据目录里的路径>`，子命令在白名单里。 */
export function gitRefusal(
  args: readonly unknown[],
  os: string,
  dataDir: string,
): string | null {
  if (!args.every((arg) => typeof arg === "string")) return "git 参数应为文本";
  const list = args as string[];
  let index = 0;
  while (index < list.length) {
    const arg = list[index]!;
    if (arg === "--no-optional-locks") {
      index++;
      continue;
    }
    if (arg === "-C") {
      const path = list[index + 1];
      if (!path || !(insideData(os, dataDir, path) || same(os, dataDir, path)))
        return "git -C 的路径不在代理数据目录里";
      index += 2;
      continue;
    }
    break;
  }
  const sub = list[index];
  if (!sub || !GIT_SUBCOMMANDS.has(sub))
    return `不接受 git ${sub ?? ""}`.trim();
  if (
    list.some(
      (arg) =>
        arg === "-c" ||
        arg.startsWith("--exec-path") ||
        arg.startsWith("--upload-pack") ||
        arg.startsWith("--config"),
    )
  )
    return "不接受改 git 配置或外部命令的参数";
  return null;
}

const same = (os: string, a: string, b: string) =>
  (os === "win32" ? a.toLowerCase() : a) ===
  (os === "win32" ? b.toLowerCase() : b);

/** 拉起指令：工具认识、路径都在代理数据目录里、克隆地址像个地址。 */
export function assignmentRefusal(
  a: Assignment,
  os: string,
  dataDir: string,
): string | null {
  if (!Number.isSafeInteger(a.task) || a.task < 1) return "任务号不合法";
  if (!Number.isSafeInteger(a.run) || a.run < 1) return "轮号不合法";
  if (!isKnownTool(a.tool)) return `不认识的执行者工具：${String(a.tool)}`;
  if (typeof a.prompt !== "string" || !a.prompt.trim()) return "提示词为空";
  const paths = [a.dir, a.cwd, a.repo?.clone, a.repo?.worktree].filter(
    (path): path is string => path !== undefined,
  );
  if (
    paths.some(
      (path) => typeof path !== "string" || !insideData(os, dataDir, path),
    )
  )
    return "派来的路径不在代理数据目录里";
  if (a.repo) {
    if (!a.repo.url || /^-/.test(a.repo.url) || /[\s]/.test(a.repo.url))
      return "仓库地址不合法";
    if (
      !/^[A-Za-z0-9._/-]+$/.test(a.repo.branch) ||
      a.repo.branch.startsWith("-")
    )
      return "分支名不合法";
    if (!/^[A-Za-z0-9._/-]+$/.test(a.repo.base) || a.repo.base.startsWith("-"))
      return "基础分支名不合法";
  }
  if (a.secrets !== undefined) {
    if (
      typeof a.secrets !== "object" ||
      a.secrets === null ||
      Array.isArray(a.secrets)
    )
      return "凭据不合法";
    for (const [name, value] of Object.entries(a.secrets)) {
      // 只报名称的毛病，不带值。
      const problem = secretNameProblem(name);
      if (problem) return `凭据名称不合法：${problem}`;
      if (typeof value !== "string" || !value || value.includes("\0"))
        return `凭据 ${name} 的值不合法`;
    }
  }
  return null;
}

const REF_NAME = /^[A-Za-z0-9._/-]+$/;

/** 按提交检查的来源：克隆在代理数据目录里、地址像个地址、提交是完整哈希、bundle 不超限。 */
export function sourceRefusal(
  source: CheckSource,
  os: string,
  dataDir: string,
): string | null {
  if (typeof source !== "object" || source === null) return "检查来源不合法";
  if (
    typeof source.clone !== "string" ||
    !insideData(os, dataDir, source.clone)
  )
    return "检查的克隆不在代理数据目录里";
  if (
    typeof source.url !== "string" ||
    !source.url ||
    /^-/.test(source.url) ||
    /\s/.test(source.url)
  )
    return "仓库地址不合法";
  if (
    typeof source.commit !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(source.commit)
  )
    return "提交号不合法";
  if (
    typeof source.base !== "string" ||
    !REF_NAME.test(source.base) ||
    source.base.startsWith("-")
  )
    return "基础分支名不合法";
  if (
    source.bundle !== undefined &&
    (typeof source.bundle !== "string" ||
      source.bundle.length > Math.ceil(MAX_BUNDLE_BYTES / 3) * 4)
  )
    return "提交包太大或不合法";
  return null;
}

/** 这条指令代理照不照做；不照做时回执里写原因。 */
export function commandRefusal(
  command: AgentCommand,
  os: string,
  dataDir: string,
): string | null {
  switch (command.kind) {
    case "launch":
      return assignmentRefusal(command.assignment, os, dataDir);
    case "exec":
      return gitRefusal(command.args, os, dataDir);
    case "check":
      if ((command.worktree === undefined) === (command.source === undefined))
        return "检查要么给工作树、要么给提交";
      if (command.source) return sourceRefusal(command.source, os, dataDir);
      return typeof command.worktree === "string" &&
        insideData(os, dataDir, command.worktree)
        ? null
        : "检查的工作树不在代理数据目录里";
    case "stop":
      return command.signal === "SIGTERM" || command.signal === "SIGKILL"
        ? null
        : "不认识的信号";
    case "clean":
      return Number.isFinite(command.now)
        ? targetsRefusal(command.targets)
        : "下发时刻不合法";
    default:
      return "不认识的指令";
  }
}

/**
 * 退出上报前要不要先补传日志：服务回了它收到的位置，比本地文件短就从那里接着传。
 * 返回下一段从哪开始、传多少；传完了返回 null。
 */
export function nextChunk(
  uploaded: number,
  size: number,
  max: number,
): { offset: number; length: number } | null {
  if (uploaded >= size) return null;
  return { offset: uploaded, length: Math.min(max, size - uploaded) };
}
