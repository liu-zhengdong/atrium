import { z } from "zod";
import {
  formatModelSpec,
  groupModelsByProvider,
  type ModelSpec,
} from "../shared/model.ts";
import { Problem } from "./problem.ts";
import { Store } from "./store.ts";
import { readIdentityModel, writeIdentityModel } from "./profile.ts";

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
    const grouped = groupModelsByProvider(options);
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

/** 身份配置里写着的模型，没设过为 null。 */
export function configuredModel(store: Store, id: string) {
  const { agent_directory } = store.agent(id);
  const spec = agent_directory ? readIdentityModel(agent_directory) : null;
  return spec && formatModelSpec(spec);
}
