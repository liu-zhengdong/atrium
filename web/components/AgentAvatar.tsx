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
  onClick,
}: {
  name: string;
  online?: boolean;
  small?: boolean;
  onClick?: () => void;
}) {
  if (onClick)
    return (
      <button
        className="avatar-button"
        aria-label={`查看 ${name} 的运行轨迹`}
        title={`查看 ${name} 的运行轨迹`}
        onClick={onClick}
      >
        <Avatar name={name} small={small} online={online} />
      </button>
    );
  return (
    <span className={`avatar ${small ? "small" : ""}`}>
      {Array.from(name)[0]}
      {online !== undefined && <i className={online ? "online" : ""} />}
    </span>
  );
}
