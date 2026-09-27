import type { Command, Values } from "./main.ts";
import { printJson, table } from "./format.ts";
import { recordNext } from "./contract.ts";
import { Problem } from "../server/problem.ts";
import type { WorkerStat } from "../server/tasks/delivery-records.ts";
const str = (v: Values, k: string) =>
  typeof v[k] === "string" ? (v[k] as string) : undefined;
const client = async () => (await import("./service.ts")).connect();
type Advice = { stat: WorkerStat; advice: { action: string; reason: string } };
type List = { stats: WorkerStat[]; suggestions: Advice[] };
const percent = (n: number | null) =>
  n === null ? "—" : `${Math.round(n * 100)}%`;
const duration = (n: number | null) =>
  n === null ? "—" : `${Math.round(n / 60000)} 分`;
export const workerCommands: Record<string, Command> = {
  workers: {
    args: "[--role 角色] [--json]",
    about: "按执行者组合、模型、工具与角色查看交付事实",
    options: { role: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const role = str(values, "role");
      const q = role ? `?role=${encodeURIComponent(role)}` : "";
      const data = await (await client()).get<List>(`/workers${q}`);
      if (json) printJson(data);
      else {
        console.log(
          table([
            [
              "层级",
              "执行者",
              "角色",
              "次数",
              "一次通过",
              "平均退回",
              "中位用时",
              "事故",
              "信任",
              "样本",
            ],
            ...data.stats.map((s) => [
              s.scope,
              s.worker,
              s.role ?? "未指定",
              String(s.deliveries),
              percent(s.first_pass_rate),
              s.average_returns.toFixed(1),
              duration(s.median_ms),
              String(s.incidents),
              s.trust ?? "—",
              s.low_data ? "数据少" : "足够",
            ]),
          ]),
        );
        for (const x of data.suggestions)
          console.log(
            `建议 ${x.stat.worker} · ${x.stat.role}：${x.advice.action}，${x.advice.reason}`,
          );
      }
      recordNext("看执行者：atrium workers show 工具+模型[:强度]");
    },
  },
  "workers show": {
    args: "工具+模型[:强度] [--json]",
    about: "查看交付明细与三层叠加档案",
    positionals: [1, 1],
    async run({ positionals: [worker], json }) {
      const data = await (
        await client()
      ).get<{
        worker: string;
        profile: { body: string; layers: { file: string; body: string }[] };
        deliveries: {
          task_ref: string;
          task_title: string;
          job_name: string | null;
          final_result: string;
          duration_ms: number | null;
          gate_returns: string[];
          merge_returns: string[];
          rebase_conflicts: number;
          incidents: string[];
          first_pass: boolean | null;
        }[];
        suggestions: Advice[];
      }>(`/workers/${encodeURIComponent(worker!)}`);
      if (json) printJson(data);
      else
        console.log(
          `${data.worker}\n${data.profile.body}\n\n交付：\n${data.deliveries.map((d) => `${d.task_ref} ${d.task_title} · ${d.job_name ?? "未指定"} · ${d.final_result} · ${duration(d.duration_ms)}${d.gate_returns.length ? ` · 关卡：${d.gate_returns.join("；")}` : ""}${d.merge_returns.length ? ` · 合入退回：${d.merge_returns.join("；")}` : ""}${d.rebase_conflicts ? ` · 变基冲突 ${d.rebase_conflicts} 次（不归责）` : ""}${d.incidents.length ? ` · 事故：${d.incidents.join("、")}` : ""}`).join("\n") || "暂无"}\n${data.suggestions.map((x) => `建议：${x.advice.action} · ${x.advice.reason}`).join("\n")}`,
        );
      recordNext("看全部：atrium workers");
    },
  },
  "workers confirm": {
    args: "工具+模型[:强度] --role 角色 --action relax|tighten|avoid_role",
    about: "秘书确认统计建议后写入组合档案",
    options: { role: { type: "string" }, action: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [worker], values, json }) {
      const role = str(values, "role"),
        action = str(values, "action");
      if (!role?.trim()) throw new Problem(400, "--role 不能为空", "usage");
      if (!action || !["relax", "tighten", "avoid_role"].includes(action))
        throw new Problem(
          400,
          "--action 只能是 relax、tighten、avoid_role",
          "usage",
        );
      const result = await (
        await client()
      ).post<{ worker: string; role: string; action: string; file: string }>(
        "/workers/advice/confirm",
        { worker, role, action },
      );
      if (json) printJson(result);
      else
        console.log(
          `已确认 ${result.worker} · ${result.role}：${result.action}\n档案：${result.file}`,
        );
      recordNext(`看档案：atrium workers show ${worker}`);
    },
  },
};
