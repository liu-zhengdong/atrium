import { join } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import {
  formatModelSpec,
  modelBase,
  modelSpec,
  type ModelSpec,
  type ModelState,
} from "../shared/model.ts";
import { Problem } from "./problem.ts";
import { Store } from "./store.ts";
import { readIdentityModel, writeIdentityModel } from "./profile.ts";
import { alive, readService, serviceUrl } from "./service-state.ts";

/** 上次取到的可选模型。身份离线时问不到 pi，界面和命令靠这份列出来。 */
export function cachedModels(store: Store, id: string): string[] {
  const row = store.one<{ models: string | null }>(
    "SELECT models FROM agents WHERE id=?",
    id,
  );
  if (!row?.models) return [];
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(row.models));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
export function rememberModels(store: Store, id: string, options: string[]) {
  store.run(
    "UPDATE agents SET models=? WHERE id=?",
    JSON.stringify(options),
    id,
  );
}

/**
 * 写一个身份的模型：除了写法，还对照清单确认这个模型真的存在，
 * 省得切到已经删掉的 provider 上。不碰运行中的实例。
 */
export function configureModel(
  store: Store,
  id: string,
  spec: ModelSpec,
  options: string[],
) {
  const agent = store.agent(id);
  if (!agent.agent_directory)
    throw new Problem(409, "旧记录还不是长期身份，没有自己的配置目录");
  const wanted = formatModelSpec({ ...spec, thinking: null });
  if (options.length && !options.includes(wanted)) {
    // 只提示够用的那一层：provider 对了列它的模型，不对就列有哪些 provider。
    const grouped = byProvider(options);
    const own = grouped.get(spec.provider);
    throw new Problem(
      400,
      `${agent.name} 没有 ${wanted} 这个模型。${
        own
          ? `${spec.provider} 下可选：${own.join("、")}`
          : `可用的 provider：${[...grouped.keys()].join("、")}`
      }`,
    );
  }
  return {
    wanted,
    configured: writeIdentityModel(agent.agent_directory, spec),
  };
}

/** 清单按 provider 归组；provider 是第一段，模型 id 自己可以再带斜杠。 */
function byProvider(options: string[]) {
  const grouped = new Map<string, string[]>();
  for (const option of options) {
    const slash = option.indexOf("/");
    const provider = option.slice(0, slash);
    grouped.set(provider, [
      ...(grouped.get(provider) ?? []),
      option.slice(slash + 1),
    ]);
  }
  return grouped;
}

/** 身份配置里写着的模型，没设过为 null。 */
export function configuredModel(store: Store, id: string) {
  const { agent_directory } = store.agent(id);
  const spec = agent_directory ? readIdentityModel(agent_directory) : null;
  return spec && formatModelSpec(spec);
}

const report = (name: string, state: ModelState, notes: string[]) =>
  [
    `${name} · ${state.configured ?? "未设定（跟随 pi 默认）"}`,
    ...(state.running &&
    state.running !== (state.configured && modelBase(state.configured))
      ? [`运行中实际在用：${state.running}`]
      : []),
    ...notes.map((note) => `注意：${note}`),
    // 一个 provider 一行：几百个模型逐行铺开没法看。
    ...(state.options.length
      ? [
          "可选（provider: 模型）：",
          ...[...byProvider(state.options)].map(
            ([provider, models]) => `  ${provider}: ${models.join(" ")}`,
          ),
        ]
      : ["还没取到过这个身份的可选模型，启动它之后再看这里就有了。"]),
  ].join("\n");

const stateSchema = z.object({
  configured: z.string().nullable(),
  running: z.string().nullable(),
  options: z.array(z.string()),
  live: z.boolean(),
  notes: z.array(z.string()).default([]),
});

/**
 * `atrium model 名称 [provider/id:思考强度]`。
 * 中庭服务在跑就交给它，顺带让运行中的实例当场生效；没跑就只改身份配置，下次启动生效。
 */
export async function modelCommand(
  data: string,
  reference: string,
  value?: string,
) {
  if (!existsSync(join(data, "atrium.sqlite")))
    throw new Error(
      "未找到中庭数据库；请先运行 atrium create 或打开 Web 创建身份，或设置 ATRIUM_DATA",
    );
  const spec = value === undefined ? null : parseSpec(value);
  const store = new Store(join(data, "atrium.sqlite"));
  try {
    const id = store.resolveAgentId(reference);
    const name = store.agent(id).name;
    const record = readService(data);
    if (record && alive(record.pid)) {
      const url = `${serviceUrl(record)}/api/agents/${id}/model`;
      const response = spec
        ? await fetch(url, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: value }),
          })
        : await fetch(url);
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : "操作失败",
        );
      const { notes, ...state } = stateSchema.parse(body);
      console.log(report(name, state, notes));
      return;
    }
    const options = cachedModels(store, id);
    if (spec) configureModel(store, id, spec, options);
    console.log(
      report(
        name,
        {
          configured: configuredModel(store, id),
          running: null,
          options,
          live: false,
        },
        spec ? ["中庭服务没在运行，下次启动这个身份时生效"] : [],
      ),
    );
  } finally {
    store.close();
  }
}

const parseSpec = (value: string) => {
  const parsed = modelSpec.safeParse(value);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join("；"),
    );
  return parsed.data;
};
