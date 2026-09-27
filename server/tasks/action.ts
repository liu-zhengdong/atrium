import { ADAPTERS, type Tool } from "./adapters/index.ts";
import { parseEvents, textOf, type JsonEvent } from "./json-log.ts";

/**
 * 执行者日志里的「最近一个动作」（#262 `atrium top`）：实时视图要看出执行者此刻在做什么，
 * 拿的是日志尾部最后一次工具调用或一步说明，不是整份日志。纯函数，只读入参里的文本。
 *
 * 按适配器选解析方式：progressSignals 含 json_events 的（claude stream-json、opencode --format json）
 * 逐行 JSON 事件；codex 的 exec 不带 --json，是分段纯文本，单独一套解析。grok、kimi 的输出格式
 * 没有样本，一律返回 undefined，由命令行显示「日志 N 秒前有输出」，不猜。
 */

export type Action = {
  /** 一行描述，如「跑 npm run check」「写 server/org/write.ts」「已读 PR 评论」。 */
  text: string;
  /** tool：一次工具调用；step：一段助手文本（下一步该做什么）。 */
  kind: "tool" | "step";
};

const CAP = 100;

/** 描述一行，命令行还会按窗口宽度再截一次。 */
const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CAP ? `${line.slice(0, CAP)}…` : line;
};

/** 工作目录里的绝对路径缩成相对路径，窄屏里省地方。 */
function relative(file: string, cwd?: string) {
  if (!cwd) return file;
  const root = cwd.replace(/\/+$/, "");
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}

/** 工具名 → 动词与取哪个入参当目标；名字大小写不敏感（claude 是 Bash、opencode 是 bash）。 */
const VERBS: Record<string, [verb: string, keys: string[], isPath: boolean]> = {
  read: ["读", ["filePath", "file_path", "path"], true],
  view: ["读", ["filePath", "file_path", "path"], true],
  write: ["写", ["filePath", "file_path", "path"], true],
  create: ["写", ["filePath", "file_path", "path"], true],
  edit: ["改", ["filePath", "file_path", "path"], true],
  patch: ["改", ["filePath", "file_path", "path"], true],
  multiedit: ["改", ["filePath", "file_path", "path"], true],
  notebookedit: ["改", ["notebook_path", "filePath"], true],
  bash: ["跑", ["command"], false],
  bashoutput: ["看", ["bash_id"], false],
  shell: ["跑", ["command"], false],
  grep: ["搜", ["pattern"], false],
  glob: ["列文件", ["pattern"], false],
  list: ["列目录", ["path"], true],
  ls: ["列目录", ["path"], true],
  webfetch: ["取", ["url"], false],
  websearch: ["搜", ["query"], false],
  fetch: ["取", ["url"], false],
  task: ["派活", ["description"], false],
  todowrite: ["列待办", [], false],
  todoread: ["看待办", [], false],
};

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonEvent)
    : undefined;

/** 工具入参里的目标；codex 的 shell 参数是数组（["bash","-lc","ls"]）。 */
function targetOf(input: JsonEvent | undefined, key: string) {
  const value = input?.[key];
  const text = Array.isArray(value) ? value.join(" ") : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function describe(
  name: string,
  input: JsonEvent | undefined,
  cwd?: string,
): Action {
  const spec = VERBS[name.toLowerCase()];
  if (!spec) return { kind: "tool", text: oneLine(name || "调用工具") };
  const [verb, keys, isPath] = spec;
  for (const key of keys) {
    const target = targetOf(input, key);
    if (target)
      return {
        kind: "tool",
        text: oneLine(`${verb} ${isPath ? relative(target, cwd) : target}`),
      };
  }
  return { kind: "tool", text: verb };
}

/**
 * 结构化日志（claude stream-json、opencode --format json）里的最后一个动作。
 * 从后往前找：opencode 的 tool_use 事件、claude 的 assistant 内容块、助手文本；
 * claude 的 user 事件只是工具结果，不是动作。
 */
export function structuredAction(
  tail: string,
  cwd?: string,
): Action | undefined {
  const events = parseEvents(tail);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    // opencode：{type:"tool_use",part:{tool,state:{input}}}
    if (event.type === "tool_use") {
      const part = object(event.part);
      if (part)
        return describe(
          String(part.tool ?? ""),
          object(object(part.state)?.input),
          cwd,
        );
      continue;
    }
    // claude：{type:"assistant",message:{content:[{type,name,input}|{type:"text",text}]}}
    if (event.type === "assistant") {
      const content = object(event.message)?.content;
      if (Array.isArray(content))
        for (let j = content.length - 1; j >= 0; j--) {
          const item = object(content[j]);
          if (item?.type === "tool_use")
            return describe(String(item.name ?? ""), object(item.input), cwd);
          if (
            item?.type === "text" &&
            typeof item.text === "string" &&
            item.text.trim()
          )
            return { kind: "step", text: oneLine(item.text) };
        }
      continue;
    }
    const text = textOf(event);
    if (text !== undefined) return { kind: "step", text: oneLine(text) };
  }
  return undefined;
}

// ---- codex exec 的分段纯文本（0.157.1 实测）----
// 抬头是「OpenAI Codex v…」，之后每一段以段名独占一行开头：
// codex（助手这一轮说的话）、exec（跑的命令，下一行是「<shell> … in <目录>」）、
// apply patch（改文件）、tokens used（收尾账目，不是动作）。
const CODEX_HEADS = new Set([
  "user",
  "codex",
  "exec",
  "apply patch",
  "tokens used",
]);

/** 去掉 exec 行的「/bin/zsh -lc "…" in /目录」外壳，留下真正跑的命令。 */
function unwrapShell(line: string) {
  const match = /^(.*) in \/\S+$/.exec(line);
  const command = match ? match[1]! : line;
  const shell =
    /^\S+\s+-lc\s+"(.*)"$/.exec(command) ??
    /^\S+\s+-lc\s+'(.*)'$/.exec(command) ??
    /^\S+\s+-c\s+"(.*)"$/.exec(command) ??
    /^\S+\s+-c\s+'(.*)'$/.exec(command);
  return shell ? shell[1]! : command;
}

/** apply patch 段的目标：先找 patch 提示后的绝对路径，再找 diff 的 +++ b/<文件>。 */
function patchTarget(body: string[], cwd?: string) {
  const path = body.find((line) => line.startsWith("/"));
  if (path) return relative(path, cwd);
  const diff = /^\+\+\+ b\/(.+)$/m.exec(body.join("\n"));
  return diff ? diff[1]! : "文件";
}

/** codex 的最近一个动作：最后一段（跳过 tokens used）里的工具调用或助手那一段话。 */
export function codexAction(tail: string, cwd?: string): Action | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const head = lines[i]!.trim();
    if (!head || head === "--------" || !CODEX_HEADS.has(head)) continue;
    if (head === "tokens used" || head === "user") continue;
    const body = lines
      .slice(i + 1)
      .map((line) => line.trim())
      .filter(Boolean);
    if (head === "exec") {
      const command = body[0];
      return {
        kind: "tool",
        text: oneLine(command ? `跑 ${unwrapShell(command)}` : "跑命令"),
      };
    }
    if (head === "apply patch")
      return { kind: "tool", text: oneLine(`改 ${patchTarget(body, cwd)}`) };
    const prose = body[0];
    return prose ? { kind: "step", text: oneLine(prose) } : undefined;
  }
  return undefined;
}

/** 按适配器取日志尾部的最近一个动作；解析不了返回 undefined。 */
export function recentAction(input: {
  tool: Tool | undefined;
  tail: string;
  cwd?: string;
}): Action | undefined {
  if (!input.tool) return undefined;
  return ADAPTERS[input.tool].progressSignals.includes("json_events")
    ? structuredAction(input.tail, input.cwd)
    : input.tool === "codex"
      ? codexAction(input.tail, input.cwd)
      : undefined;
}
