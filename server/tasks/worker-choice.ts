import { Problem } from "../problem.ts";
import {
  ADAPTERS,
  detectInstalled,
  findExecutable,
  type Tool,
} from "./adapters/index.ts";
import { riskRefusal, type RunRequest } from "./plan.ts";
import { pickWorker, readPace } from "./prepare.ts";
import { resolveWorker, type ResolvedWorker, type Risk } from "./profiles.ts";
import type { LaunchOptions } from "./workspace.ts";

/**
 * 解析执行者（#262）：读档案、查是否已装、按额度挑；判定本身在 plan.ts / prepare.ts 的纯函数里。
 */

/** 解析执行者：写了就按写的（须已装），没写按额度富余挑；再按档案校验 max_risk。 */
export async function chooseWorker(
  request: RunRequest,
  options: LaunchOptions,
): Promise<{ worker: ResolvedWorker; risk: Risk }> {
  const risk: Risk = request.risk ?? "low";
  const path = options.env.PATH ?? "";
  let worker: ResolvedWorker;
  if (request.worker) {
    worker = await resolveWorker(request.worker, options.workersDir);
    if (!findExecutable(ADAPTERS[worker.tool].executable, path))
      throw new Problem(
        400,
        `执行者 ${worker.tool} 没装：PATH 上找不到 ${ADAPTERS[worker.tool].executable}`,
        "usage",
      );
  } else {
    const installed = detectInstalled(path);
    const tools = Object.keys(installed) as Tool[];
    const profiles = Object.fromEntries(
      await Promise.all(
        tools.map(async (tool) => [
          tool,
          (await resolveWorker(tool, options.workersDir)).profile,
        ]),
      ),
    );
    const pace = await (options.pace ?? (() => readPace()))();
    const picked = pickWorker({ installed, pace, risk, profiles });
    if (!picked.ok)
      throw new Problem(
        409,
        `${picked.reason}（${picked.skipped.map((skip) => `${skip.tool}：${skip.reason}`).join("；")}）`,
        "conflict",
      );
    worker = await resolveWorker(picked.tool, options.workersDir);
  }
  const refusal = riskRefusal(worker.id, worker.profile.rules.max_risk, risk);
  if (refusal) throw new Problem(400, refusal, "usage");
  return { worker, risk };
}
