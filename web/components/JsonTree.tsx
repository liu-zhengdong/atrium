import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  branchPreview,
  isBranch,
  jsonString,
  parseBranch,
  type JsonValue,
} from "./json-tree.ts";

/** 调用参数/执行结果：整段是对象或数组时按层级显示，可以切回原文整段复制。 */
export function TraceValue({ label, text }: { label: string; text: string }) {
  const branch = parseBranch(text);
  const [raw, setRaw] = useState(false);
  return (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h4 className="m-0 text-[10px] font-medium text-muted">{label}</h4>
        {branch && (
          <button
            type="button"
            className="rounded text-[10px] text-muted hover:text-accent"
            aria-pressed={raw}
            onClick={() => setRaw((value) => !value)}
          >
            {raw ? "按 JSON 显示" : "原文"}
          </button>
        )}
      </div>
      {branch && !raw ? (
        <div className="mb-3.5 max-h-[260px] overflow-auto font-mono text-[11px] leading-[1.65] [overflow-wrap:anywhere] last:mb-0">
          <JsonNode value={branch} depth={0} />
        </div>
      ) : (
        <pre className="mb-3.5 max-h-[260px] overflow-auto whitespace-pre-wrap leading-[1.65] [overflow-wrap:anywhere] last:mb-0">
          {text}
        </pre>
      )}
    </>
  );
}

/** 默认展开两层：MCP 调用的 {server, tool, args} 一打开就能看到 args 里的字段。 */
function JsonNode({
  name,
  value,
  depth,
}: {
  name?: string;
  value: JsonValue;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  // 字符串值本身是对象或数组时也展开成子树，MCP 的结果常是这种。
  const inner = typeof value === "string" ? jsonString(value) : null;
  const branch = isBranch(value) ? value : inner;
  if (!branch) return <JsonLeaf name={name} value={value} />;
  const array = Array.isArray(branch);
  const closeMark = array ? "]" : "}";
  // 空的容器当成叶子：展开只有两行括号，没有可看的东西。
  const empty = array ? branch.length === 0 : Object.keys(branch).length === 0;
  if (empty)
    return (
      <LeafRow name={name}>
        <span className="text-[#8a968d]">{array ? "[]" : "{}"}</span>
      </LeafRow>
    );
  const fields = array
    ? branch.map((item, index) => (
        <JsonNode key={index} value={item} depth={depth + 1} />
      ))
    : Object.entries(branch).map(([key, item]) => (
        <JsonNode key={key} name={key} value={item} depth={depth + 1} />
      ));
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-1 rounded text-left hover:bg-[#edf3ef]"
      >
        <ChevronRight
          size={11}
          className={`mt-[3px] flex-none text-[#8a968d] transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          {name !== undefined && (
            <>
              <span className="text-[#3c5e4a]">{name}</span>
              <span className="text-[#8a968d]">: </span>
            </>
          )}
          {inner && (
            <span className="mr-1 rounded bg-[#edf3ef] px-1 text-[9px] text-[#5c685f]">
              JSON 字符串
            </span>
          )}
          {open ? (
            <span className="text-[#8a968d]">{array ? "[" : "{"}</span>
          ) : (
            // 收起时只给预览：branchPreview 自带括号，再拼一层就成了 [[100 项]]。
            <span className="text-[#5c685f]">{branchPreview(branch)}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="ml-[5px] border-l border-[#dce3de] pl-2">
          {fields}
          <span className="text-[#8a968d]">{closeMark}</span>
        </div>
      )}
    </div>
  );
}

function LeafRow({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-1 pl-[15px]">
      <span className="min-w-0 flex-1">
        {name !== undefined && (
          <>
            <span className="text-[#3c5e4a]">{name}</span>
            <span className="text-[#8a968d]">: </span>
          </>
        )}
        {children}
      </span>
    </div>
  );
}

function JsonLeaf({ name, value }: { name?: string; value: JsonValue }) {
  return (
    <LeafRow name={name}>
      {typeof value === "string" ? (
        // 引号让空串、全空白串和数字、布尔区分得开，不靠颜色；值里的换行按真实换行显示。
        <span className="whitespace-pre-wrap text-[#5c685f]">"{value}"</span>
      ) : (
        <span className={leafClass(value)}>{String(value)}</span>
      )}
    </LeafRow>
  );
}

function leafClass(value: JsonValue) {
  if (typeof value === "number") return "text-[#8a6b3a]";
  if (typeof value === "boolean") return "text-[#3f6b7a]";
  return "text-[#5c685f] italic";
}
