import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import {
  THINKING_LEVELS,
  formatModelSpec,
  groupModelsByProvider,
  type ModelSpec,
  type ModelOption,
} from "../shared/model.ts";
import { commandAgent } from "../shared/command-agent.ts";
import { editDistance, Problem } from "./problem.ts";
import { Store } from "./store.ts";
import { readIdentityModel, writeIdentityModel } from "./profile.ts";

/** 上次取到的可选模型。身份离线时问不到 pi，界面和命令靠这份列出来。 */
export function cachedModels(store: Store, id: string): ModelOption[] {
  const row = store.one<{ models: string | null }>(
    "SELECT models FROM agents WHERE id=?",
    id,
  );
  if (!row?.models) return [];
  try {
    const parsed = z
      .array(
        z.union([z.string(), z.object({ id: z.string(), name: z.string() })]),
      )
      .safeParse(JSON.parse(row.models));
    return parsed.success
      ? parsed.data.map((item) =>
          typeof item === "string" ? { id: item, name: item } : item,
        )
      : [];
  } catch {
    return [];
  }
}
export function rememberModels(
  store: Store,
  id: string,
  options: ModelOption[],
) {
  store.run(
    "UPDATE agents SET models=? WHERE id=?",
    JSON.stringify(options),
    id,
  );
}

/** pi 存的模型目录缓存：provider → 这个供应商已知的模型。 */
const storedCatalog = z.record(
  z.string(),
  z
    .object({
      models: z
        .array(
          z
            .object({
              id: z.string(),
              name: z.string().optional(),
              reasoning: z.boolean().optional(),
              thinkingLevelMap: z
                .record(z.string(), z.union([z.string(), z.null()]))
                .optional(),
            })
            .passthrough(),
        )
        .catch([]),
    })
    .passthrough(),
);
type StoredCatalog = z.infer<typeof storedCatalog>;

function readStoredFile(file: string): {
  raw: string | null;
  data: StoredCatalog;
} {
  let raw: string | null = null;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { raw: null, data: {} };
  }
  try {
    const parsed = storedCatalog.safeParse(JSON.parse(raw));
    return { raw, data: parsed.success ? parsed.data : {} };
  } catch {
    return { raw, data: {} };
  }
}

/** id 去掉 provider 前缀：相似度比较、占位名判断都用模型这一段。 */
const modelIdOf = (id: string) => id.slice(id.indexOf("/") + 1);

/** 这条清单是不是占位名（name 只是 id，或 id 去掉 provider 的部分）。 */
const isPlaceholder = (item: ModelOption) =>
  item.name === item.id || item.name === modelIdOf(item.id);

/** 合并几路清单：同 id 保留先到的；先到的只有占位名、后到的带真名时用真名升级。 */
export function mergeModelOptions(...lists: ModelOption[][]): ModelOption[] {
  const merged = new Map<string, ModelOption>();
  for (const list of lists)
    for (const item of list) {
      const held = merged.get(item.id);
      if (!held) merged.set(item.id, item);
      else if (isPlaceholder(held) && !isPlaceholder(item))
        merged.set(item.id, item);
    }
  return [...merged.values()];
}

/**
 * 模型候选按相似度排：输入和候选都取模型 id（去 provider）来比，
 * 显示名只作辅助——运行中清单里 name 常常就是 id，只比名字会打平后退回字典序。
 * 同一个输入，不管身份在不在运行，排出来一致。
 */
export function closestModel(
  provider: string,
  reference: string,
  entries: { ref: string; name: string }[],
) {
  const input = modelIdOf(reference).toLowerCase();
  return entries
    .map((entry) => {
      const model = modelIdOf(entry.ref).toLowerCase();
      const name = entry.name.toLowerCase();
      return {
        entry,
        score:
          model === input
            ? -2
            : model.startsWith(input) || name.startsWith(input)
              ? -1
              : Math.min(
                  editDistance(input, model),
                  editDistance(input, name),
                  editDistance(input, name.split(/\s+/)[0]!),
                ),
      };
    })
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.ref.localeCompare(b.entry.ref, undefined, { numeric: true }),
    )
    .slice(0, 3)
    .map(({ entry }) => entry);
}

/**
 * 身份的 models.json（pi 自己的配置文件，账号目录也写在这）。
 * 读不了当没有，不影响启动。
 */
const thinkingOverrideSchema = z.object({
  reasoning: z.boolean().optional(),
  thinkingLevelMap: z
    .record(z.string(), z.union([z.string(), z.null()]))
    .optional(),
});
const customModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  thinkingLevelMap: z
    .record(z.string(), z.union([z.string(), z.null()]))
    .optional(),
});
const customProviderSchema = z.object({
  models: z.array(customModelSchema).default([]),
  modelOverrides: z.record(z.string(), thinkingOverrideSchema).optional(),
});
type CustomProviderConfig = z.infer<typeof customProviderSchema>;

function readCustomModels(
  directory: string | null,
): Record<string, CustomProviderConfig> {
  if (!directory) return {};
  try {
    const parsed = z
      .object({
        providers: z.record(z.string(), customProviderSchema),
      })
      .safeParse(
        JSON.parse(readFileSync(join(directory, "models.json"), "utf8")),
      );
    return parsed.success ? parsed.data.providers : {};
  } catch {
    return {};
  }
}

/** 身份目录里的模型清单：pi 的目录缓存，加账号带进来的 models.json。 */
export function directoryModelOptions(directory: string | null): ModelOption[] {
  const stored: ModelOption[] = [];
  if (directory)
    for (const [provider, entry] of Object.entries(
      readStoredFile(join(directory, "models-store.json")).data,
    ))
      for (const model of entry.models)
        stored.push({
          id: `${provider}/${model.id}`,
          name: model.name ?? model.id,
        });
  const custom: ModelOption[] = [];
  for (const [provider, entry] of Object.entries(readCustomModels(directory)))
    for (const model of entry.models)
      custom.push({
        id: `${provider}/${model.id}`,
        name: model.name ?? model.id,
      });
  return mergeModelOptions(stored, custom);
}

/** 分到的账号是 Pi 自带供应商时，Pi 自带的模型表；没启动过的身份也能列出、设定。 */
function assignedBuiltinModels(store: Store, id: string): ModelOption[] {
  const builtin = new Set<string>(getBuiltinProviders());
  return store
    .all<{ provider: string }>(
      "SELECT provider FROM account_assignments WHERE agent_id=? ORDER BY provider",
      id,
    )
    .filter(({ provider }) => builtin.has(provider))
    .flatMap(({ provider }) =>
      getBuiltinModels(provider as BuiltinProvider).map((model) => ({
        id: `${provider}/${model.id}`,
        name: model.name,
      })),
    );
}

/** 身份不在线时能给出的可选模型：运行中观察到的缓存，加身份目录里的模型清单与所分供应商的 Pi 自带模型。 */
export function offlineModels(store: Store, id: string): ModelOption[] {
  const { agent_directory } = store.agent(id);
  return mergeModelOptions(
    cachedModels(store, id),
    directoryModelOptions(agent_directory),
    assignedBuiltinModels(store, id),
  );
}

/** 目录条目转 pi 的 Model 形状；只用于读思考强度支持哪几档，其余字段填占位。 */
function asModel(
  provider: string,
  entry: {
    id: string;
    name?: string;
    reasoning?: boolean;
    thinkingLevelMap?: unknown;
  },
): Model<Api> {
  return {
    provider,
    id: entry.id,
    name: entry.name ?? entry.id,
    api: "openai-completions",
    baseUrl: "",
    reasoning: entry.reasoning ?? false,
    input: [],
    cost: { input: 0, output: 0 },
    contextWindow: 0,
    maxTokens: 0,
    ...(entry.thinkingLevelMap
      ? { thinkingLevelMap: entry.thinkingLevelMap }
      : {}),
  } as unknown as Model<Api>;
}

/** 模型覆盖层：pi 的 modelOverrides 是最上层用户配置，reasoning 和档位表都能改。 */
function withOverrides(
  model: Model<Api>,
  overrides: z.infer<typeof thinkingOverrideSchema>,
): Model<Api> {
  return {
    ...model,
    reasoning: overrides.reasoning ?? model.reasoning,
    thinkingLevelMap: overrides.thinkingLevelMap
      ? {
          ...model.thinkingLevelMap,
          ...(overrides.thinkingLevelMap as Model<Api>["thinkingLevelMap"]),
        }
      : model.thinkingLevelMap,
  };
}

/**
 * 判断思考强度支持哪几档用哪份定义，与 pi 对齐（pi-coding-agent
 * provider-composer：models.json 的 applyModelsJson 替换同 id 模型定义、
 * modelOverrides 最后叠在最上层，自定义供应商的目录就来自 models.json）。
 * 顺序：models.json 列了这个模型就用它（叠上 modelOverrides）；否则供应商
 * 若定义在 models.json 且不是内置供应商，pi 里就没有这个模型；其余才落
 * 到身份目录缓存、内置目录，同样叠 modelOverrides。
 */
function thinkingModel(
  directory: string | null,
  spec: ModelSpec,
): Model<Api> | null {
  const config = readCustomModels(directory)[spec.provider];
  const overrides = config?.modelOverrides?.[spec.model];
  const listed = config?.models.find((model) => model.id === spec.model);
  const builtinProvider = getBuiltinProviders().find(
    (item) => item === spec.provider,
  );
  let model: Model<Api> | null;
  if (listed) model = asModel(spec.provider, listed);
  else if (config && !builtinProvider) model = null;
  else {
    const stored = directory
      ? readStoredFile(join(directory, "models-store.json")).data[
          spec.provider
        ]?.models.find((entry) => entry.id === spec.model)
      : undefined;
    model = stored
      ? asModel(spec.provider, stored)
      : ((builtinProvider
          ? getBuiltinModels(builtinProvider).find(
              (entry) => entry.id === spec.model,
            )
          : undefined) ?? null);
  }
  return model && overrides ? withOverrides(model, overrides) : model;
}

/**
 * 写一个身份的模型：除了写法，还对照模型清单确认这个模型真的存在，
 * 省得切到已经删掉的 provider 上；思考强度也对照目录确认支持，
 * 不支持就给出能直接执行的换档命令。不碰运行中的实例。
 */
export function configureModel(
  store: Store,
  id: string,
  spec: ModelSpec,
  options: ModelOption[],
) {
  const agent = store.agent(id);
  if (!agent.agent_directory)
    throw new Problem(409, "旧记录还不是长期身份，没有自己的配置目录");
  const wanted = formatModelSpec({ ...spec, thinking: null });
  const provider = getBuiltinProviders().find((item) => item === spec.provider);
  // 离线也拿得到的两路：运行时观察过的清单，加身份目录里的模型目录。
  const available = mergeModelOptions(
    options,
    directoryModelOptions(agent.agent_directory),
  );
  const known = available.length
    ? available.map((item) => item.id)
    : provider
      ? getBuiltinModels(provider).map(
          (model) => `${model.provider}/${model.id}`,
        )
      : [];
  if (known.length && !known.includes(wanted)) {
    // 只提示够用的那一层：provider 对了按相似度挑最接近的，不对就列有哪些 provider。
    const grouped = groupModelsByProvider(known);
    const own = grouped.get(spec.provider);
    const named = available.length
      ? available.map((item) => ({ ref: item.id, name: item.name }))
      : (provider ? getBuiltinModels(provider) : []).map((model) => ({
          ref: `${model.provider}/${model.id}`,
          name: model.name,
        }));
    const candidates = own
      ? closestModel(
          spec.provider,
          wanted,
          named.filter((item) => item.ref.startsWith(`${spec.provider}/`)),
        )
      : undefined;
    // provider 只有唯一可选时，顺手给一条换掉 provider 就能执行的修正。
    const [only] = !own && grouped.size === 1 ? [...grouped.keys()] : [];
    const pick = only
      ? closestModel(
          only,
          spec.model,
          named.filter((item) => item.ref.startsWith(`${only}/`)),
        )[0]
      : undefined;
    throw new Problem(
      400,
      `${agent.name} 没有 ${wanted} 这个模型${own ? "" : `。可用的 provider：${[...grouped.keys()].join("、")}`}`,
      "model_not_found",
      candidates?.length ? candidates : undefined,
      pick
        ? `atrium model ${commandAgent(agent.name, agent.ref)} ${pick.ref}${spec.thinking ? `:${spec.thinking}` : ""}`
        : undefined,
    );
  }
  const model = thinkingModel(agent.agent_directory, spec);
  if (model && spec.thinking) {
    const supported = getSupportedThinkingLevels(model);
    if (!supported.includes(spec.thinking)) {
      // 挑哪档：pi 自己的就近挑选，向更强的档找，找不到再向弱档。
      const next = clampThinkingLevel(model, spec.thinking);
      throw new Problem(
        400,
        `${agent.name} 的 ${wanted} 不支持思考强度 ${spec.thinking}，支持：${supported.join("、")}`,
        "thinking_not_supported",
        undefined,
        `atrium model ${commandAgent(agent.name, agent.ref)} ${wanted}:${next}`,
      );
    }
  }
  return {
    wanted,
    configured: writeIdentityModel(agent.agent_directory, spec),
  };
}

/** 身份配置里写着的模型，没设过为 null。 */
export function configuredModel(store: Store, id: string) {
  const { agent_directory } = store.agent(id);
  const spec = agent_directory ? readIdentityModel(agent_directory) : null;
  return spec && formatModelSpec(spec);
}

/** 挑修正档，与离线同一条规则（pi 的就近挑选）：先向更强的档找，找不到再向弱档。 */
export function pickThinkingLevel(
  supported: string[],
  requested: string,
): string | null {
  const levels: readonly string[] = THINKING_LEVELS;
  const ok = levels.filter((item) => supported.includes(item));
  if (!ok.length) return null;
  const at = levels.indexOf(requested);
  if (at < 0) return ok[ok.length - 1] ?? null;
  const stronger = ok.filter((item) => levels.indexOf(item) >= at);
  const weaker = ok.filter((item) => levels.indexOf(item) < at);
  return stronger[0] ?? weaker[weaker.length - 1] ?? null;
}

/**
 * 运行中的实例被 pi 以思考强度不支持拒绝时，把原生报错转成中文回执：
 * 列出 pi 报的支持档位，附一条能直接执行的修正命令；不认识的报错返回 null。
 * 挑档按 pi 报出的档位就近选（与离线同一条规则），不看本地目录——
 * 正是两份目录对不上才会走到这里，pi 报出的才是此刻能用的。
 */
export function liveThinkingProblem(
  detail: string,
  wanted: string,
  agent: { name: string; ref: string },
): Problem | null {
  const matched = detail.match(
    /Thinking level not supported by the current model: (\S+) \(supported: ([^)]+)\)/,
  );
  if (!matched) return null;
  const level = matched[1]!;
  const supported = matched[2]!
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const next = pickThinkingLevel(supported, level);
  return new Problem(
    400,
    `运行中的实例不支持思考强度 ${level}，支持：${supported.join("、")}。模型配置已恢复原值。`,
    "thinking_not_supported",
    undefined,
    next
      ? `atrium model ${commandAgent(agent.name, agent.ref)} ${wanted}:${next}`
      : undefined,
  );
}
