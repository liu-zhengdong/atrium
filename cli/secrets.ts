import { Problem } from "../server/problem.ts";
import { SECRET_VALUE_MAX, secretValue } from "../server/secrets/model.ts";
import { recordNext } from "./contract.ts";
import { oneLine, printJson, table, when } from "./format.ts";
import type { Command, Values } from "./main.ts";

/**
 * 凭据（t194）：挂在节点上的令牌、密码，按「节点 + 名称」找，名称就是注入执行者时的环境变量名。
 * set 从标准输入读值（终端里不回显），服务只存不显示；任务 `--secret 名称` 声明要用，派活那一刻注入执行者。
 * 清理只归档不删（archive / restore / keep），真删（rm）只有用户。
 */

const str = (values: Values, key: string) => {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
};
const client = async () => (await import("./service.ts")).connect();

type Secret = {
  node: string;
  node_name: string | null;
  name: string;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  last_used_at: number | null;
  last_used_task: string | null;
  archived: boolean;
  archived_at: number | null;
  archive_note: string | null;
  keep_at: number | null;
  keep_note: string | null;
  stale: string | null;
};

const who = (by: string) => (by === "secretary" ? "秘书" : by);

/** 管道或重定向：整段读完（多读一点就够判超限）。 */
async function readPiped(stdin: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > SECRET_VALUE_MAX + 4) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 终端里：关掉回显逐字收，回车结束，Ctrl-C 放弃。值不进 shell 历史。 */
function readHidden(stdin: NodeJS.ReadStream, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stderr.write(prompt);
    const done = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(text);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003" || char === "\u0004")
          return done(new Problem(400, "已取消，没有保存", "usage"));
        if (char === "\u007f" || char === "\b")
          text = Array.from(text).slice(0, -1).join("");
        else text += char;
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function readSecretInput(
  name: string,
  stdin: NodeJS.ReadStream = process.stdin,
) {
  const raw = stdin.isTTY
    ? await readHidden(stdin, `输入 ${name} 的值（不回显），回车结束：`)
    : await readPiped(stdin);
  // 报错不带值。
  return secretValue(raw);
}

function secretLines(list: Secret[]) {
  if (!list.length) return "（没有）";
  return table([
    ["名称", "节点", "设于", "最近使用", "线索"],
    ...list.map((s) => [
      s.name,
      s.node,
      `${when(s.updated_at)} ${who(s.updated_by)}`,
      s.last_used_at
        ? `${when(s.last_used_at)}${s.last_used_task ? ` ${s.last_used_task}` : ""}`
        : "没用过",
      s.archived
        ? `已归档${s.archive_note ? `：${oneLine(s.archive_note, 30)}` : ""}`
        : s.keep_at
          ? `留下：${oneLine(s.keep_note ?? "", 30)}`
          : (s.stale ?? ""),
    ]),
  ]);
}

const target = (node: string, name: string) => ({ node, name });

export const secretCommands: Record<string, Command> = {
  "secret set": {
    args: "节点 名称",
    about:
      "设凭据（令牌、密码）：值从标准输入读（终端里不回显；也可 < 文件 或管道），名称就是注入执行者的环境变量名（如 TELEGRAM_BOT_TOKEN）；同一节点同名的覆盖，已归档的顺带恢复；只存不显示",
    positionals: [2, 2],
    async run({ positionals: [node, name], json }) {
      const value = await readSecretInput(name!);
      const s = await (
        await client()
      ).put<Secret & { created: boolean; restored: boolean }>("/secrets", {
        node,
        name,
        value,
      });
      if (json) printJson(s);
      else
        console.log(
          `${s.created ? "已存" : s.restored ? "已恢复并更新" : "已更新"} ${s.name}（挂在 ${s.node}${s.node_name ? ` ${s.node_name}` : ""}）；值只存不显示`,
        );
      recordNext(
        `派活时用：atrium task add 标题 --part ${s.node} --secret ${s.name}（已有任务：atrium task set tN --secret ${s.name}）`,
      );
    },
  },
  "secret ls": {
    args: "[--node 节点] [--archived] [--before 号] [--limit 条数]",
    about:
      "列凭据（新设的在前）：名称、节点、设于、最近使用（时间与任务）、清理线索；不显示值；缺省不含归档的，--archived 只列归档的",
    options: {
      node: { type: "string" },
      archived: { type: "boolean", default: false },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      const query = new URLSearchParams();
      for (const key of ["node", "before", "limit"])
        if (str(values, key) !== undefined) query.set(key, str(values, key)!);
      if (values.archived === true) query.set("archived", "1");
      const page = await (
        await client()
      ).get<{ secrets: Secret[]; next_before: number | null }>(
        `/secrets${query.size ? `?${query}` : ""}`,
      );
      if (json) printJson(page);
      else console.log(secretLines(page.secrets));
      const stale = page.secrets.find((s) => s.stale && !s.archived);
      recordNext(
        page.next_before
          ? `往下看：atrium secret ls${values.archived === true ? " --archived" : ""}${str(values, "node") ? ` --node ${str(values, "node")}` : ""} --before ${page.next_before}`
          : stale
            ? `用不上就归档：atrium secret archive ${stale.node} ${stale.name} --note 原因；要留：atrium secret keep ${stale.node} ${stale.name} --note 原因`
            : "设一个：atrium secret set 节点 名称（值从标准输入给）",
      );
    },
  },
  "secret archive": {
    args: "节点 名称 [--note 原因]",
    about:
      "归档凭据：派活不再注入（声明了它的任务派不出去）、清理线索也不再提，值留着可恢复（只归档不删）",
    options: { note: { type: "string" } },
    positionals: [2, 2],
    async run({ positionals: [node, name], values, json }) {
      const s = await (
        await client()
      ).post<Secret>("/secrets/archive", {
        ...target(node!, name!),
        ...(str(values, "note") === undefined
          ? {}
          : { note: str(values, "note") }),
      });
      if (json) printJson(s);
      else console.log(`已归档 ${s.node} 的 ${s.name}`);
      recordNext(`恢复：atrium secret restore ${s.node} ${s.name}`);
    },
  },
  "secret restore": {
    args: "节点 名称 [--note 原因]",
    about: "恢复归档的凭据，派活时重新注入",
    options: { note: { type: "string" } },
    positionals: [2, 2],
    async run({ positionals: [node, name], values, json }) {
      const s = await (
        await client()
      ).post<Secret>("/secrets/restore", {
        ...target(node!, name!),
        ...(str(values, "note") === undefined
          ? {}
          : { note: str(values, "note") }),
      });
      if (json) printJson(s);
      else console.log(`已恢复 ${s.node} 的 ${s.name}`);
      recordNext(`看：atrium secret ls --node ${s.node}`);
    },
  },
  "secret keep": {
    args: "节点 名称 --note 原因",
    about:
      "清理线索说疑似没用（90 天没用过）、但决定留下：写一句原因，之后清理线索不再提它",
    options: { note: { type: "string" } },
    positionals: [2, 2],
    async run({ positionals: [node, name], values, json }) {
      if (str(values, "note") === undefined)
        throw new Problem(400, "--note: 留下要写一句原因", "usage");
      const s = await (
        await client()
      ).post<Secret>("/secrets/keep", {
        ...target(node!, name!),
        note: str(values, "note"),
      });
      if (json) printJson(s);
      else console.log(`留下 ${s.node} 的 ${s.name}：${s.keep_note}`);
      recordNext(`看其余的：atrium secret ls --node ${s.node}`);
    },
  },
  "secret rm": {
    args: "节点 名称",
    about:
      "真删凭据（记录与值一起删，找不回来）；只有用户能删，平时用不上就 archive",
    positionals: [2, 2],
    async run({ positionals: [node, name], json }) {
      const s = await (
        await client()
      ).delete<Secret>("/secrets", target(node!, name!));
      if (json) printJson(s);
      else console.log(`已删除 ${s.node} 的 ${s.name}`);
    },
  },
};
