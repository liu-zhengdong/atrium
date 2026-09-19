import type { ReactNode } from "react";
export function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty flex flex-1 flex-col items-center justify-center px-6 py-[45px] text-center">
      <div className="mb-[18px] flex h-[72px] w-[72px] items-center justify-center rounded-full bg-soft text-[#b0ab9f] [&>svg]:h-[30px] [&>svg]:w-[30px]">
        {icon}
      </div>
      <h2 className="m-0 mb-1.5 text-[21px] font-semibold text-[#46453f] max-[560px]:text-[19px]">
        {title}
      </h2>
      {children}
    </div>
  );
}
