import type { Overview } from "../../shared/schema.ts";
export type Agent = Overview["agents"][number];
export type Presence = "busy" | "online" | "offline" | "error";
export const runtimeLabel = (a: Agent) =>
  a.unassigned
    ? "未分配账号"
    : a.failure
      ? "出错"
      : a.runtime
        ? a.runtime.busy
          ? "执行中"
          : "在线"
        : a.error && a.available
          ? "暂不可用"
          : a.available
            ? "在线"
            : "离线";
/** 头像上的状态点表达不了的状态：连不上但报过错。在线、执行中、离线看点，不再写字。 */
export const statusNote = (a: Agent) =>
  !a.failure && !a.runtime && a.error && a.available ? "暂不可用" : "";
/**
 * 名单里头像旁的一行：职位（自我介绍）常驻，没写就看工作声明，再没有就是短号。
 * 状态点表达不了的「暂不可用」排在最前。
 */
export const agentSummary = (a: Agent) =>
  a.unassigned
    ? "未分配账号"
    : statusNote(a) || a.description || a.work || a.ref;
export function agentPresence(
  a:
    | {
        available: boolean;
        failure?: Agent["failure"];
        runtime?: { busy: boolean } | null;
        unassigned?: boolean;
      }
    | undefined,
): Presence {
  if (!a) return "offline";
  if ("unassigned" in a && a.unassigned) return "offline";
  if (a.failure) return "error";
  if (a.runtime?.busy) return "busy";
  if (a.available) return "online";
  return "offline";
}
const presenceDotClass: Record<Presence, string> = {
  busy: "bg-[#e08a24]",
  online: "bg-[#1a9d4a]",
  offline: "bg-[#c8c5bc]",
  error: "bg-[#c75143]",
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
