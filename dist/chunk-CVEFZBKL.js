import {
  recordNext,
  recordResult
} from "./chunk-7NDJVDNM.js";
import {
  discardLegacyIdleRestart,
  readRestartState,
  startSupervisor,
  waitForRestart
} from "./chunk-6ZFPOKLL.js";
import "./chunk-OJ2DJYCO.js";
import {
  alive,
  dataDirectory
} from "./chunk-PMAHYFAT.js";
import {
  Problem
} from "./chunk-HEN5YN5G.js";

// cli/restart.ts
async function restart({
  wait = false,
  timeout,
  "when-idle": whenIdle = false,
  data
}) {
  const dir = data ?? dataDirectory();
  const timeoutSec = Number(timeout ?? "300");
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600)
    throw new Problem(400, "--timeout \u5FC5\u987B\u4E3A 1\u2013600 \u79D2", "usage");
  if (whenIdle)
    console.error(
      "Atrium \u91CD\u542F\u5DF2\u4E0D\u9700\u8981\u7B49\u6267\u884C\u8005\u7A7A\u95F2\uFF0C--when-idle \u4E0D\u518D\u751F\u6548\uFF1B\u76F4\u63A5\u91CD\u542F\uFF0C\u5728\u8DD1\u7684\u6267\u884C\u8005\u7531\u65B0\u670D\u52A1\u63A5\u7BA1"
    );
  discardLegacyIdleRestart(dir);
  const state = readRestartState(dir);
  const isRunning = state && state.supervisorPid > 0 && alive(state.supervisorPid) && (state.status === "stopping" || state.status === "starting" || state.status === "checking" || state.status === "rolling_back");
  if (wait && !state)
    throw new Problem(
      404,
      "\u6CA1\u6709\u53EF\u7B49\u5F85\u7684\u91CD\u542F\u4EFB\u52A1\uFF1B\u5148\u8FD0\u884C atrium restart",
      "not_found"
    );
  if (!wait && isRunning)
    throw new Problem(
      409,
      "\u91CD\u542F\u5DF2\u5728\u8FDB\u884C\u4E2D\uFF1B\u8FD0\u884C atrium restart --wait",
      "conflict"
    );
  if (!wait) {
    await startSupervisor({ data: dir });
  }
  if (!wait) {
    const current = readRestartState(dir);
    console.log(
      `Atrium \u5E73\u6ED1\u91CD\u542F\u5DF2\u542F\u52A8\uFF08\u4EFB\u52A1 ${current?.id ?? "rst"}\uFF09\uFF1B\u5728\u8DD1\u7684\u6267\u884C\u8005\u4E0D\u4E2D\u65AD\uFF0C\u7531\u65B0\u670D\u52A1\u63A5\u7BA1\uFF1B\u91CD\u542F\u671F\u95F4\u7684\u547D\u4EE4\u4F1A\u7B49\u65B0\u670D\u52A1\u5C31\u7EEA`
    );
    recordResult({
      status: "restarting",
      pid: current?.supervisorPid,
      task_id: current?.id
    });
    recordNext("\u7B49\u5F85\u5B8C\u6210\uFF1Aatrium restart --wait");
    return;
  }
  const finalState = await waitForRestart(dir, timeoutSec * 1e3);
  if (finalState.status === "success") {
    console.log(`Atrium \u5DF2\u5E73\u6ED1\u91CD\u542F \xB7 PID ${finalState.newPid}`);
    recordResult({
      status: "success",
      pid: finalState.newPid,
      version: finalState.targetVersion ?? finalState.fromVersion
    });
    recordNext("\u67E5\u770B\u72B6\u6001\uFF1Aatrium status");
  } else if (finalState.status === "rolled_back") {
    console.error(
      `Atrium \u542F\u52A8\u5931\u8D25\uFF0C\u5DF2\u81EA\u52A8\u56DE\u6EDA\u81F3 v${finalState.rollbackVersion ?? finalState.fromVersion}`
    );
    console.error(`\u539F\u7248\u672C\uFF1Av${finalState.fromVersion}`);
    console.error(`\u5931\u8D25\u7248\u672C\uFF1Av${finalState.failedVersion}`);
    console.error(`\u5931\u8D25\u539F\u56E0\uFF1A${finalState.error}`);
    console.error("\u56DE\u6EDA\u7ECF\u8FC7\u8BB0\u5728\u6570\u636E\u76EE\u5F55\u7684 supervisor.log\u3002");
    recordResult({
      status: "rolled_back",
      from: finalState.fromVersion,
      failed: finalState.failedVersion,
      reason: finalState.error
    });
    recordNext("\u67E5\u770B\u72B6\u6001\uFF1Aatrium status");
    throw new Problem(
      500,
      `Atrium \u542F\u52A8\u5931\u8D25\uFF0C\u5DF2\u81EA\u52A8\u56DE\u6EDA\u81F3 v${finalState.rollbackVersion ?? finalState.fromVersion}\uFF1A${finalState.error}`,
      "restart_rollback"
    );
  } else {
    throw new Problem(
      500,
      `Atrium \u91CD\u542F\u5931\u8D25\uFF1A${finalState.error ?? "\u672A\u77E5\u9519\u8BEF"}`,
      "internal"
    );
  }
}
export {
  restart
};
