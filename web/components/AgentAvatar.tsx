import type { Overview } from "../../shared/schema.ts";
export type Agent = Overview["agents"][number];
export type Presence = "busy" | "online" | "offline";
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
export function agentPresence(
  a: { available: boolean; runtime?: { busy: boolean } | null } | undefined,
): Presence {
  if (!a) return "offline";
  if (a.runtime?.busy) return "busy";
  if (a.available) return "online";
  return "offline";
}
const presenceDotClass: Record<Presence, string> = {
  busy: "bg-[#e08a24]",
  online: "bg-[#1a9d4a]",
  offline: "bg-[#c8c5bc]",
};
export function Avatar({
  name,
  presence,
  small = false,
  tiny = false,
  className = "",
  onClick,
}: {
  name: string;
  presence?: Presence;
  small?: boolean;
  /** 20px 圆形头像，用于已读回执的头像组。 */
  tiny?: boolean;
  className?: string;
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
        <Avatar name={name} small={small} presence={presence} />
      </button>
    );
  // avatar 保留为标记类：回执头像、移动端成员堆叠等场景式覆盖仍指向它。
  return (
    <span
      className={`avatar relative inline-flex flex-none select-none items-center justify-center font-[550] ${
        tiny
          ? "h-5 w-5 rounded-full bg-[#e5e9ee] text-[9px] text-[#617087]"
          : small
            ? "h-[29px] w-[29px] rounded-[9px] bg-[#eeece5] text-xs text-[#756c57]"
            : "h-[34px] w-[34px] rounded-[10px] bg-[#eeece5] text-sm text-[#756c57]"
      } ${className}`}
    >
      {Array.from(name)[0]}
      {presence !== undefined && (
        <i
          data-presence={presence}
          className={`absolute -right-[2px] -bottom-[1px] h-[9px] w-[9px] rounded-full border-2 border-surface ${presenceDotClass[presence]}`}
        />
      )}
    </span>
  );
}
