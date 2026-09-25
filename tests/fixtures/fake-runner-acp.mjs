import { createInterface } from "node:readline";

const runtimeId = "00000000-0000-4000-8000-000000000001";
const generation = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const started = Date.now();
let startCalls = 0;
const runtime = {
  runtimeId,
  generation,
  sessionId,
  identityId: null,
  pid: process.pid,
  mode: "rpc",
  cwd: process.cwd(),
};

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined || request.id === null) continue;
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: request.params.protocolVersion,
          agentInfo: { name: "fake-acp", version: "1" },
          _meta: {
            "pi-acp/runtime/v1": true,
            "pi-acp/identity/v1": true,
            ...(process.env.TEST_LAUNCH_SECRET_CAPABLE === "1"
              ? { "pi-acp/identity/launch-secret-file/v1": true }
              : {}),
          },
        }
      : request.method === "_pi/identity/start"
        ? (() => {
            startCalls++;
            return { received: request.params };
          })()
        : request.method === "_pi/runtime/list"
          ? { pid: process.pid, runtimes: [runtime], startCalls }
          : request.method === "_pi/runtime/events"
            ? (() => {
                const after = request.params.after ?? 0;
                const all = Array.from(
                  {
                    length: Math.min(
                      30,
                      Math.floor((Date.now() - started) / 100),
                    ),
                  },
                  (_, index) => ({
                    seq: index + 1,
                    at: started + (index + 1) * 100,
                    kind:
                      index === 0
                        ? "run_start"
                        : index === 19
                          ? "run_end"
                          : "message",
                    text: `event-${index + 1}`,
                  }),
                );
                const items = all
                  .filter((event) => event.seq > after)
                  .slice(0, request.params.limit ?? 100);
                return {
                  runtimeId,
                  generation,
                  sessionId,
                  items,
                  nextAfter: items.at(-1)?.seq ?? after,
                  hasMore: all.some(
                    (event) => event.seq > (items.at(-1)?.seq ?? after),
                  ),
                  gap: false,
                };
              })()
            : {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
}
