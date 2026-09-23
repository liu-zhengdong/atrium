import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components = {
  a: (props: React.ComponentProps<"a">) => (
    <a {...props} target="_blank" rel="noreferrer" />
  ),
  // 正文由 Agent 写，不替它去加载外部图片。
  img: ({ alt }: React.ComponentProps<"img">) => (
    <span>[图片：{alt || "未加载"}]</span>
  ),
};

/** 聊天消息与共享目录共用的 Markdown 渲染，支持表格、删除线等 GFM 写法。 */
export function RichText({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </Markdown>
  );
}
