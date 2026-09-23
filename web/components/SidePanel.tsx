import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Split View 侧边工作台面板
 * - 宽屏下（>=1024px）作为右侧并排分栏（Split View），聊天与面板互不遮挡，可边看边聊；
 * - 窄屏下（<1024px）自适应滑出，兼顾移动设备；
 * - 按 Escape 键可快捷关闭。
 */
export function SidePanel({
  title,
  close,
  children,
  badge,
  actions,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <>
      {/* 窄屏遮罩：仅在小屏下出现 */}
      <div
        className="fixed inset-0 z-30 bg-[#121c15]/20 backdrop-blur-[1px] min-[1024px]:hidden"
        onClick={close}
        aria-hidden="true"
      />
      <aside
        className="split-panel fixed inset-y-0 right-0 z-40 flex w-[min(460px,100vw)] flex-col border-l border-black/[0.04] bg-white shadow-xl transition-all duration-200 min-[1024px]:relative min-[1024px]:z-10 min-[1024px]:w-[400px] min-[1024px]:flex-none min-[1024px]:shadow-none"
        aria-label={title}
      >
        <header className="flex h-11 flex-none items-center justify-between border-b border-black/[0.04] px-5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
            {badge}
          </div>
          <div className="flex items-center gap-1">
            {actions}
            <button
              className="icon-button text-muted hover:bg-[#edf3ef] hover:text-ink"
              aria-label="关闭面板"
              title="关闭面板 (Esc)"
              onClick={close}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </>
  );
}
