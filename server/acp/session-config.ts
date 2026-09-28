/**
 * 经 ACP 会话配置选模型与思考强度（#418）：档案没写 model_args / effort_args 时，桥在建好会话后按工具报的配置去设。
 * 纯函数：输入 session/new（或 session/load）的结果和要的值，给出要发的请求，或说清工具不支持。
 *
 * - 会话配置项（configOptions，category 为 model / thought_level）优先：`session/set_config_option`
 * - 其次是模型列表（models.availableModels）：`session/set_model`
 * - 都没有：报错，提示在档案里改用命令行参数（model_args / effort_args）
 */

export type ConfigRequest = { method: string; params: Record<string, unknown> };

type Choice = { value: string; name?: string };

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** 下拉项：平铺的 options，或按组给的 options[].options。 */
function choices(option: Record<string, unknown>): Choice[] {
  const list = Array.isArray(option.options) ? option.options : [];
  return list.flatMap((item): Choice[] => {
    const entry = object(item);
    if (!entry) return [];
    if (Array.isArray(entry.options)) return choices(entry);
    return typeof entry.value === "string"
      ? [
          {
            value: entry.value,
            ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          },
        ]
      : [];
  });
}

function configOption(session: unknown, category: string) {
  const list = object(session)?.configOptions;
  if (!Array.isArray(list)) return undefined;
  return list
    .map(object)
    .find((item) => item?.category === category && typeof item.id === "string");
}

const listed = (values: string[]) =>
  values.length > 12
    ? `${values.slice(0, 12).join("、")} 等 ${values.length} 个`
    : values.join("、");

/** 要的值在选项里：按 value 精确匹配，其次按显示名。 */
function match(list: Choice[], wanted: string) {
  return (
    list.find((item) => item.value === wanted) ??
    list.find((item) => item.name === wanted)
  );
}

export type ConfigPlan =
  { ok: true; requests: ConfigRequest[] } | { ok: false; problem: string };

export function sessionConfig(
  sessionId: string,
  session: unknown,
  wanted: { model?: string; effort?: string },
): ConfigPlan {
  const requests: ConfigRequest[] = [];
  if (wanted.model !== undefined) {
    const option = configOption(session, "model");
    const models = object(object(session)?.models);
    const available = Array.isArray(models?.availableModels)
      ? models.availableModels
          .map(object)
          .filter((item) => typeof item?.modelId === "string")
          .map((item) => ({
            value: item!.modelId as string,
            ...(typeof item!.name === "string" ? { name: item!.name } : {}),
          }))
      : undefined;
    const list = option ? choices(option) : available;
    if (!list)
      return {
        ok: false,
        problem:
          '工具没有经 ACP 报可选模型（session/new 结果里没有 configOptions 的 model 项，也没有 models），无从选模型；在工具层档案里写 model_args，如 [--model, "{model}"]',
      };
    const hit = match(list, wanted.model);
    if (!hit)
      return {
        ok: false,
        problem: `工具报的可选模型里没有 ${wanted.model}；可选：${listed(list.map((item) => item.value)) || "（空）"}`,
      };
    requests.push(
      option
        ? {
            method: "session/set_config_option",
            params: { sessionId, configId: option.id, value: hit.value },
          }
        : {
            method: "session/set_model",
            params: { sessionId, modelId: hit.value },
          },
    );
  }
  if (wanted.effort !== undefined) {
    const option = configOption(session, "thought_level");
    if (!option)
      return {
        ok: false,
        problem:
          '工具没有经 ACP 报思考强度配置（configOptions 里没有 thought_level 项）；在工具层档案里写 effort_args，如 [--effort, "{effort}"]',
      };
    const list = choices(option);
    const hit = match(list, wanted.effort);
    if (!hit)
      return {
        ok: false,
        problem: `工具报的思考强度里没有 ${wanted.effort}；可选：${listed(list.map((item) => item.value)) || "（空）"}`,
      };
    requests.push({
      method: "session/set_config_option",
      params: { sessionId, configId: option.id, value: hit.value },
    });
  }
  return { ok: true, requests };
}
