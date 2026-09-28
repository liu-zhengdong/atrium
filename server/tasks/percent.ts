/** 额度文案。单独成模块：命令行只要它，不必加载 pick.ts 的整棵依赖（t117）。 */

/** 富余百分比写成 +54% / −13%。 */
export function signedPercent(value: number): string {
  const n = Math.round(value);
  return n > 0 ? `+${n}%` : n < 0 ? `−${-n}%` : "0%";
}

/** 旧读数的标注：旧数（2.5 小时前）；不知道多久前时只写旧数。 */
export function staleLabel(hoursAgo: number | null | undefined): string {
  return typeof hoursAgo === "number" && Number.isFinite(hoursAgo)
    ? `旧数（${Number(hoursAgo.toFixed(1))} 小时前）`
    : "旧数";
}
