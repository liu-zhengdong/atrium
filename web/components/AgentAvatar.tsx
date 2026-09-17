import type { Overview } from "../../shared/schema.ts";
export type Agent = Overview["agents"][number];
export const runtimeLabel = (a: Agent) =>
  a.runtime
    ? a.runtime.busy
      ? "执行中"
      : "在线"
    : a.error && a.available
      ? "暂不可用"
      : a.available
        ? "在线"
        : "离线";
export function Avatar({
  name,
  online,
  small = false,
}: {
  name: string;
  online?: boolean;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${small ? "small" : ""}`}>
      {Array.from(name)[0]}
      {online !== undefined && <i className={online ? "online" : ""} />}
    </span>
  );
}
