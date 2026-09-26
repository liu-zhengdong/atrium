// Runs inside exactly one identity's network namespace. It has no Web URL or credentials.
import http from "node:http";

const MAX_BODY = 2 * 1024 * 1024;
const PORT = 19671;
let serial = 0;
const pending = new Map();
const respond = (reply, status, text) => {
  if (reply.destroyed) return;
  reply.writeHead(status, { "content-type": "text/plain" }).end(text);
};
const server = http.createServer(async (request, reply) => {
  if (request.url !== "/mcp" || request.method !== "POST")
    return respond(reply, 404, "not found");
  if (pending.size >= 8) return respond(reply, 429, "MCP bridge busy");
  let chunks = [],
    length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) return respond(reply, 413, "too large");
    chunks.push(chunk);
  }
  const id = ++serial;
  const timer = setTimeout(() => {
    pending.delete(id);
    respond(reply, 504, "MCP bridge timeout");
  }, 45_000);
  pending.set(id, { reply, timer });
  process.stdout.write(
    JSON.stringify({
      id,
      body: Buffer.concat(chunks).toString("base64"),
      accept: request.headers.accept ?? "application/json, text/event-stream",
      protocol: request.headers["mcp-protocol-version"] ?? "",
    }) + "\n",
  );
});
server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.maxConnections = 16;
server.keepAliveTimeout = 1000;
let line = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  line += chunk;
  if (line.length > 4 * 1024 * 1024) process.exit(2);
  for (let newline; (newline = line.indexOf("\n")) >= 0;) {
    const raw = line.slice(0, newline);
    line = line.slice(newline + 1);
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      process.exit(2);
    }
    const entry = pending.get(frame.id);
    if (!entry) continue;
    clearTimeout(entry.timer);
    pending.delete(frame.id);
    if (!entry.reply.destroyed) {
      const body = Buffer.from(frame.body ?? "", "base64");
      entry.reply
        .writeHead(frame.status ?? 502, {
          "content-type": frame.contentType ?? "application/json",
          ...(frame.sessionId ? { "mcp-session-id": frame.sessionId } : {}),
        })
        .end(body);
    }
  }
});
process.stdin.on("end", () => server.close());
server.listen(PORT, "127.0.0.1", () =>
  process.stdout.write('{"ready":true}\n'),
);
