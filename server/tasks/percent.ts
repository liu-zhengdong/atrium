/** 富余百分比写成 +54% / −13%。单独成模块：命令行只要它，不必加载 pick.ts 的整棵依赖（t117）。 */
export function signedPercent(value: number): string {
  const n = Math.round(value);
  return n > 0 ? `+${n}%` : n < 0 ? `−${-n}%` : "0%";
}
