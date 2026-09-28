import { Problem } from "../problem.ts";
import {
  ADAPTERS,
  checkEffort,
  detectInstalled,
  findExecutable,
  type Tool,
} from "./adapters/index.ts";
import { riskRefusal, trustRefusal, type RunRequest } from "./plan.ts";
import { pickWorker, readPace, type PickInput } from "./prepare.ts";
import { endpointFit } from "./endpoint.ts";
import { resolveWorker, type ResolvedWorker, type Risk } from "./profiles.ts";
import type { LaunchOptions } from "./workspace.ts";
import { readQuotaReservePercent, overReserve } from "./budget.ts";
import { quotaHeadroom } from "./usage-budget.ts";
import { BudgetProblem } from "./budget-problem.ts";

/**
 * 解析执行者（#262）：读档案、查是否已装、按额度挑；判定本身在 plan.ts / prepare.ts 的纯函数里。
 */

export type Choice = {
  worker: ResolvedWorker;
  risk: Risk;
  /** 该执行者的账号额度标记未到期：先排队，到这个时刻再派（#267）。 */
  waitUntil?: number;
};

/** 自动挑人时的避让：busy 是已有任务在跑的工具（独占的排到空闲候选之后），exclude 这次不挑。 */
export type Avoid = {
  busy?: ReadonlySet<Tool>;
  /** 任务所在节点链：档案 avoid_nodes 命中的执行者自动挑人时跳过（写死执行者不受影响）。 */
  chain?: PickInput["chain"];
  exclude?: ReadonlySet<Tool>;
  requireTrust?: boolean;
  /** 派到远程主机（#358）：按那台上报的已装工具算，不看本机 PATH。 */
  installed?: Partial<Record<Tool, string>>;
};

/**
 * 解析执行者：写了就按写的（须已装），没写按额度富余挑、避开额度标记未到期的账号与正忙的独占执行者；
 * 再按档案校验 max_risk。写死的执行者或全部可用执行者都被标记时，带上 waitUntil 交给调用方排队。
 */
export async function chooseWorker(
  request: RunRequest,
  options: LaunchOptions,
  held: ReadonlyMap<string, number> = new Map(),
  avoid: Avoid = {},
): Promise<Choice> {
  const risk: Risk = request.risk ?? "low";
  const path = options.env.PATH ?? "";
  let worker: ResolvedWorker;
  let waitUntil: number | undefined;
  const reservePercent = readQuotaReservePercent(
    options.db,
    avoid.chain?.at(-1)?.id,
  );
  const pace = await (options.pace ?? (() => readPace()))();
  const headroom = options.db ? quotaHeadroom(pace, reservePercent) : new Map();
  if (request.worker) {
    worker = await resolveWorker(request.worker, options.db);
    // 写死的执行者：强度、模型搭配不合法当场报错，不等排到了才失败。
    checkEffort(ADAPTERS[worker.tool], worker.effort);
    ADAPTERS[worker.tool].checkModel?.(worker.cliModel, worker.effort);
    // 档案写的自定义端点这个工具接不了（t271）：当场说清楚，不等排到了才失败。
    const fit = endpointFit(ADAPTERS[worker.tool]!, worker.profile.rules);
    if (fit) throw new Problem(400, `执行者 ${worker.id}：${fit}`, "usage");
    if (
      avoid.installed
        ? !avoid.installed[worker.tool]
        : !findExecutable(ADAPTERS[worker.tool].executable, path)
    )
      throw new Problem(
        400,
        avoid.installed
          ? `执行者 ${worker.tool} 在这台主机上没装或没登录`
          : `执行者 ${worker.tool} 没装：PATH 上找不到 ${ADAPTERS[worker.tool].executable}`,
        "usage",
      );
    const account = ADAPTERS[worker.tool].quotaProvider;
    const room = headroom.get(account);
    if (pace && room && room.points < 1)
      throw new BudgetProblem(
        `执行者 ${worker.tool} 的账号 ${account} 份额不足：${room.reason}；等窗口重置或请上层调整份额`,
      );
    if (worker.profile.rules.billing === "metered")
      throw new BudgetProblem(
        `执行者 ${worker.tool} 的档案 billing=metered（按量计费），不派`,
      );
    const used = pace?.find(
      (entry) =>
        entry.providerId === account &&
        overReserve(entry.usedPercent, reservePercent),
    );
    if (used) {
      const installed = avoid.installed ?? detectInstalled(path);
      const tools = Object.keys(installed) as Tool[];
      const profiles = Object.fromEntries(
        await Promise.all(
          tools.map(async (tool) => [
            tool,
            (await resolveWorker(tool, options.db)).profile,
          ]),
        ),
      );
      const picked = pickWorker({
        installed,
        pace,
        risk,
        profiles,
        held,
        reservePercent,
        headroom,
      });
      const available = picked.ok
        ? picked.available.filter((tool) => tool !== worker.tool)
        : [];
      throw new Problem(
        409,
        `执行者 ${worker.tool} 的账号 ${account} 已用额度 ${used.usedPercent}%，达到章程上限 ${100 - reservePercent}%（须留 ${reservePercent}% 给用户）；${available.length ? `可选的其他执行者：${available.join("、")}` : "目前没有可选的其他执行者"}`,
        "conflict",
      );
    }
    waitUntil = held.get(ADAPTERS[worker.tool].quotaProvider);
  } else {
    const installed = avoid.installed ?? detectInstalled(path);
    const tools = Object.keys(installed) as Tool[];
    const profiles = Object.fromEntries(
      await Promise.all(
        tools.map(async (tool) => [
          tool,
          (await resolveWorker(tool, options.db)).profile,
        ]),
      ),
    );
    let picked = pickWorker({
      installed,
      pace,
      risk,
      profiles,
      held,
      reservePercent,
      headroom,
      ...avoid,
    });
    if (!picked.ok && held.size) {
      // 能用的都被额度标记：照常挑一个，排队等它的账号恢复。
      const waiting = pickWorker({
        installed,
        pace,
        risk,
        profiles,
        reservePercent,
        headroom,
        ...avoid,
      });
      if (waiting.ok) {
        picked = waiting;
        waitUntil = held.get(ADAPTERS[waiting.tool].quotaProvider);
      }
    }
    if (!picked.ok) {
      const blocked = picked.skipped.some(
        (skip) =>
          skip.reason.includes("份额") ||
          skip.reason.includes("billing=metered"),
      );
      const message = `${picked.reason}（${picked.skipped.map((skip) => `${skip.tool}：${skip.reason}`).join("；")}）`;
      if (blocked)
        throw new BudgetProblem(`${message}；等窗口重置或请上层调整份额`);
      throw new Problem(409, message, "conflict");
    }
    worker = await resolveWorker(picked.tool, options.db);
  }
  const refusal = riskRefusal(worker.id, worker.profile.rules.max_risk, risk);
  if (refusal) throw new Problem(400, refusal, "usage");
  const trust =
    avoid.requireTrust &&
    trustRefusal(worker.id, worker.profile.rules.trust, risk);
  if (trust) throw new Problem(400, trust, "usage");
  return waitUntil === undefined
    ? { worker, risk }
    : { worker, risk, waitUntil };
}
