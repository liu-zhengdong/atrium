import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command, Values } from "./main.ts";
import { printJson, table, when } from "./format.ts";
import { recordNext } from "./contract.ts";
import { Problem } from "../server/problem.ts";
import type { WorkerStat } from "../server/tasks/gates/delivery-records.ts";
import { defaultActor } from "./worker-guard.ts";
const str = (v: Values, k: string) =>
  typeof v[k] === "string" ? (v[k] as string) : undefined;
const strs = (v: Values, k: string) =>
  Array.isArray(v[k])
    ? (v[k] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
const client = async () => (await import("./service.ts")).connect();
type List = { stats: WorkerStat[] };
const percent = (n: number | null) =>
  n === null ? "—" : `${Math.round(n * 100)}%`;
const duration = (n: number | null) =>
  n === null ? "—" : `${Math.round(n / 60000)} 分`;
type ProfileRow = {
  ref: string;
  rev: number;
  trust: string | null;
  max_risk: string | null;
  model: string | null;
  checks: string[] | null;
  protocol: string | null;
  endpoint: string | null;
  updated_by: string;
  updated_at: number;
  warnings: string[];
};
type ProfileView = ProfileRow & {
  body: string;
  notes: string;
  source: string;
  history: { rev: number; author: string; at: number; reason: string }[];
};
/** `层/名` 形式的档案标识（harness/codex、combos/codex+gpt-6-sol）；执行者标识不以层名开头。 */
const isProfileRef = (value: string) =>
  /^(harness|models|combos)\//.test(value);
const profilePath = (ref: string) => {
  const slash = ref.indexOf("/");
  return `/workers/profiles/${encodeURIComponent(ref.slice(0, slash))}/${encodeURIComponent(ref.slice(slash + 1))}`;
};
function readSource(name: string) {
  try {
    return readFileSync(name === "-" ? 0 : resolve(name), "utf8");
  } catch {
    throw new Problem(400, `--file 文件无法读取：${name}`, "usage");
  }
}
async function showProfile(ref: string, json: boolean) {
  const data = await (await client()).get<ProfileView>(profilePath(ref));
  if (json) printJson(data);
  else {
    console.log(
      `${data.ref} · 第 ${data.rev} 版 · ${data.updated_by} ${when(data.updated_at)}`,
    );
    console.log(data.source.trimEnd());
    if (data.notes) console.log("\n（交付记录段作备注保留，不附进提示词）");
    for (const w of data.warnings) console.log(`警告：${w}`);
    console.log("\n修订：");
    for (const h of data.history)
      console.log(`  第 ${h.rev} 版 · ${h.author} ${when(h.at)} · ${h.reason}`);
  }
  recordNext(`改档案：atrium workers edit ${ref} --file 文件`);
}

async function stats(values: Values, json: boolean) {
  const role = str(values, "specialist");
  const q = role ? `?role=${encodeURIComponent(role)}` : "";
  const data = await (await client()).get<List>(`/workers${q}`);
  if (json) printJson(data);
  else {
    console.log(
      table([
        [
          "层级",
          "执行者",
          "专员",
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
  }
  recordNext("看执行者：atrium workers 工具+模型[:强度]");
}
async function profiles(json: boolean) {
  const data = await (
    await client()
  ).get<{ profiles: ProfileRow[] }>("/workers/profiles");
  if (json) printJson(data);
  else if (!data.profiles.length)
    console.log("库里还没有执行者档案，派活用内置缺省");
  else
    console.log(
      table([
        ["档案", "版本", "信任", "最高风险", "模型", "加查", "更新"],
        ...data.profiles.map((p) => [
          `${p.ref}${p.protocol ? `（${p.protocol} 接入）` : ""}`,
          String(p.rev),
          p.trust ?? "—",
          p.max_risk ?? "—",
          `${p.model ?? "—"}${p.endpoint ? ` @ ${p.endpoint}` : ""}`,
          p.checks?.join(",") || "—",
          `${p.updated_by} ${when(p.updated_at)}${p.warnings.length ? " · 有警告" : ""}`,
        ]),
      ]),
    );
  recordNext("看档案：atrium workers harness/codex");
}
async function workerDetail(worker: string, json: boolean) {
  const data = await (
    await client()
  ).get<{
    worker: string;
    profile: {
      body: string;
      layers: { file: string; body: string }[];
      warnings: string[];
    };
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
  }>(`/workers/${encodeURIComponent(worker)}`);
  if (json) printJson(data);
  else {
    console.log(
      `${data.worker}\n${data.profile.body}\n\n交付：\n${data.deliveries.map((d) => `${d.task_ref} ${d.task_title} · ${d.job_name ?? "未指定"} · ${d.final_result} · ${duration(d.duration_ms)}${d.gate_returns.length ? ` · 关卡：${d.gate_returns.join("；")}` : ""}${d.merge_returns.length ? ` · 合入退回：${d.merge_returns.join("；")}` : ""}${d.rebase_conflicts ? ` · 变基冲突 ${d.rebase_conflicts} 次（不归责）` : ""}${d.incidents.length ? ` · 事故：${d.incidents.join("、")}` : ""}`).join("\n") || "暂无"}`,
    );
    for (const w of data.profile.warnings) console.log(`警告：${w}`);
  }
  recordNext("看全部：atrium workers");
}

export const workerCommands: Record<string, Command> = {
  workers: {
    args: "[工具+模型[:强度]|层/名] [--profiles] [--specialist 专员] [--json]",
    about:
      "不给参数按执行者组合、模型、工具与干活的专员列交付事实；给执行者看交付明细与三层叠加档案；给 层/名（如 harness/codex）看这份档案原文与修订；--profiles 列库里的执行者档案（工具 / 模型 / 组合三层）",
    options: {
      specialist: { type: "string" },
      profiles: { type: "boolean" },
    },
    positionals: [0, 1],
    async run({ positionals: [target], values, json }) {
      if (target !== undefined)
        return isProfileRef(target)
          ? showProfile(target, json)
          : workerDetail(target, json);
      return values.profiles ? profiles(json) : stats(values, json);
    },
  },
  "workers edit": {
    args: "层/名 (--file 文件|- | --trust 等级 | --max-risk 风险 | --model 模型 | --checks a,b | --set 键=值 | --unset 键) [--reason 原因] [--as secretary]",
    about:
      "改库里的一份执行者档案并留修订；层是 harness、models、combos，档案不存在就新建。--file - 从标准输入读整份（frontmatter + 正文）。harness/<新名字> 写 protocol: cli 与 command、args 即接入一个通用命令行执行者；任一层写 endpoint、endpoint_api、endpoint_key（凭据名）接自定义模型端点",
    options: {
      file: { type: "string" },
      trust: { type: "string" },
      "max-risk": { type: "string" },
      model: { type: "string" },
      checks: { type: "string" },
      set: { type: "string", multiple: true },
      unset: { type: "string", multiple: true },
      reason: { type: "string" },
      as: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [ref], values, json }) {
      if (!isProfileRef(ref!))
        throw new Problem(
          400,
          "档案应写成 层/名，层是 harness、models、combos，如 harness/codex",
          "usage",
        );
      const file = str(values, "file");
      const set: Record<string, string> = {};
      for (const [flag, key] of [
        ["trust", "trust"],
        ["max-risk", "max_risk"],
        ["model", "model"],
      ] as const) {
        const value = str(values, flag);
        if (value !== undefined) set[key] = value;
      }
      const checks = str(values, "checks");
      if (checks !== undefined)
        set.checks = `[${checks
          .split(/[,，]/)
          .map((c) => c.trim())
          .filter(Boolean)
          .join(", ")}]`;
      for (const pair of strs(values, "set")) {
        const at = pair.indexOf("=");
        if (at <= 0)
          throw new Problem(400, `--set 应写成 键=值：${pair}`, "usage");
        set[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
      const unset = strs(values, "unset");
      const body = {
        ...(file !== undefined ? { source: readSource(file) } : {}),
        ...(Object.keys(set).length ? { set } : {}),
        ...(unset.length ? { unset } : {}),
        ...(str(values, "reason") ? { reason: str(values, "reason") } : {}),
      };
      const who = str(values, "as") ?? defaultActor();
      const result = await (
        await client()
      ).put<{ ref: string; rev: number; changed: boolean; created: boolean }>(
        `${profilePath(ref!)}${who ? `?as=${encodeURIComponent(who)}` : ""}`,
        body,
      );
      if (json) printJson(result);
      else
        console.log(
          result.changed
            ? `${result.created ? "已新建" : "已改"} ${result.ref}，第 ${result.rev} 版`
            : `${result.ref} 内容没变，仍是第 ${result.rev} 版`,
        );
      recordNext(`看档案：atrium workers ${result.ref}`);
    },
  },
};
