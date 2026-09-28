import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openUrlInvocation, spawnCommand } from "../server/platform/index.ts";
import { Problem } from "../server/problem.ts";
import {
  dataDirectory,
  readService,
  serviceUrl,
} from "../server/service-state.ts";
import type { MapTreeNode } from "../server/map/view.ts";
import type { Context } from "../server/map/context.ts";
import type { Command, Values } from "./main.ts";
import { printJson } from "./format.ts";
import { recordNext } from "./contract.ts";
import { fit } from "./top-plan.ts";
import { defaultActor } from "./worker-guard.ts";

/**
 * `atrium map`（#322 第 4 步）：人看全景用网页，Agent 用命令行。
 * - `atrium map` 在终端打一份全景树，并给一个一次性登录链接打开本机网页（交互终端里直接打开浏览器）；
 * - `atrium map 节点 --json` 与网页读同一个接口；`map context` 是派活时附进提示词的那段；
 * - `map edit` / `map add` 是唯一的改法，网页不提供编辑。
 */

const str = (values: Values, key: string) =>
  typeof values[key] === "string" ? (values[key] as string) : undefined;
const list = (values: Values, key: string) => {
  const value = values[key];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value]).map(String);
};
const client = async () => (await import("./service.ts")).connect();
const enc = encodeURIComponent;
const as = (values: Values) => {
  const who = str(values, "as") ?? defaultActor();
  return who ? `?as=${enc(who)}` : "";
};

/** 一块的标题：人话名在前，原名与类比跟在后面。 */
export function label(node: {
  ref: string;
  name: string;
  alias: string;
  analogy: string;
}) {
  const alias = node.alias && node.alias !== node.name;
  return `${node.ref} ${alias ? `${node.alias}（${node.name}）` : node.name}${node.analogy ? `——${node.analogy}` : ""}`;
}

const counts = (t: MapTreeNode["tasks"]) =>
  [
    t.running ? `在跑 ${t.running}` : "",
    t.blocked ? `卡住 ${t.blocked}` : "",
    t.open - t.running - t.blocked > 0
      ? `待办 ${t.open - t.running - t.blocked}`
      : "",
  ]
    .filter(Boolean)
    .map((p) => ` · ${p}`)
    .join("");

const DOT: Record<MapTreeNode["dot"], string> = {
  running: "●",
  blocked: "✕",
  idle: "○",
};

/** 全景树的文字版：一块一行，缩进表示层级；归档的不列。 */
export function renderMapTree(
  tree: MapTreeNode,
  options: { width?: number; what?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const walk = (node: MapTreeNode, level: number) => {
    if (node.archived) return;
    const indent = "  ".repeat(level);
    const line = `${indent}${DOT[node.dot]} ${label(node)}${node.aspect ? " · 管方面" : ""}${counts(node.tasks)}`;
    lines.push(options.width ? fit(line, options.width) : line);
    if (options.what !== false && node.what && level <= 1)
      lines.push(
        options.width
          ? fit(`${indent}  ${node.what}`, options.width)
          : `${indent}  ${node.what}`,
      );
    const kids = (node.children ?? []).filter((c) => !c.archived);
    if (node.children) for (const child of kids) walk(child, level + 1);
    else if (node.children_count)
      lines.push(
        `${indent}  …下层 ${node.children_count} 块：atrium map ${node.ref} --depth 2`,
      );
    if (node.children && node.children.length < node.children_count)
      lines.push(
        `${indent}  …还有 ${node.children_count - node.children.length} 块这次没展开：atrium map ${node.ref} --depth 1`,
      );
  };
  walk(tree, 0);
  return lines;
}

/** `top` 的全景段：根下各块的状态点、在跑数与一句是什么，最多 maxLines 行。 */
export function renderTopMap(
  tree: MapTreeNode | null,
  width: number,
  depth = 2,
  maxLines = 20,
): string[] {
  const lines = ["全景"];
  if (!tree) return [...lines, "  还没有组织树：atrium org import --repo 仓库"];
  const walk = (nodes: MapTreeNode[], level: number) => {
    for (const node of nodes) {
      if (node.archived) continue;
      const indent = "  ".repeat(level + 1);
      const what = node.what ? ` · ${node.what}` : "";
      lines.push(
        fit(
          `${indent}${DOT[node.dot]} ${label({ ...node, analogy: "" })}${counts(node.tasks)}${what}`,
          width,
        ),
      );
      if (level + 1 < depth && node.children) walk(node.children, level + 1);
    }
  };
  walk(tree.children ?? [], 0);
  if (lines.length === 1)
    lines.push("  还没有下一层：atrium map add 父节点 名称");
  if (lines.length <= maxLines) return lines;
  return [
    ...lines.slice(0, Math.max(1, maxLines - 1)),
    fit(`  …还有 ${lines.length - maxLines + 1} 行：atrium map`, width),
  ];
}

/** 交互终端里打开浏览器；执行者环境、非终端与 --no-open 都只打印链接。 */
function openBrowser(url: string) {
  try {
    const { command, args } = openUrlInvocation(process.platform, url);
    const child = spawnCommand(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function depthOf(values: Values, fallback: number) {
  const value = str(values, "depth");
  if (value === undefined) return fallback;
  if (!/^[0-8]$/.test(value))
    throw new Problem(
      400,
      `--depth 应为 0～8 的整数（收到：${value}）`,
      "usage",
    );
  return Number(value);
}

type TreeResult = { root: string | null; tree: MapTreeNode | null };

export const mapCommands: Record<string, Command> = {
  map: {
    args: "[节点] [--depth N] [--no-open] [--json]",
    about:
      "看全景：终端打全景树并打开本机网页（一次性登录链接）；--json 返回节点人话字段、组成、阶段与在跑任务（与网页同一接口）",
    options: {
      depth: { type: "string" },
      "no-open": { type: "boolean", default: false },
    },
    positionals: [0, 1],
    async run({ positionals: [node], values, json }) {
      const api = await client();
      if (json) {
        const root =
          node ??
          (await api.get<TreeResult>("/map/tree?depth=0")).root ??
          undefined;
        if (!root)
          throw new Problem(
            404,
            "还没有组织树",
            "not_found",
            undefined,
            "atrium org import --repo 仓库",
          );
        const result = await api.get<{ ref: string }>(
          `/map/nodes/${enc(root)}?depth=${depthOf(values, 1)}`,
        );
        printJson(result);
        recordNext(`动作：atrium map context ${result.ref}`);
        return 0;
      }
      const tree = await api.get<TreeResult>(
        `/map/tree?depth=${depthOf(values, 2)}${node ? `&root=${enc(node)}` : ""}`,
      );
      const lines = tree.tree
        ? renderMapTree(tree.tree, {
            width: process.stdout.isTTY ? process.stdout.columns : undefined,
          })
        : ["还没有组织树：atrium org import --repo 仓库"];
      const login = await api.post<{ path: string; ttl_ms: number }>(
        "/map/login",
      );
      const record = readService(dataDirectory());
      if (!record)
        throw new Problem(503, "找不到服务地址", "service_unavailable");
      const url = `${serviceUrl(record)}${login.path}${tree.root ? `&node=${tree.root}` : ""}`;
      const interactive =
        process.stdout.isTTY &&
        values["no-open"] !== true &&
        process.env.ATRIUM_WORKER !== "1";
      const opened = interactive && openBrowser(url);
      console.log(
        [
          ...lines,
          "",
          `${opened ? "已在浏览器打开全景网页" : "全景网页"}：${url}`,
          `（链接只能用一次，${Math.round(login.ttl_ms / 60_000)} 分钟内有效；只读，改动用 atrium map edit）`,
        ].join("\n"),
      );
      recordNext(`动作：atrium map ${tree.root ?? "节点"} --json`);
      return 0;
    },
  },
  "map context": {
    args: "节点 [--also 部分[,部分]] [--max 字数]",
    about:
      "给出从根到该节点的人话链、组成、现状与本节点及上级的要点，再加适用于本节点的管方面要点与 --also 牵涉部分的要点（注明来源，有长度上限）；派活时自动附进执行者提示词",
    options: { max: { type: "string" }, also: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      const query = new URLSearchParams(
        Object.fromEntries(
          (["max", "also"] as const)
            .filter((k) => str(values, k) !== undefined)
            .map((k) => [k, str(values, k)!]),
        ),
      ).toString();
      const result = await (
        await client()
      ).get<Context>(`/map/context/${enc(node!)}${query ? `?${query}` : ""}`);
      if (json) printJson(result);
      else
        console.log(
          result.text ||
            `${result.ref} 还没有人话字段：atrium map edit ${result.ref} --what 一句话`,
        );
      recordNext(`动作：atrium task add 标题 --part ${result.ref}`);
      return 0;
    },
  },
  "map edit": {
    args: "节点 [--what 一句话] [--uses 场景]… [--flow 步骤]… [--alias 人话名] [--analogy 类比] [--now 现状] [--next 接下来] [--applies 部分[,部分]] [--detail 文件] [--rev rN] [--reason 原因] [--as aN]",
    about:
      "改一块的人话字段，直接覆盖且不留修订；--applies 只用于管方面的部分，写它的要点缺省适用于哪些部分（空串改回整个上级）；--detail 文件改章程正文并留修订（--rev 仅用于此）；给空串清掉；负责部门 leader 或其上级可改，根只有你能改",
    options: {
      applies: { type: "string" },
      what: { type: "string" },
      uses: { type: "string", multiple: true },
      flow: { type: "string", multiple: true },
      alias: { type: "string" },
      analogy: { type: "string" },
      now: { type: "string" },
      next: { type: "string" },
      when: { type: "string" },
      detail: { type: "string" },
      rev: { type: "string" },
      reason: { type: "string" },
      as: { type: "string" },
    },
    positionals: [1, 1],
    async run({ positionals: [node], values, json }) {
      if (str(values, "when") !== undefined)
        console.error(
          "--when 已迁到专员的 --invite-when；请用 atrium specialist edit；旧写法暂可用",
        );
      const detail = str(values, "detail");
      let body: string | undefined;
      if (detail !== undefined)
        try {
          body = readFileSync(resolve(detail), "utf8");
        } catch (error) {
          throw new Problem(
            400,
            `--detail: 读不了 ${detail}（${(error as NodeJS.ErrnoException).code ?? "未知错误"}）`,
            "usage",
          );
        }
      const input = {
        ...Object.fromEntries(
          (
            [
              "what",
              "alias",
              "analogy",
              "now",
              "next",
              "when",
              "applies",
            ] as const
          )
            .filter((k) => str(values, k) !== undefined)
            .map((k) => [k, str(values, k)]),
        ),
        ...(list(values, "uses") ? { uses: list(values, "uses") } : {}),
        ...(list(values, "flow") ? { flow: list(values, "flow") } : {}),
        ...(body === undefined ? {} : { detail: body }),
        ...(str(values, "rev") ? { rev: str(values, "rev") } : {}),
        ...(str(values, "reason") ? { reason: str(values, "reason") } : {}),
      };
      const result = await (
        await client()
      ).patch<{ node: string; before?: string; rev?: string }>(
        `/map/nodes/${enc(node!)}${as(values)}`,
        input,
      );
      if (json) printJson(result);
      else console.log(`已改 ${result.node} 的全景`);
      recordNext(`动作：atrium map context ${result.node}`);
      return 0;
    },
  },
  "map add": {
    args: "父节点 名称 [--analogy 类比] [--alias 人话名] [--what 一句话] [--slug 路径名] [--kind aspect] [--reason 原因] [--as aN]",
    about:
      "在父节点下加一块（组成部分），可同时写人话名、类比与一句是什么；名称不能直接当路径名时给 --slug；--kind aspect 建管方面的部分（如安全，要点横跨多个部分，用 map edit --applies 或 org point-add --applies 写适用范围）",
    options: {
      analogy: { type: "string" },
      alias: { type: "string" },
      what: { type: "string" },
      slug: { type: "string" },
      kind: { type: "string" },
      reason: { type: "string" },
      as: { type: "string" },
    },
    positionals: [2, 2],
    async run({ positionals: [parent, name], values, json }) {
      const result = await (
        await client()
      ).post<{
        node: string;
        parent: string;
        name: string;
        kind: string;
        aspect: boolean;
      }>(`/map/nodes${as(values)}`, {
        parent,
        name,
        ...Object.fromEntries(
          (["analogy", "alias", "what", "slug", "kind", "reason"] as const)
            .filter((k) => str(values, k) !== undefined)
            .map((k) => [k, str(values, k)]),
        ),
      });
      if (json) printJson(result);
      else
        console.log(
          `已在 ${result.parent} 下加了 ${result.node} ${result.name}（${result.aspect ? "管方面" : result.kind}）`,
        );
      recordNext(
        result.aspect
          ? `动作：atrium org point-add ${result.node} 要点 --why 为什么 --by 谁定的 --applies 部分`
          : `动作：atrium map edit ${result.node} --what 一句话 --uses 场景 --flow 步骤`,
      );
      return 0;
    },
  },
};
