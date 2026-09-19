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
  // avatar 保留为标记类：回执头像、移动端成员堆叠等场景式覆盖仍指向它。
  return (
    <span
      className={`avatar relative inline-flex flex-none select-none items-center justify-center bg-[#eeece5] font-[550] text-[#756c57] ${
        small
          ? "h-[29px] w-[29px] rounded-[9px] text-xs"
          : "h-[34px] w-[34px] rounded-[10px] text-sm"
      }`}
    >
      {Array.from(name)[0]}
      {online !== undefined && (
        <i
          className={`absolute -right-[2px] -bottom-[1px] h-[9px] w-[9px] rounded-full border-2 border-surface ${
            online ? "bg-[#73876d]" : "bg-[#c8c5bc]"
          }`}
        />
      )}
    </span>
  );
}
