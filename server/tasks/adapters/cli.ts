import { GROUPS, tokensOf, type CliSpec, type Group } from "./cli-spec.ts";
import {
  DEFAULT_WATCHDOG,
  checkCommon,
  invalid,
  type Adapter,
  type LaunchInput,
} from "./types.ts";

/**
 * 通用命令行执行者（t271）：按档案里的命令模板（cli-spec.ts）把提示词、工作目录、模型、强度、端点换成进程调用。
 * 没有进度流，看门狗按「有输出即活着」与工作树变化判卡死；捎话停下带着补充重派；结局按 cli-outcome.ts 判。
 */

type Values = Partial<Record<string, string>>;

const GROUP_OF: Record<Group, string> = {
  model_args: "model",
  effort_args: "effort",
  endpoint_args: "base_url",
};

function fill(text: string, values: Values, name: string, where: string) {
  return text.replace(/\{([a-z_]+)\}/g, (_, token: string) => {
    const value = values[token];
    if (value === undefined)
      throw invalid(
        `${name} 的档案 ${where} 用了 {${token}}，但这次没有${token === "model" ? "模型（执行者标识写 工具+模型，或档案写 model）" : token === "effort" ? "思考强度" : token === "base_url" ? "自定义端点" : "这个值"}；可选的参数放进 ${token === "base_url" ? "endpoint" : token}_args 组`,
      );
    return value;
  });
}

/** 按模板展开参数（纯函数）：整组标记在值缺时省掉，其余占位缺值报错。 */
export function expandArgs(
  name: string,
  spec: CliSpec,
  values: Values,
): string[] {
  const out: string[] = [];
  for (const item of spec.args) {
    const group = GROUPS.find((g) => item === `{${g}}`);
    if (group) {
      if (values[GROUP_OF[group]] === undefined) continue;
      for (const part of spec.groups[group])
        out.push(fill(part, values, name, group));
      continue;
    }
    out.push(fill(item, values, name, "args"));
  }
  return out;
}

/** 按模板算额外环境变量（纯函数）：缺值的那一项不设。 */
export function expandEnv(spec: CliSpec, values: Values) {
  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(spec.env))
    if (tokensOf(template).every((token) => values[token] !== undefined))
      env[key] = template.replace(
        /\{([a-z_]+)\}/g,
        (_, token: string) => values[token]!,
      );
  return env;
}

export function cliAdapter(name: string, spec: CliSpec): Adapter {
  const adapter: Adapter = {
    tool: name,
    executable: spec.command,
    promptVia: spec.promptVia === "arg" ? "arg" : "stdin",
    defaultModel: undefined,
    exclusive: spec.exclusive,
    ...(spec.efforts ? { efforts: spec.efforts } : {}),
    quotaProvider: spec.quotaProvider,
    watchdog: DEFAULT_WATCHDOG,
    progressSignals: ["log_growth", "worktree_change"],
    notes: [`通用命令行执行者（档案 harness/${name}）`],
    tell: "restart",
    ...(spec.endpointApis.length
      ? {
          endpoints: {
            apis: spec.endpointApis,
            ...(spec.keyEnv ? { keyEnv: spec.keyEnv } : {}),
          },
        }
      : {}),
    outputRules: {
      output: spec.output,
      ...(spec.done ? { done: spec.done } : {}),
      ...(spec.error ? { error: spec.error } : {}),
    },
    // 新接入、还没有交付记录的工具先压低，按交付记录再在档案里升。
    defaultRules: { trust: "unknown", max_risk: "low" },
    build(input: LaunchInput) {
      checkCommon(adapter, input);
      const values: Values = {
        prompt: input.prompt,
        prompt_file: input.promptFile,
        cwd: input.cwd,
        model: input.model,
        effort: input.effort,
        base_url: input.endpoint?.base_url,
      };
      const env = expandEnv(spec, values);
      return {
        command: spec.command,
        args: expandArgs(name, spec, values),
        cwd: input.cwd,
        ...(spec.promptVia === "stdin" ? { stdin: input.promptFile } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
    },
  };
  return adapter;
}
