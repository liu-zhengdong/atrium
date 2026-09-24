import { createServer, request, type Server } from "node:http";

/** Separate bridge listener; the main Web/CLI service stays bound to loopback. */
export async function listenContainerMcp(localPort: number): Promise<Server> {
  const bridgePort = localPort + 1;
  const server = createServer((incoming, outgoing) => {
    if (
      incoming.method !== "POST" ||
      !/^\/mcp\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
        incoming.url ?? "",
      ) ||
      incoming.headers.host !== `host.docker.internal:${bridgePort}` ||
      incoming.headers.origin
    ) {
      outgoing.writeHead(403).end("仅允许容器通过 MCP 访问");
      return;
    }
    // No path or method selected by the caller is forwarded to management.
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: localPort,
        method: "POST",
        path: incoming.url,
        headers: { ...incoming.headers, host: `localhost:${localPort}` },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bridgePort, "0.0.0.0", resolve);
  });
  return server;
}
