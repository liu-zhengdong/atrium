import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ADAPTERS,
  invalid,
  isTool,
  TOOLS,
  type Tool,
} from "./adapters/index.ts";
import { parseFrontmatter, type FrontValue } from "./frontmatter.ts";

/**
 * 执行者档案（#262）：执行者 = 工具 + 模型（+ 思考强度）。档案三层叠加：
 * harness/<工具>.md ← models/<模型>.md ← combos/<工具>+<模型>.md。
 * 后层覆盖前层，但规则取更严：trust / max_risk 取较低、limits 逐项取较小、checks 取并集。
 * 组织技能相关的 skills、avoid_nodes 取并集，skills_for 按节点合并（#264 第 3b 步）。
 * 只读；档案由用户或秘书维护。
 */

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];
export const isRisk = (value: unknown): value is Risk =>
  typeof value === "string" && (RISKS as readonly string[]).includes(value);

/** unknown 视为最低：没有交付记录的执行者不比 low 更可信。 */
export const TRUSTS = ["unknown", "low", "medium", "high"] as const;
export type Trust = (typeof TRUSTS)[number];
const isTrust = (value: unknown): value is Trust =>
  typeof value === "string" && (TRUSTS as readonly string[]).includes(value);

export type ProfileRules = {
  trust?: Trust;
  max_risk?: Risk;
  checks?: string[];
  limits?: Record<string, number>;
  /** 交给工具的模型 id；harness 层的 model 同时是只写工具时的默认模型。 */
  model?: string;
  /** 其余键（invoke、cost 等）原样保留，后层覆盖前层。 */
  [key: string]: FrontValue | undefined;
};

export type ProfileLayer = {
  layer: "harness" | "models" | "combos";
  file: string;
  rules: ProfileRules;
  body: string;
  warnings: string[];
};

export type EffectiveProfile = {
  rules: ProfileRules;
  /** 各层正文按 harness、models、combos 顺序拼接，原样附进提示词。 */
  body: string;
  layers: ProfileLayer[];
  warnings: string[];
};

export const DEFAULT_WORKERS_DIR = join(homedir(), "Atrium", "workers");

export type WorkerSpec = { tool: Tool; model?: string; effort?: string };

const MODEL_RE = /^[\w.@-]+(\/[\w.@-]+)*$/;
const EFFORT_RE = /^[a-z]+$/;

/** 解析执行者标识 `工具+模型[:思考强度]`；模型可带 provider 前缀（opencode-go/mimo-v2.6-flash）。 */
export function parseWorker(value: string): WorkerSpec {
  const text = value.trim();
  const plus = text.indexOf("+");
  const head = plus < 0 ? text : text.slice(0, plus);
  let rest = plus < 0 ? "" : text.slice(plus + 1);
  let effort: string | undefined;
  let tool = head;
  const colon = (plus < 0 ? head : rest).lastIndexOf(":");
  if (colon >= 0) {
    if (plus < 0) {
      effort = head.slice(colon + 1);
      tool = head.slice(0, colon);
    } else {
      effort = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  if (!isTool(tool))
    throw invalid(
      `未知的执行者工具：${tool || "（空）"}，可选 ${TOOLS.join("、")}`,
    );
  if (plus >= 0 && !MODEL_RE.test(rest))
    throw invalid(`执行者模型不合法：${rest || "（空）"}`);
  if (plus >= 0 && rest.split("/").some((seg) => seg.startsWith(".")))
    throw invalid(`执行者模型不合法：${rest}`);
  if (effort !== undefined && !EFFORT_RE.test(effort))
    throw invalid(`思考强度不合法：${effort || "（空）"}`);
  return { tool, model: plus >= 0 ? rest : undefined, effort };
}

export const workerId = (spec: WorkerSpec) =>
  `${spec.tool}${spec.model ? `+${spec.model}` : ""}${spec.effort ? `:${spec.effort}` : ""}`;

/** models/ 与 combos/ 下的文件名用模型名最后一段（去掉 provider 前缀）。 */
export const modelKey = (model: string) =>
  model.slice(model.lastIndexOf("/") + 1);

async function readLayer(
  layer: ProfileLayer["layer"],
  file: string,
): Promise<ProfileLayer | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = parseFrontmatter(text);
  const { rules, warnings } = normalizeRules(parsed.data);
  return {
    layer,
    file,
    rules,
    body: parsed.body,
    warnings: [...parsed.warnings, ...warnings].map((w) => `${file}：${w}`),
  };
}

function normalizeRules(data: Record<string, FrontValue>) {
  const rules: ProfileRules = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "trust") {
      if (isTrust(value)) rules.trust = value;
      else warnings.push(`trust 只能是 ${TRUSTS.join("、")}`);
    } else if (key === "max_risk") {
      if (isRisk(value)) rules.max_risk = value;
      else warnings.push(`max_risk 只能是 ${RISKS.join("、")}`);
    } else if (key === "checks") {
      const list = Array.isArray(value) ? value : [value];
      rules.checks = list.filter(
        (item): item is string => typeof item === "string",
      );
    } else if (key === "limits") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rules.limits = {};
        for (const [name, n] of Object.entries(value))
          if (typeof n === "number" && Number.isFinite(n))
            rules.limits[name] = n;
          else warnings.push(`limits.${name} 须为数字`);
      } else warnings.push("limits 须为 {键: 数字}");
    } else if (key === "model") {
      if (typeof value === "string" && MODEL_RE.test(value))
        rules.model = value;
      else warnings.push("model 不合法");
    } else rules[key] = value;
  }
  return { rules, warnings };
}

const lower = <T extends string>(order: readonly T[], a?: T, b?: T) =>
  a === undefined
    ? b
    : b === undefined
      ? a
      : order.indexOf(a) <= order.indexOf(b)
        ? a
        : b;

const strings = (value: FrontValue | undefined): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
    (item): item is string => typeof item === "string",
  );
const union = (a: FrontValue | undefined, b: FrontValue | undefined) => [
  ...new Set([...strings(a), ...strings(b)]),
];
const mapOf = (value: FrontValue | undefined) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

/** 三层合并：后层覆盖前层；trust、max_risk、limits 取更严，checks、skills、avoid_nodes 取并集，skills_for 按节点合并。 */
export function mergeLayers(layers: ProfileLayer[]): EffectiveProfile {
  let rules: ProfileRules = {};
  for (const { rules: next } of layers) {
    const merged: ProfileRules = { ...rules, ...next };
    merged.trust = lower(TRUSTS, rules.trust, next.trust);
    merged.max_risk = lower(RISKS, rules.max_risk, next.max_risk);
    if (rules.checks || next.checks)
      merged.checks = [
        ...new Set([...(rules.checks ?? []), ...(next.checks ?? [])]),
      ];
    if (rules.limits || next.limits) {
      const limits = { ...rules.limits };
      for (const [name, n] of Object.entries(next.limits ?? {}))
        limits[name] = name in limits ? Math.min(limits[name], n) : n;
      merged.limits = limits;
    }
    for (const key of ["skills", "avoid_nodes"])
      if (rules[key] !== undefined || next[key] !== undefined)
        merged[key] = union(rules[key], next[key]);
    if (rules.skills_for !== undefined || next.skills_for !== undefined) {
      const scoped: Record<string, FrontValue> = { ...mapOf(rules.skills_for) };
      for (const [node, slugs] of Object.entries(mapOf(next.skills_for)))
        scoped[node] = union(scoped[node], slugs);
      merged.skills_for = scoped;
    }
    for (const key of Object.keys(merged))
      if (merged[key] === undefined) delete merged[key];
    rules = merged;
  }
  return {
    rules,
    body: layers
      .map((layer) => layer.body)
      .filter(Boolean)
      .join("\n\n"),
    layers,
    warnings: layers.flatMap((layer) => layer.warnings),
  };
}

export type ResolvedWorker = {
  tool: Tool;
  /** 执行者标识里的模型名（补上默认模型后）；undefined 表示交给工具配置。 */
  model?: string;
  effort?: string;
  /** 实际交给工具的模型 id：档案 model 优先，其次是模型名。 */
  cliModel?: string;
  id: string;
  profile: EffectiveProfile;
};

/**
 * 解析执行者标识并读取生效档案。只写工具时，默认模型取 harness 档案的 model，
 * 再退回适配器数据里的 defaultModel。`dir` 可注入，测试用临时目录。
 */
export async function resolveWorker(
  value: string | WorkerSpec,
  dir = DEFAULT_WORKERS_DIR,
): Promise<ResolvedWorker> {
  const spec = typeof value === "string" ? parseWorker(value) : value;
  const harness = await readLayer(
    "harness",
    join(dir, "harness", `${spec.tool}.md`),
  );
  const model =
    spec.model ?? harness?.rules.model ?? ADAPTERS[spec.tool].defaultModel;
  const layers: ProfileLayer[] = harness ? [harness] : [];
  if (model) {
    const key = modelKey(model);
    const models = await readLayer("models", join(dir, "models", `${key}.md`));
    const combos = await readLayer(
      "combos",
      join(dir, "combos", `${spec.tool}+${key}.md`),
    );
    for (const layer of [models, combos]) if (layer) layers.push(layer);
  }
  const profile = mergeLayers(layers);
  // harness 的 model 是工具默认模型，不该盖住明确写出的模型；只取 models/combos 层的 model。
  const layerModel = [...layers]
    .reverse()
    .find((layer) => layer.layer !== "harness" && layer.rules.model)
    ?.rules.model;
  const cliModel = layerModel ?? model;
  if (cliModel) profile.rules.model = cliModel;
  else delete profile.rules.model;
  const resolved = { tool: spec.tool, model, effort: spec.effort };
  return {
    ...resolved,
    cliModel,
    id: workerId(resolved),
    profile,
  };
}
