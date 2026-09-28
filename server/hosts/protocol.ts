import type { LaunchEndpoint, Tool } from "../tasks/adapters/types.ts";
import type { LeftoverKill, LeftoverTarget } from "../tasks/leftovers.ts";
import type { ReaderOutcome } from "../quota-readers/index.ts";
import type {
  SkillCopy,
  SkillMountAck,
  SkillReport,
} from "../skills/remote.ts";
import type { AgentRun, HostInfo, HostLoadReport } from "./state.ts";

/**
 * 服务与代理（`atrium agent`）之间的往来（#358 第 1、2 步）。代理主动连服务：长轮询领指令、另发请求上报日志、退出与额度；
 * 服务只下发四种指令：拉起执行者、停下、在代理机器上跑只读 git、清残留执行者进程（t217）。检查只在服务那台跑。
 */

/** 派到代理的一次运行：提示词由服务写好，代理在自己机器上建工作树、按适配器拉起。 */
export type Assignment = {
  task: number;
  ref: string;
  /** 这个任务在这台主机上的第几轮；日志与退出按它对上。 */
  run: number;
  worker: string;
  tool: Tool;
  model?: string;
  effort?: string;
  prompt: string;
  /** 续上原会话（捎话）：带着这段补充，不重发整份提示词；日志接着写。 */
  resume?: { session: string; text: string };
  /** 代理数据目录下的任务目录与执行者工作目录。 */
  dir: string;
  cwd: string;
  repo?: {
    url: string;
    clone: string;
    worktree: string;
    branch: string;
    base: string;
  };
  /**
   * 任务声明的凭据（t194）：名称 → 值，代理按名称合进执行者环境（secrets/model.ts withSecrets）。
   * 只在这条指令里（服务与代理都只放内存），代理不落盘、不写日志。
   */
  secrets?: Record<string, string>;
  /**
   * 这次要挂的组织技能（t232）：代理挂在任务目录里，把「本次挂载的技能」段填进提示词的占位处。
   * 只发给上报了 `skills` 能力的代理。
   */
  skills?: SkillCopy[];
  /** 执行者档案写的自定义模型端点（t271）：代理照本机一样交给适配器；密钥随 secrets 按变量名给。 */
  endpoint?: LaunchEndpoint;
};

export type AgentCommand =
  | { id: string; kind: "launch"; assignment: Assignment }
  | {
      id: string;
      kind: "stop";
      task: number;
      run: number;
      signal: "SIGTERM" | "SIGKILL";
    }
  | { id: string; kind: "exec"; args: string[]; timeoutMs: number }
  | {
      id: string;
      kind: "clean";
      /** 服务下发时的时钟：代理据此把 targets 里的时刻换成自己的。 */
      now: number;
      /** 所属任务已结束的执行者：代理核对还活着、命令行与启动时刻对得上的才结束（leftovers.ts）。 */
      targets: LeftoverTarget[];
    };

/** 拉起的回执：pid、本轮日志从远程日志文件的哪个字节开始、代理实际的进程调用（写进日志抬头的那份）。 */
export type LaunchAck =
  | {
      ok: true;
      pid: number;
      offset: number;
      launch: {
        command: string;
        args: string[];
        cwd: string;
        input?: "stream-json";
      };
      /** 带了技能时的挂载结果（t232）。 */
      skills?: SkillMountAck;
    }
  | { ok: false; error: string };

export type ExecReply = { ok: boolean; stdout: string; stderr: string };
/** 清理回执：结束了哪些进程树。旧版代理不认这条指令时回 `{ ok: false, error }`。 */
export type CleanReply = { killed: LeftoverKill[] };
/** 接入：接入码放在 Authorization 头（`Bearer h<N>-…`），认证在读请求体之前。 */
export type JoinBody = { info: HostInfo };
export type HelloBody = { info: HostInfo; runs: AgentRun[] };
export type PollBody = { load: HostLoadReport; busy: string[] };
/** 长轮询的回答：代理手上还没有的指令。 */
export type PollReply = { commands: AgentCommand[] };
export type LogBody = {
  task: number;
  run: number;
  offset: number;
  data: string;
};
export type ExitBody = {
  task: number;
  run: number;
  /** null：代理重启后发现进程已不在，退出码不可得。 */
  exit: { code: number | null; signal: string | null } | null;
  /** 远程日志的总字节数：服务还没收全时让代理先补传。 */
  size: number;
  /** codex 这类工具写的最后消息文件内容。 */
  last_message?: string;
  /** 执行者改过的技能副本（t232）：服务落到本机任务目录，收尾时生成修订提议。 */
  skills?: SkillReport;
};

/** 代理读到的额度（自带读取器，#352）：只有额度数字与账号指纹，不含令牌。 */
export type QuotaBody = {
  readings: { provider: string; outcome: ReaderOutcome }[];
};

/** 一段日志最多传多少字节（base64 前）。 */
export const LOG_CHUNK = 256 * 1024;
/** 长轮询每轮最多挂多久。 */
export const POLL_WAIT_MS = 25_000;
