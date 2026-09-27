// 假 opencode serve：只听 127.0.0.1 随机端口，启动后打印与真 opencode 相同的地址行。
// 要求 basic 认证（opencode:$OPENCODE_SERVER_PASSWORD）。prompt_async 立即返回，稍后才转 busy，
// 一轮 150 毫秒（消息含 SLOW 时 600 毫秒）；忙时收到的消息排在本轮之后。
// /fake/state 返回消息、提示与拉起环境里的 XDG_DATA_HOME、HERDR_* 键，/fake/user 模拟用户在界面里发话。
import { createServer } from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const sessions = new Map();
const toasts = [];
let busy = null;
const queue = [];
let clock = 0;
const now = () => Math.max(Date.now(), ++clock);

function add(session, role, text) {
  const message = {
    info: {
      id: `msg_${now()}`,
      role,
      sessionID: session.id,
      time: { created: now() },
    },
    parts: [{ type: "text", text }],
  };
  session.messages.push(message);
  return message;
}

// 空闲时新一轮 60 毫秒后才转 busy；忙时排队的消息接着跑，中间不回 idle（与真 opencode 相同）。
let starting = false;
function pump() {
  if (busy || starting || !queue.length) return;
  starting = true;
  setTimeout(run, 60);
}
function run() {
  starting = false;
  const { session, text } = queue.shift();
  busy = session.id;
  setTimeout(
    () => {
      add(session, "assistant", `收到：${text.split("\n", 1)[0]}`);
      if (queue.length) return run();
      busy = null;
    },
    text.includes("SLOW") ? 600 : 150,
  );
}

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(value === undefined ? "" : JSON.stringify(value));
};

createServer(async (request, response) => {
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  if (password && request.headers.authorization !== expected)
    return json(response, 401, { error: "unauthorized" });
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = body ? JSON.parse(body) : {};
  const url = new URL(request.url, "http://x");
  const path = url.pathname;
  const directory = url.searchParams.get("directory");
  if (!directory) return json(response, 400, { error: "directory" });
  let match;
  if (request.method === "POST" && path === "/session") {
    const session = {
      id: `ses_${sessions.size + 1}`,
      directory,
      title: input.title,
      messages: [],
    };
    sessions.set(session.id, session);
    return json(response, 200, { id: session.id, title: session.title });
  }
  if (request.method === "GET" && path === "/session/status")
    return json(response, 200, busy ? { [busy]: { type: "busy" } } : {});
  if ((match = /^\/session\/([^/]+)$/.exec(path))) {
    const session = sessions.get(match[1]);
    return session
      ? json(response, 200, { id: session.id })
      : json(response, 404, { error: "not found" });
  }
  if ((match = /^\/session\/([^/]+)\/prompt_async$/.exec(path))) {
    const session = sessions.get(match[1]);
    if (!session) return json(response, 404, { error: "not found" });
    const text = input.parts.map((part) => part.text ?? "").join("");
    add(session, "user", text);
    queue.push({ session, text });
    pump();
    response.writeHead(204).end();
    return;
  }
  if ((match = /^\/session\/([^/]+)\/message$/.exec(path))) {
    const session = sessions.get(match[1]);
    if (!session) return json(response, 404, { error: "not found" });
    const limit = Number(url.searchParams.get("limit") ?? 0);
    return json(
      response,
      200,
      limit ? session.messages.slice(-limit) : session.messages,
    );
  }
  if (path === "/tui/show-toast") {
    toasts.push(input.message);
    return json(response, 200, true);
  }
  if (path === "/fake/user") {
    const session = sessions.get(input.session);
    add(session, "user", input.text);
    queue.push({ session, text: input.text });
    pump();
    return json(response, 200, true);
  }
  if (path === "/fake/state")
    return json(response, 200, {
      sessions: [...sessions.values()],
      toasts,
      env: {
        xdg: process.env.XDG_DATA_HOME,
        herdr: Object.keys(process.env).filter((key) =>
          key.startsWith("HERDR_"),
        ),
      },
    });
  json(response, 404, { error: path });
}).listen(0, "127.0.0.1", function () {
  process.stdout.write(
    `opencode server listening on http://127.0.0.1:${this.address().port}\n`,
  );
});
