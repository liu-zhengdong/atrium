import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command, Values } from "./main.ts";
import { printJson, table, when } from "./format.ts";
import { recordNext } from "./contract.ts";
import { Problem } from "../server/problem.ts";
import type { WorkerStat } from "../server/tasks/delivery-records.ts";
const str = (v: Values, k: string) =>
  typeof v[k] === "string" ? (v[k] as string) : undefined;
const strs = (v: Values, k: string) =>
  Array.isArray(v[k])
    ? (v[k] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
const client = async () => (await import("./service.ts")).connect();
type Advice = { stat: WorkerStat; advice: { action: string; reason: string } };
type List = { stats: WorkerStat[]; suggestions: Advice[] };
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

export const workerCommands: Record<string, Command> = {
  workers: {
    args: "[--specialist 专员] [--json]",
    about: "按执行者组合、模型、工具与干活的专员查看交付事实",
    options: { role: { type: "string" }, specialist: { type: "string" } },
    positionals: [0, 0],
    async run({ values, json }) {
      const role = str(values, "specialist") ?? str(values, "role");
      if (str(values, "role") !== undefined)
        console.error("--role 已改为 --specialist；旧写法暂可用");
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
        for (const x of data.suggestions)
          console.log(
            `建议 ${x.stat.worker} · ${x.stat.role}：${x.advice.action}，${x.advice.reason}`,
          );
      }
      recordNext("看执行者：atrium workers show 工具+模型[:强度]");
    },
  },
  "workers ls": {
    args: "[--json]",
    about: "列出库里的执行者档案（工具 / 模型 / 组合三层）",
    positionals: [0, 0],
    async run({ json }) {
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
              p.ref,
              String(p.rev),
              p.trust ?? "—",
              p.max_risk ?? "—",
              p.model ?? "—",
              p.checks?.join(",") || "—",
              `${p.updated_by} ${when(p.updated_at)}${p.warnings.length ? " · 有警告" : ""}`,
            ]),
          ]),
        );
      recordNext("看档案：atrium workers show harness/codex");
    },
  },
  "workers edit": {
    args: "层/名 (--file 文件|- | --trust 等级 | --max-risk 风险 | --model 模型 | --checks a,b | --set 键=值 | --unset 键) [--reason 原因]",
    about:
      "改库里的一份执行者档案并留修订；层是 harness、models、combos，档案不存在就新建。--file - 从标准输入读整份（frontmatter + 正文）",
    options: {
      file: { type: "string" },
      trust: { type: "string" },
      "max-risk": { type: "string" },
      model: { type: "string" },
      checks: { type: "string" },
      set: { type: "string", multiple: true },
      unset: { type: "string", multiple: true },
      reason: { type: "string" },
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
      const result = await (
        await client()
      ).put<{ ref: string; rev: number; changed: boolean; created: boolean }>(
        profilePath(ref!),
        body,
      );
      if (json) printJson(result);
      else
        console.log(
          result.changed
            ? `${result.created ? "已新建" : "已改"} ${result.ref}，第 ${result.rev} 版`
            : `${result.ref} 内容没变，仍是第 ${result.rev} 版`,
        );
      recordNext(`看档案：atrium workers show ${result.ref}`);
    },
  },
  "workers show": {
    args: "工具+模型[:强度]|层/名 [--json]",
    about:
      "查看执行者的交付明细与三层叠加档案；给 层/名（如 harness/codex）时看这份档案原文与修订",
    positionals: [1, 1],
    async run({ positionals: [worker], json }) {
      if (isProfileRef(worker!)) return showProfile(worker!, json);
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
    args: "工具+模型[:强度] --specialist 专员 --action relax|tighten|avoid_specialist",
    about: "秘书确认统计建议后写入组合档案",
    options: {
      role: { type: "string" },
      specialist: { type: "string" },
      action: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [worker], values, json }) {
      const role = str(values, "specialist") ?? str(values, "role"),
        suppliedAction = str(values, "action"),
        action =
          suppliedAction === "avoid_specialist" ? "avoid_role" : suppliedAction;
      if (str(values, "role") !== undefined)
        console.error("--role 已改为 --specialist；旧写法暂可用");
      if (!role?.trim())
        throw new Problem(400, "--specialist 不能为空", "usage");
      if (suppliedAction === "avoid_role")
        console.error(
          "--action avoid_role 已改为 avoid_specialist；旧写法暂可用",
        );
      if (!action || !["relax", "tighten", "avoid_role"].includes(action))
        throw new Problem(
          400,
          "--action 只能是 relax、tighten、avoid_specialist",
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
          `已确认 ${result.worker} · ${result.role}：${result.action}\n档案：${result.file}（已留修订）`,
        );
      recordNext(`看档案：atrium workers show ${worker}`);
    },
  },
};
