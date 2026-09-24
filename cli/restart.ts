import {
  readRestartState,
  startSupervisor,
  waitForRestart,
} from "../server/supervisor.ts";
import { dataDirectory } from "../server/service-state.ts";
import { Store } from "../server/store.ts";
import { join, resolve } from "node:path";
import { recordNext, recordResult } from "./contract.ts";
import { Problem } from "../server/problem.ts";

export async function restart({
  wait = false,
  timeout = "30",
  data,
  "probe-agent": probeAgent,
  "agent-timeout": agentTimeout,
}: {
  wait?: boolean;
  timeout?: string;
  data?: string;
  "probe-agent"?: string;
  "agent-timeout"?: string;
}) {
  const dir = data ?? dataDirectory();
  const timeoutSec = Number(timeout);
  const agentTimeoutMs = agentTimeout ? Number(agentTimeout) : undefined;
  if (
    !Number.isInteger(timeoutSec) ||
    timeoutSec < 1 ||
    timeoutSec > 600 ||
    (agentTimeoutMs !== undefined &&
      (!Number.isInteger(agentTimeoutMs) ||
        agentTimeoutMs < 1000 ||
        agentTimeoutMs > 300000))
  )
    throw new Problem(
      400,
      "timeout 必须为 1–600 秒，agent-timeout 为 1000–300000 毫秒",
      "usage",
    );

  const state = readRestartState(dir);
  const isRunning =
    state &&
    (state.status === "stopping" ||
      state.status === "starting" ||
      state.status === "checking" ||
      state.status === "rolling_back");

  if (wait && !state)
    throw new Problem(
      404,
      "没有可等待的重启任务；先运行 atrium restart",
      "not_found",
    );
  if (!wait && isRunning)
    throw new Problem(
      409,
      "重启已在进行中；运行 atrium restart --wait",
      "conflict",
    );
  if (!wait) {
    // The initiating Agent can finish its tool call before the supervisor
    // samples active turns. Remember it explicitly so it is resumed too.
    let wakeAgent: string | undefined;
    if (process.env.PI_CODING_AGENT_DIR) {
      const store = new Store(join(dir, "atrium.sqlite"));
      try {
        wakeAgent = store
          .agents()
          .find(
            (agent) =>
              agent.agent_directory &&
              resolve(agent.agent_directory) ===
                resolve(process.env.PI_CODING_AGENT_DIR!),
          )?.id;
      } finally {
        store.close();
      }
    }
    await startSupervisor({
      data: dir,
      probeAgent,
      agentTimeout: agentTimeoutMs,
      wakeAgent,
    });
  }

  if (!wait) {
    const current = readRestartState(dir);
    console.log(`Atrium 平滑重启已启动（任务 ${current?.id ?? "rst"}）`);
    recordResult({
      status: "restarting",
      pid: current?.supervisorPid,
      task_id: current?.id,
    });
    recordNext("等待完成：atrium restart --wait");
    return;
  }

  const finalState = await waitForRestart(dir, timeoutSec * 1000);
  if (finalState.status === "success") {
    const wokenStr = finalState.wokenAgents?.length
      ? `\n已唤醒 ${finalState.wokenAgents.length} 个身份：${finalState.wokenAgents.join("、")}`
      : "";
    console.log(`Atrium 已平滑重启 · PID ${finalState.newPid}${wokenStr}`);
    recordResult({
      status: "success",
      pid: finalState.newPid,
      woken_agents: finalState.wokenAgents ?? [],
      version: finalState.targetVersion ?? finalState.fromVersion,
    });
    recordNext("查看状态：atrium status");
  } else if (finalState.status === "rolled_back") {
    console.error(
      `Atrium 启动失败，已自动回滚至 v${finalState.rollbackVersion ?? finalState.fromVersion}`,
    );
    console.error(`原版本：v${finalState.fromVersion}`);
    console.error(`失败版本：v${finalState.failedVersion}`);
    console.error(`失败原因：${finalState.error}`);
    console.error("回滚通知已发送至消息箱。");
    recordResult({
      status: "rolled_back",
      from: finalState.fromVersion,
      failed: finalState.failedVersion,
      reason: finalState.error,
    });
    recordNext("查看状态：atrium status");
    throw new Problem(
      500,
      `Atrium 启动失败，已自动回滚至 v${finalState.rollbackVersion ?? finalState.fromVersion}：${finalState.error}`,
      "restart_rollback",
    );
  } else {
    throw new Problem(
      500,
      `Atrium 重启失败：${finalState.error ?? "未知错误"}`,
      "internal",
    );
  }
}
