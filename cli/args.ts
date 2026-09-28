import type { Values } from "./main.ts";

/** 命令行参数取值：字符串参数，没给或不是字符串为 undefined。 */
export const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
/** 可重复的字符串参数；只给一次也按列表。 */
export const strs = (values: Values, key: string) => {
  const value = values[key];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
};
