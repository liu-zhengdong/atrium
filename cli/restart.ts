import {
  readRestartState,
  startSupervisor,
  waitForRestart,
} from "../server/supervisor.ts";
import { alive, dataDirectory } from "../server/service-state.ts";
import { recordNext, recordResult } from "./contract.ts";
import { Problem } from "../server/problem.ts";
import { startService } from "../server/service.ts";
import { serviceUrl } from "../server/service-state.ts";
import { missingRoute, outdatedService } from "./version-check.ts";

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
  const timeoutSec = Number(timeout ?? (whenIdle ? "1800" : "300"));
  if (
    !Number.isInteger(timeoutSec) ||
    timeoutSec < 1 ||
    timeoutSec > (whenIdle ? 7200 : 600)
  )
    throw new Problem(
      400,
      `--timeout 必须为 1–${whenIdle ? 7200 : 600} 秒`,
      "usage",
    );

  if (whenIdle) {
    if (wait) throw new Problem(400, "--when-idle 不能与 --wait 同用", "usage");
    const record = await startService(dir);
    const response = await fetch(
      `${serviceUrl(record)}/api/service/restart-when-idle`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${record.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ timeout: timeoutSec * 1000 }),
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      task_id?: string;
      running?: string[];
      error?: string;
      code?: string;
    };
    // 旧服务没有这个接口：路由未登记会落到用户认证回 401，不能当认证问题报。
    if (!response.ok && missingRoute(response.status, result, true)) {
      const outdated = await outdatedService(record);
      if (outdated) throw outdated;
    }
    if (!response.ok)
      throw new Problem(
        response.status,
        result.error ?? "待重启请求失败",
        "conflict",
      );
    console.log(
      `Atrium 已安排空闲时重启（任务 ${result.task_id}）；还有 ${result.running?.length ?? 0} 个执行者在跑${result.running?.length ? `：${result.running.join("、")}` : ""}`,
    );
    recordResult({
      status: "waiting_idle",
      task_id: result.task_id,
      running: result.running ?? [],
    });
    recordNext("查看进度：atrium status");
    return;
  }

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
  if (!wait && state?.status === "waiting_idle")
    throw new Problem(
      409,
      "已有待重启请求；运行 atrium status 查看进度",
      "conflict",
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
  } else if (finalState.status === "idle_timeout") {
    throw new Problem(
      504,
      `等待执行者空闲超时；超时时仍在运行：${finalState.remainingTasks?.join("、") || "未知"}。未强制停止执行者`,
      "restart_timeout",
    );
  } else {
    throw new Problem(
      500,
      `Atrium 重启失败：${finalState.error ?? "未知错误"}`,
      "internal",
    );
  }
}
