import { bridgeEntryArgs } from "../../acp/bridge-entry.ts";
import { agentCommand, type AcpToolSpec } from "./acp-spec.ts";
import {
  DEFAULT_WATCHDOG,
  checkCommon,
  invalid,
  type Adapter,
  type Launch,
  type LaunchInput,
} from "./types.ts";

/**
 * 档案接入的 ACP 工具（#418）：拉起的是 ACP 桥（server/acp/bridge-main.ts），工具命令放在 `--` 之后，
 * 进程命令行里带着工具名（接管与清残留据此认进程）。提示词与捎话走桥的标准输入（claude stream-json 的用户消息），
 * 日志是 claude stream-json 格式，所以摘要、最近动作、看门狗、回显确认、接管后退出都按 claude 的规则读。
 * 捎话即时写进标准输入，桥排到本轮之后作为追加消息；服务重启后接管的按会话 id 续上（工具须声明 loadSession）。
 */

const SESSION_RE =
  /"type":"system","subtype":"init","session_id":"([^"\n]{1,200})"/;
const SESSION_ID_RE = /^[\w.:@/+=-]{1,200}$/;

function launch(
  spec: AcpToolSpec,
  adapter: Adapter,
  input: LaunchInput,
  session?: string,
): Launch {
  checkCommon(adapter, input);
  if (session !== undefined && !SESSION_ID_RE.test(session))
    throw invalid(`会话 id 不合法：${session}`);
  const agent = agentCommand(spec, input);
  const args = [
    ...bridgeEntryArgs(),
    "--tool",
    spec.name,
    "--input",
    input.live ? "stream-json" : "text",
    "--permissions",
    spec.permissions,
  ];
  if (agent.viaSession.model) args.push("--model", agent.viaSession.model);
  if (agent.viaSession.effort) args.push("--effort", agent.viaSession.effort);
  if (session !== undefined) args.push("--resume", session);
  args.push("--", agent.command, ...agent.args);
  return {
    command: process.execPath,
    args,
    cwd: input.cwd,
    stdin: input.promptFile,
    ...(input.live ? { input: "stream-json" as const } : {}),
  };
}

export function acpAdapter(spec: AcpToolSpec): Adapter {
  const adapter: Adapter = {
    tool: spec.name,
    executable: spec.command,
    promptVia: "stdin",
    exclusive: spec.exclusive,
    ...(spec.efforts ? { efforts: spec.efforts } : {}),
    quotaProvider: spec.quota,
    watchdog: DEFAULT_WATCHDOG,
    progressSignals: ["json_events", "worktree_change"],
    notes: [
      `经 ACP 接入（harness/${spec.name}），不参与自动挑选，派活时写明执行者`,
      "续上会话要求工具声明 loadSession",
    ],
    tell: "stdin",
    tellAfterTurn: true,
    logFormat: "claude-stream",
    // 新接入、还没有交付记录的工具先压低；档案写了 trust / max_risk 就以档案为准。
    defaultRules: { trust: "unknown", max_risk: "low" },
    build: (input) => launch(spec, adapter, input),
    resume: (input) => launch(spec, adapter, input, input.session),
    sessionOf: (log) => SESSION_RE.exec(log)?.[1],
  };
  return adapter;
}
