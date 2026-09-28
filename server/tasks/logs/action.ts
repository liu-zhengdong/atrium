import { ADAPTERS, type Tool } from "../adapters/index.ts";
import { clip } from "../../text-width.ts";
import { commandGist } from "./command-gist.ts";
import {
  agyStep,
  agyTextAt,
  parseEvents,
  textOf,
  type JsonEvent,
  object,
} from "./json-log.ts";

/**
 * 执行者日志里的「最近动作」（#262 `atrium top`、#322 全景网页）：看板要让人一眼看懂执行者此刻在做什么。
 * 优先取执行者自己说的话——日志尾部最近一段助手文本的首句（如「正在补单测」）；
 * 没有时退回最后一次工具调用的人话概括：读/改了哪个文件（只写文件名）、跑了什么检查
 * （command-gist.ts），不显示命令参数与 heredoc 内容。纯函数，只读入参里的文本。
 *
 * 按适配器选解析方式：progressSignals 含 json_events 的（claude / agy / cursor stream-json、opencode --format json）
 * 逐行 JSON 事件；codex 的 exec 不带 --json，是分段纯文本，单独一套解析。grok、kimi 的输出格式
 * 没有样本，一律返回 undefined，由命令行显示「日志 N 秒前有输出」，不猜。
 */

export type Action = {
  /** 一句人话，如「正在补单测」「跑完整检查」「改 write.ts」「开 PR」。 */
  text: string;
  /** tool：一次工具调用的概括；step：执行者自己说的一句话。 */
  kind: "tool" | "step";
};

/** 显示宽度上限：40 个汉字（中英混排按显示宽度算，汉字两格）。 */
export const ACTION_WIDTH = 80;

const cap = (text: string) => clip(text, ACTION_WIDTH);

/** 句末标点；英文句点后须跟空白或到结尾，免得切在文件名、版本号里。 */
const SENTENCE_END = /[。！？；!?;]|\.(?=\s|$)/;

/**
 * 一段助手文本的首句：取第一行有字的正文，去掉 Markdown 记号（标题、列表、加粗、行内代码、链接），
 * 切在第一个句末标点，去掉句尾的标点。代码块里的内容不算话。
 */
export function firstSentence(text: string): string | undefined {
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (!plain || /^[-=*_|:\s]+$/.test(plain)) continue;
    const end = SENTENCE_END.exec(plain);
    const sentence = (end ? plain.slice(0, end.index) : plain)
      .replace(/[，,：:、\s]+$/, "")
      .trim();
    if (sentence) return sentence;
  }
  return undefined;
}

const step = (text: string): Action | undefined => {
  const sentence = firstSentence(text);
  return sentence ? { kind: "step", text: cap(sentence) } : undefined;
};

/** 路径只留文件名：看板上一眼看出改的是哪个文件就够。 */
const fileName = (path: string) =>
  path.replace(/\/+$/, "").split("/").pop() || path;

/** 工具名 → 人话；名字大小写不敏感（claude 是 Bash、opencode 是 bash，agy 是 run_command、view_file 等）。 */
const PATH_KEYS = [
  "filePath",
  "file_path",
  "path",
  "notebook_path",
  "AbsolutePath",
  "TargetFile",
];
const COMMAND_TOOLS = new Set(["bash", "shell", "run_command"]);
const COMMAND_KEYS = ["command", "CommandLine"];
const FILE_VERBS: Record<string, string> = {
  read: "读",
  view: "读",
  view_file: "读",
  write: "写",
  create: "写",
  write_to_file: "写",
  edit: "改",
  patch: "改",
  multiedit: "改",
  notebookedit: "改",
  notebook_edit: "改",
  apply_patch: "改",
  replace_file_content: "改",
  multi_replace_file_content: "改",
  sed_file: "改",
  delete: "删",
};
const FIXED: Record<string, string> = {
  grep: "搜代码",
  glob: "列文件",
  list: "列目录",
  ls: "列目录",
  webfetch: "取网页",
  fetch: "取网页",
  websearch: "搜网页",
  todowrite: "列待办",
  todoread: "看待办",
  updatetodos: "列待办",
  bashoutput: "看后台输出",
  killshell: "停后台命令",
  toolsearch: "找工具",
  grep_search: "搜代码",
  find_by_name: "列文件",
  list_dir: "列目录",
  read_url_content: "取网页",
  search_web: "搜网页",
  command_status: "看后台输出",
};

/** 工具入参里的文字；codex 的 shell 参数是数组（["bash","-lc","ls"]）。 */
function textIn(input: JsonEvent | undefined, key: string) {
  const value = input?.[key];
  const text = Array.isArray(value) ? value.join(" ") : value;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function describe(name: string, input: JsonEvent | undefined): Action {
  const key = name.toLowerCase();
  const tool = (text: string): Action => ({ kind: "tool", text: cap(text) });
  if (COMMAND_TOOLS.has(key)) {
    const command = COMMAND_KEYS.map((k) => textIn(input, k)).find(Boolean);
    return tool(command ? commandGist(command) : "跑命令");
  }
  const verb = FILE_VERBS[key];
  if (verb) {
    const path = PATH_KEYS.map((k) => textIn(input, k)).find(Boolean);
    return tool(path ? `${verb} ${fileName(path)}` : `${verb}文件`);
  }
  if (FIXED[key]) return tool(FIXED[key]);
  if (key === "task" || key === "agent" || key === "invoke_subagent") {
    const what = textIn(input, "description");
    return tool(what ? `派子任务：${what}` : "派子任务");
  }
  if (key === "skill") {
    const skill = textIn(input, "skill") ?? textIn(input, "name");
    return tool(skill ? `用技能 ${skill}` : "用技能");
  }
  return tool(name || "调用工具");
}

/**
 * cursor 的工具调用：{type:"tool_call",subtype:"started",tool_call:{readToolCall:{args:{path}}}}；
 * 键名去掉 ToolCall 就是工具名（read、shell、edit、grep…），completed 是同一调用的结果，不另算。
 */
function cursorTool(event: JsonEvent): Action | undefined {
  if (event.subtype !== "started") return undefined;
  const call = object(event.tool_call);
  const key = Object.keys(call ?? {}).find((k) => k.endsWith("ToolCall"));
  if (!key) return undefined;
  return describe(
    key.slice(0, -"ToolCall".length),
    object(object(call![key])?.args),
  );
}

/**
 * 结构化日志（claude / agy / cursor stream-json、opencode --format json）里的最近动作。
 * 从后往前找：助手文本（opencode 的 text 事件、claude / cursor assistant 的 text 块、agy 同一步的 text_delta 拼起来）
 * 一出现就用它的首句；找到头也没有文本，才用最后一次工具调用（opencode 的 tool_use 事件、claude 的 tool_use 块、
 * agy step_type 为 tool 的步骤、cursor 的 tool_call 事件）。claude 的 user 事件只是工具结果，不是动作。
 */
export function structuredAction(tail: string): Action | undefined {
  const events = parseEvents(tail);
  let lastTool: Action | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    // agy：{event:"step_update",step_update:{step_type:"tool",tool_name,tool_info:{parameters}}}
    const agy = agyStep(event);
    if (agy) {
      if (agy.step_type === "tool")
        lastTool ??= describe(
          String(agy.tool_name ?? ""),
          object(object(agy.tool_info)?.parameters),
        );
      const pieces = agyTextAt(events, i);
      if (pieces) {
        const said = step(pieces.text);
        if (said) return said;
        i = pieces.start;
      }
      continue;
    }
    // opencode：{type:"tool_use",part:{tool,state:{input}}}
    if (event.type === "tool_use") {
      const part = object(event.part);
      if (part)
        lastTool ??= describe(
          String(part.tool ?? ""),
          object(object(part.state)?.input),
        );
      continue;
    }
    if (event.type === "tool_call") {
      lastTool ??= cursorTool(event);
      continue;
    }
    // claude：{type:"assistant",message:{content:[{type,name,input}|{type:"text",text}]}}
    if (event.type === "assistant") {
      const content = object(event.message)?.content;
      if (Array.isArray(content))
        for (let j = content.length - 1; j >= 0; j--) {
          const item = object(content[j]);
          if (item?.type === "tool_use")
            lastTool ??= describe(String(item.name ?? ""), object(item.input));
          if (item?.type === "text" && typeof item.text === "string") {
            const said = step(item.text);
            if (said) return said;
          }
        }
      continue;
    }
    const text = textOf(event);
    const said = text === undefined ? undefined : step(text);
    if (said) return said;
  }
  return lastTool;
}

// ---- codex exec 的分段纯文本（0.157.1 实测）----
// 抬头是「OpenAI Codex v…」，之后每一段以段名独占一行开头：
// codex（助手这一轮说的话）、exec（跑的命令，下一行起是「<shell> -lc "…" in <目录>」，
// 命令带 heredoc 时跨多行）、apply patch（改文件）、tokens used（收尾账目，不是动作）。
const CODEX_HEADS = new Set([
  "user",
  "codex",
  "exec",
  "apply patch",
  "tokens used",
]);

/** 去掉 exec 的「/bin/zsh -lc "…" in /目录」外壳，留下真正跑的命令（可能跨行）。 */
function unwrapShell(text: string) {
  const match = /^([\s\S]*) in \/\S+$/.exec(text);
  const command = match ? match[1]! : text;
  const shell =
    /^\S+\s+-l?c\s+"([\s\S]*)"$/.exec(command) ??
    /^\S+\s+-l?c\s+'([\s\S]*)'$/.exec(command);
  return shell ? shell[1]!.replace(/\\(["\\$`])/g, "$1") : command;
}

/** exec 段的命令：从段名下一行起，到以「 in /目录」收尾的那一行（heredoc 会跨多行）。 */
function execCommand(lines: string[]) {
  const taken: string[] = [];
  for (const line of lines.slice(0, 400)) {
    taken.push(line);
    if (/ in \/\S+$/.test(line)) return unwrapShell(taken.join("\n"));
  }
  return lines[0] === undefined ? undefined : unwrapShell(lines[0]);
}

/** apply patch 段的目标文件名：先找 patch 提示后的绝对路径，再找 diff 的 +++ b/<文件>。 */
function patchTarget(body: string[]) {
  const path = body.find((line) => line.startsWith("/"));
  if (path) return fileName(path);
  const diff = /^\+\+\+ b\/(.+)$/m.exec(body.join("\n"));
  return diff ? fileName(diff[1]!) : "文件";
}

/**
 * codex 的最近动作：从后往前找段，codex 段（助手说的话）一出现就用它的首句；
 * 找到头也没有，才用最后一段 exec / apply patch 的概括。
 */
export function codexAction(tail: string): Action | undefined {
  // Windows 上的日志可能是 CRLF：行尾的 \r 会让「 in /目录」收尾认不出来。
  const lines = tail.split(/\r?\n/);
  let lastTool: Action | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const head = lines[i]!.trim();
    if (!head || !CODEX_HEADS.has(head)) continue;
    if (head === "tokens used" || head === "user") continue;
    if (head === "exec") {
      const command = execCommand(lines.slice(i + 1));
      lastTool ??= {
        kind: "tool",
        text: cap(command ? commandGist(command) : "跑命令"),
      };
      continue;
    }
    if (head === "apply patch") {
      const body = lines
        .slice(i + 1, i + 40)
        .map((line) => line.trim())
        .filter(Boolean);
      lastTool ??= { kind: "tool", text: cap(`改 ${patchTarget(body)}`) };
      continue;
    }
    // codex 段：到下一个段名为止是这一轮说的话。
    const body: string[] = [];
    for (const line of lines.slice(i + 1)) {
      if (CODEX_HEADS.has(line.trim())) break;
      body.push(line);
    }
    const said = step(body.join("\n"));
    if (said) return said;
  }
  return lastTool;
}

/** 按适配器取日志尾部的最近一个动作；解析不了返回 undefined。 */
export function recentAction(input: {
  tool: Tool | undefined;
  tail: string;
}): Action | undefined {
  if (!input.tool) return undefined;
  return ADAPTERS[input.tool].progressSignals.includes("json_events")
    ? structuredAction(input.tail)
    : input.tool === "codex"
      ? codexAction(input.tail)
      : undefined;
}
