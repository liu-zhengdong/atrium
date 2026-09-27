import {
  discardLegacyIdleRestart,
  readRestartState,
  startSupervisor,
  waitForRestart,
} from "../server/supervisor.ts";
import { alive, dataDirectory } from "../server/service-state.ts";
import { recordNext, recordResult } from "./contract.ts";
import { Problem } from "../server/problem.ts";

export async function restart({
  wait = false,
  timeout,
  "when-idle": whenIdle = false,
  data,
}: {
  wait?: boolean;
  "when-idle"?: boolean;
  timeout?: string;
  data?: string;
}) {
  const dir = data ?? dataDirectory();
  const timeoutSec = Number(timeout ?? "300");
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600)
    throw new Problem(400, "--timeout 必须为 1–600 秒", "usage");
  // 兼容参数：执行者不随服务退出、新服务按 pid 接管，重启不必等空闲。
  if (whenIdle)
    console.error(
      "Atrium 重启已不需要等执行者空闲，--when-idle 不再生效；直接重启，在跑的执行者由新服务接管",
    );
  discardLegacyIdleRestart(dir);

  const state = readRestartState(dir);
  // #231：supervisor 已退出（被杀或崩溃）时状态会停在进行中；不能因此永久拒绝新的 restart。
  const isRunning =
    state &&
    state.supervisorPid > 0 &&
    alive(state.supervisorPid) &&
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
    await startSupervisor({ data: dir });
  }

  if (!wait) {
    const current = readRestartState(dir);
    console.log(
      `Atrium 平滑重启已启动（任务 ${current?.id ?? "rst"}）；在跑的执行者不中断，由新服务接管；重启期间的命令会等新服务就绪`,
    );
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
    console.log(`Atrium 已平滑重启 · PID ${finalState.newPid}`);
    recordResult({
      status: "success",
      pid: finalState.newPid,
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
    console.error("回滚经过记在数据目录的 supervisor.log。");
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
