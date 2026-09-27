import type { Command } from "./main.ts";

/** HTTP 字段名属于接口，不是命令行参数；只在展示边界转译。 */
const fieldNames: Record<string, string> = {
  name: "名称",
  title: "标题",
  brief_path: "--brief",
  pr_url: "--pr",
  text: "文字",
  by: "--as",
};

export function cliErrorMessage(message: string, command?: Command): string {
  return message
    .split("；")
    .map((part) => {
      const field = /^([a-z][\w.]*): (.*)$/i.exec(part);
      if (!field) return part;
      const key = field[1]!.split(".")[0]!;
      const label =
        (key in (command?.options ?? {}) ? `--${key}` : undefined) ??
        fieldNames[key] ??
        "参数";
      const detail = field[2]!;
      if (/^[\u3400-\u9fff]/u.test(detail)) return `${label}：${detail}`;
      return `${label}不符合要求`;
    })
    .join("；");
}

/** Node 的解析器给英文异常，命令行只呈现可以执行的中文提示。 */
export function optionError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const flag = /Unknown option '([^']+)'/.exec(detail)?.[1];
    return `不认识的选项${flag ? `：${flag}` : ""}`;
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE")
    return "选项缺少或填错了值";
  return "参数格式不对";
}
