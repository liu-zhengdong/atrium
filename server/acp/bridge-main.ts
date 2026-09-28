import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { AcpBridge, inputMessage } from "./bridge.ts";
import { AcpConnection } from "./client.ts";

/**
 * ACP 执行者的桥进程入口（#418）：由 adapters/acp.ts 算出的调用拉起，
 * `node <本文件> --tool <名字> --input stream-json|text --permissions allow|reject [--model m] [--effort e] [--resume 会话] -- <工具命令> <参数…>`。
 * 标准输入：stream-json 为逐行用户消息（运行中可继续写捎话），text 为整份提示词；标准输出写日志事件（stream.ts）。
 * 工具不开独立进程组，与桥同属一棵进程树，运行时结束桥时一起结束；工具的标准错误原样转进日志。
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tool: { type: "string" },
    input: { type: "string", default: "text" },
    permissions: { type: "string", default: "allow" },
    model: { type: "string" },
    effort: { type: "string" },
    resume: { type: "string" },
  },
});

const [command, ...args] = positionals;
if (!command || !values.tool) {
  process.stderr.write(
    "用法：acp-bridge --tool <名字> -- <工具命令> <参数…>\n",
  );
  process.exit(2);
}

const bridge = new AcpBridge({
  tool: values.tool,
  cwd: process.cwd(),
  permissions: values.permissions === "reject" ? "reject" : "allow",
  ...(values.model ? { model: values.model } : {}),
  ...(values.effort ? { effort: values.effort } : {}),
  ...(values.resume ? { resume: values.resume } : {}),
  write: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

const connection = new AcpConnection(
  command,
  args,
  { cwd: process.cwd(), env: process.env, detached: false },
  {
    ...bridge.handlers,
    stderr: (chunk) => process.stderr.write(chunk),
  },
);

const stop = () => {
  connection.close();
  process.exit(143);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

if (values.input === "stream-json") {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = inputMessage(line);
    if (message) bridge.push(message);
  });
  lines.on("close", () => bridge.end());
} else {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => (text += chunk));
  process.stdin.on("end", () => {
    if (text.trim()) bridge.push({ text });
    bridge.end();
  });
}

const code = await bridge.run(connection);
connection.close();
// 标准输出接管道时写入可能是异步的：写完再退。
process.stdout.write("", () => process.exit(code));
