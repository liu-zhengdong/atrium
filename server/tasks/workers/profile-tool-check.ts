import { ADAPTERS, isBuiltinTool, type Adapter } from "../adapters/index.ts";
import { cliAdapter } from "../adapters/cli.ts";
import { parseCliSpec } from "../adapters/cli-spec.ts";
import { endpointFit } from "./endpoint.ts";
import type { ProfileRules } from "./profiles.ts";
import type { ProfileLayerName } from "./worker-profiles.ts";

/**
 * 改档案时按工具查（t271，纯函数）：通用执行者的命令模板写没写对，内置工具不能改成通用执行者，
 * 档案写的自定义端点这个工具接不接得了。models 层不知道是哪个工具，端点在派活前查。
 */
export function toolProblems(
  layer: ProfileLayerName,
  name: string,
  rules: ProfileRules,
): string[] {
  let adapter: Adapter | undefined;
  if (layer === "harness") {
    if (isBuiltinTool(name)) {
      if (rules.protocol !== undefined)
        return [
          `${name} 是内置工具（手写适配器），不能改成通用执行者；通用接入另起名字，如 harness/${name}-cli`,
        ];
      adapter = ADAPTERS[name];
    } else {
      if (rules.protocol === undefined)
        return [
          `harness/${name} 不是内置工具：写 protocol: cli 与 command、args 接一个通用命令行执行者（atrium guide 有写法）`,
        ];
      const { spec, problems } = parseCliSpec(name, rules);
      if (!spec) return problems;
      adapter = cliAdapter(name, spec);
    }
  } else if (layer === "combos")
    adapter = ADAPTERS[name.slice(0, name.indexOf("+"))];
  const fit = adapter && endpointFit(adapter, rules);
  return fit ? [fit] : [];
}
