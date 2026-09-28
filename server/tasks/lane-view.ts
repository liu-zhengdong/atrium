import { quietMinutes } from "./check-quiet.ts";

/**
 * 看板顶上的醒目提示（t265）：发版失败的任务各一行，合入给紧急任务让路的并成一行（在等谁、等了多久）。
 * 纯函数，`top` 与状态栏共用；每行的原料由服务端 `topRows` 给（`release_failed`、`merge_held`）。
 */

export type LaneRow = {
  ref: string;
  release_failed?: string | null;
  merge_held?: { by: string; waited_ms: number | null } | null;
};

export type LaneAlerts = {
  /** 「t260 发版失败：发版工作流挂在 npm run check」，一件一行。 */
  release: string[];
  /** 「合入让路：3 件等紧急 t260（等发版）· 已等 15 分钟」；没有让路为 null。 */
  held: string | null;
};

export function laneAlerts(rows: readonly LaneRow[]): LaneAlerts {
  const release = rows
    .filter((row) => row.release_failed)
    .map((row) => `${row.ref} 发版失败：${row.release_failed}`);
  const held = rows.filter((row) => row.merge_held);
  if (!held.length) return { release, held: null };
  // 各行等的多半是同一批紧急任务；写法不同时（刚有一件合入完）取等得最久那行的。
  const longest = held.reduce((a, b) =>
    (b.merge_held!.waited_ms ?? -1) > (a.merge_held!.waited_ms ?? -1) ? b : a,
  ).merge_held!;
  const waited =
    longest.waited_ms !== null && longest.waited_ms > 0
      ? ` · 已等 ${quietMinutes(longest.waited_ms)}`
      : "";
  return {
    release,
    held: `合入让路：${held.length} 件等紧急 ${longest.by}${waited}`,
  };
}
