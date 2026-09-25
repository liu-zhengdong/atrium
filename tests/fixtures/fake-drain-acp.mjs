import { createInterface } from "node:readline";

const identities = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
];
const generation = "00000000-0000-4000-8000-000000000003";
const sessionId = "00000000-0000-4000-8000-000000000004";
const runtimes = identities.map((identityId) => ({
  identityId,
  runtimeId: identityId,
  generation,
  sessionId,
  pid: process.pid,
  mode: "rpc",
  cwd: process.cwd(),
}));
const busy = new Set();
let deliveries = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id == null) continue;
  let result;
  if (method === "initialize")
    result = {
      protocolVersion: params.protocolVersion,
      agentInfo: { name: "fake-drain-acp", version: "1" },
      _meta: { "pi-acp/runtime/v1": true, "pi-acp/identity/v1": true },
    };
  else if (method === "_pi/runtime/list") result = { runtimes };
  else if (method === "_pi/runtime/status") {
    const runtime = runtimes.find(
      (item) => item.runtimeId === params.runtimeId,
    );
    result = {
      ...runtime,
      ownerPid: null,
      sessionFile: null,
      busy: busy.has(runtime.runtimeId),
      model: "fake/test",
    };
  } else if (method === "_pi/runtime/events")
    result = {
      runtimeId: params.runtimeId,
      generation,
      sessionId,
      items: [],
      nextAfter: params.after,
      hasMore: false,
      gap: false,
    };
  else if (method === "_pi/runtime/deliver") {
    deliveries++;
    busy.add(params.runtimeId);
    setTimeout(() => busy.delete(params.runtimeId), 1000);
    result = { deliveries };
  } else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
