import { z } from "zod";

/** pi 的思考强度档位，由弱到强。 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ModelSpec = {
  provider: string;
  model: string;
  thinking: ThinkingLevel | null;
};
const isThinkingLevel = (value: string): value is ThinkingLevel =>
  (THINKING_LEVELS as readonly string[]).includes(value);

/** 用户看到和输入的写法。 */
export const formatModelSpec = (spec: ModelSpec) =>
  `${spec.provider}/${spec.model}${spec.thinking ? `:${spec.thinking}` : ""}`;
/** 去掉思考强度的 provider/id；拿配置里的值对照清单或运行中的实例时用它。 */
export const modelBase = (spec: string) => {
  const parsed = splitModelSpec(spec);
  return parsed ? `${parsed.provider}/${parsed.model}` : spec;
};
/** 清单按 provider 归组；provider 是第一段，模型 id 自己可以再带斜杠。 */
export function groupModelsByProvider(options: string[]) {
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

/**
 * 写法沿用 pi 的 `--model`：`provider/id`，可选 `:思考强度`。
 * 模型 id 自己可以带斜杠和冒号（`openrouter/x/y`、`ollama/llama3:8b`），
 * 所以 provider 只取第一段，末尾的 `:xxx` 正好是已知档位时才算思考强度。
 * 写法不合规返回 null，由调用方决定怎么报错。
 */
export function splitModelSpec(value: string): ModelSpec | null {
  const colon = value.lastIndexOf(":");
  const suffix = colon > 0 ? value.slice(colon + 1) : "";
  const thinking = isThinkingLevel(suffix) ? suffix : null;
  const name = thinking ? value.slice(0, colon) : value;
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) return null;
  return {
    provider: name.slice(0, slash),
    model: name.slice(slash + 1),
    thinking,
  };
}

const writing = `写法是 provider/id，可选 :思考强度（${THINKING_LEVELS.join("、")}）`;
export const modelSpec = z
  .string()
  .trim()
  .max(200)
  .regex(/^[^\s\p{Cc}]+$/u, writing)
  .transform((value, ctx) => {
    const spec = splitModelSpec(value);
    if (!spec) {
      ctx.addIssue({ code: "custom", message: writing });
      return z.NEVER;
    }
    return spec;
  });

/** 一个身份的模型现状。`options` 空表示还没取到过这个身份的清单。 */
export type ModelState = {
  /** 身份配置里写着的模型；null 表示没设过，跟随 pi 自己的默认。 */
  configured: string | null;
  /** 运行中的实例此刻在用的模型；离线为 null。 */
  running: string | null;
  /** 这个身份可选的模型，按 provider/id 排序。 */
  options: string[];
  /** 现在改的话能否当场生效，否则要等下次启动。 */
  live: boolean;
};

/** 改完之后的现状，`notes` 是这次改动没能做到的部分。 */
export type ModelChange = ModelState & { notes: string[] };
