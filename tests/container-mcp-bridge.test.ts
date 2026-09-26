import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ContainerMcpBridge,
  sameContainerMcpOwner,
} from "../server/container-mcp-bridge.ts";

function nextFrame(stream: PassThrough) {
  return Promise.race([
    once(stream, "data"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("bridge reply timeout")), 2000).unref(),
    ),
  ]);
}

class FakeExec extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    this.emit("close", 0);
    return true;
  }
}

test("MCP 帧只在身份、容器、代际仍归属时转发；换代后的旧帧不抵达 Web", async () => {
  const bound = {
    agentId: "a1",
    generation: "gen-1",
    containerId: "container-1",
  };
  let current = { ...bound };
  let hostCalls = 0;
  const web = createServer(async (request, response) => {
    for await (const _ of request) {
      /* consume JSON-RPC */
    }
    hostCalls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  const fake = new FakeExec();
  const bridge = new ContainerMcpBridge(
    bound.containerId,
    `http://127.0.0.1:${(web.address() as { port: number }).port}/private-capability`,
    () => sameContainerMcpOwner(bound, current),
    () => {
      queueMicrotask(() => fake.stdout.write('{"ready":true}\n'));
      return fake as unknown as ChildProcessWithoutNullStreams;
    },
  );
  try {
    await bridge.start();
    const request = (id: number) =>
      JSON.stringify({
        id,
        body: Buffer.from(
          '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        ).toString("base64"),
        accept: "application/json",
        protocol: "2025-06-18",
      }) + "\n";
    const reply = nextFrame(fake.stdin);
    fake.stdout.write(request(1));
    const first = JSON.parse((await reply)[0].toString());
    assert.equal(first.status, 200);
    assert.equal(hostCalls, 1);
    current = { ...bound, generation: "gen-2" };
    const staleReply = nextFrame(fake.stdin);
    fake.stdout.write(request(2));
    const stale = JSON.parse((await staleReply)[0].toString());
    assert.equal(stale.status, 403);
    assert.equal(hostCalls, 1);
    assert.equal(await bridge.drain(), true);
  } finally {
    bridge.close();
    await new Promise((resolve) => web.close(resolve));
  }
});
