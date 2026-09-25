import { existsSync, readFileSync, renameSync } from "node:fs";
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
} from "@earendil-works/pi-ai/providers/all";
import {
  formatModelSpec,
  groupModelsByProvider,
  type ModelSpec,
  type ModelOption,
} from "../shared/model.ts";
import { commandAgent } from "../shared/command-agent.ts";
import { closest, Problem } from "./problem.ts";
import { Store } from "./store.ts";
import { privateWrite } from "./account-files.ts";
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

/**
 * 把模板里这个供应商的模型目录缓存带进身份目录，让没启动过的身份也能列出、校验模型。
 * 这是可再生的缓存、不含凭据：模板里没有就跳过，身份自己刷新过的不覆盖，
 * 读不了的旧文件挪开留原文再写新的。
 */
export function seedModelsStore(
  directory: string,
  provider: string,
  template: string,
): boolean {
  try {
    const source = readStoredFile(join(template, "models-store.json"));
    if (source.raw !== null && !Object.keys(source.data).length)
      console.error("模板的模型目录缓存读不了，跳过带上");
    const entry = source.data[provider];
    if (!entry) return false;
    const file = join(directory, "models-store.json");
    const current = readStoredFile(file);
    if (current.data[provider]) return false;
    if (current.raw !== null && !Object.keys(current.data).length) {
      renameSync(file, `${file}.unreadable`);
      console.error(`身份的模型目录缓存读不了，原文留在 ${file}.unreadable`);
    }
    privateWrite(file, { ...current.data, [provider]: entry });
    return true;
  } catch (error) {
    console.error(`带上 ${provider} 的模型目录缓存失败：${String(error)}`);
    return false;
  }
}

/** 合并几路清单：同 id 保留先到的；先到的只有占位名、后到的带真名时用真名升级。 */
export function mergeModelOptions(...lists: ModelOption[][]): ModelOption[] {
  const merged = new Map<string, ModelOption>();
  for (const list of lists)
    for (const item of list) {
      const held = merged.get(item.id);
      if (!held) merged.set(item.id, item);
      else if (held.name === held.id && item.name !== item.id)
        merged.set(item.id, item);
    }
  return [...merged.values()];
}

/** 账号带进来的模型目录（models.json），读不了当没有，不影响启动。 */
function readCustomModels(
  directory: string | null,
): Record<
  string,
  { models: { id: string; name?: string; reasoning?: boolean }[] }
> {
  if (!directory) return {};
  try {
    const parsed = z
      .object({
        providers: z.record(
          z.string(),
          z.object({
            models: z.array(
              z.object({
                id: z.string(),
                name: z.string().optional(),
                reasoning: z.boolean().optional(),
              }),
            ),
          }),
        ),
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

/** 身份不在线时能给出的可选模型：运行中观察到的缓存，加身份目录里的模型清单。 */
export function offlineModels(store: Store, id: string): ModelOption[] {
  const { agent_directory } = store.agent(id);
  return mergeModelOptions(
    cachedModels(store, id),
    directoryModelOptions(agent_directory),
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

/** 判断思考强度支持哪几档用哪份目录：身份缓存的目录 → pi 内置目录 → 账号 models.json。 */
function thinkingModel(
  directory: string | null,
  spec: ModelSpec,
): Model<Api> | null {
  const stored = directory
    ? readStoredFile(join(directory, "models-store.json")).data[
        spec.provider
      ]?.models.find((model) => model.id === spec.model)
    : undefined;
  if (stored) return asModel(spec.provider, stored);
  const builtinProvider = getBuiltinProviders().find(
    (item) => item === spec.provider,
  );
  const builtin = builtinProvider
    ? getBuiltinModels(builtinProvider).find((model) => model.id === spec.model)
    : undefined;
  if (builtin) return builtin;
  const custom = readCustomModels(directory)[spec.provider]?.models.find(
    (model) => model.id === spec.model,
  );
  return custom ? asModel(spec.provider, custom) : null;
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
      ? closest(
          wanted,
          named.filter((item) => item.ref.startsWith(`${spec.provider}/`)),
        )
      : undefined;
    throw new Problem(
      400,
      `${agent.name} 没有 ${wanted} 这个模型${own ? "" : `。可用的 provider：${[...grouped.keys()].join("、")}`}`,
      "model_not_found",
      candidates?.length ? candidates : undefined,
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
