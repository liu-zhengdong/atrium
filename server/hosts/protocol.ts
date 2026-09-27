import type { Tool } from "../tasks/adapters/types.ts";
import type { LocalCheck } from "../tasks/local-check.ts";
import type { AgentRun, HostInfo, HostLoadReport } from "./state.ts";

/**
 * 服务与代理（`atrium agent`）之间的往来（#358 第 1 步）。代理主动连服务：长轮询领指令、另发请求上报日志与退出；
 * 服务只下发四种指令：拉起执行者、停下、在代理机器上跑只读 git、跑本地检查。
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
      kind: "check";
      task: number;
      worktree: string;
      urgent: boolean;
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
    }
  | { ok: false; error: string };

export type ExecReply = { ok: boolean; stdout: string; stderr: string };
export type CheckReply = LocalCheck;

/** 接入：接入码放在 Authorization 头（`Bearer h<N>-…`），认证在读请求体之前。 */
export type JoinBody = { info: HostInfo };
export type HelloBody = { info: HostInfo; runs: AgentRun[] };
export type PollBody = { load: HostLoadReport; busy: string[] };
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
};

/** 一段日志最多传多少字节（base64 前）。 */
export const LOG_CHUNK = 256 * 1024;
/** 长轮询每轮最多挂多久。 */
export const POLL_WAIT_MS = 25_000;
