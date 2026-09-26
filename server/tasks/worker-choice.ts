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

export type Choice = {
  worker: ResolvedWorker;
  risk: Risk;
  /** 该执行者的账号额度标记未到期：先排队，到这个时刻再派（#267）。 */
  waitUntil?: number;
};

/**
 * 解析执行者：写了就按写的（须已装），没写按额度富余挑、避开额度标记未到期的账号；
 * 再按档案校验 max_risk。写死的执行者或全部可用执行者都被标记时，带上 waitUntil 交给调用方排队。
 */
export async function chooseWorker(
  request: RunRequest,
  options: LaunchOptions,
  held: ReadonlyMap<string, number> = new Map(),
): Promise<Choice> {
  const risk: Risk = request.risk ?? "low";
  const path = options.env.PATH ?? "";
  let worker: ResolvedWorker;
  let waitUntil: number | undefined;
  if (request.worker) {
    worker = await resolveWorker(request.worker, options.workersDir);
    if (!findExecutable(ADAPTERS[worker.tool].executable, path))
      throw new Problem(
        400,
        `执行者 ${worker.tool} 没装：PATH 上找不到 ${ADAPTERS[worker.tool].executable}`,
        "usage",
      );
    waitUntil = held.get(ADAPTERS[worker.tool].quotaProvider);
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
    let picked = pickWorker({ installed, pace, risk, profiles, held });
    if (!picked.ok && held.size) {
      // 能用的都被额度标记：照常挑一个，排队等它的账号恢复。
      const waiting = pickWorker({ installed, pace, risk, profiles });
      if (waiting.ok) {
        picked = waiting;
        waitUntil = held.get(ADAPTERS[waiting.tool].quotaProvider);
      }
    }
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
  return waitUntil === undefined
    ? { worker, risk }
    : { worker, risk, waitUntil };
}
