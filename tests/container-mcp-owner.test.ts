import { test } from "node:test";
import assert from "node:assert/strict";
import { sameContainerMcpOwner } from "../server/container-mcp-bridge.ts";

test("旧代际、旧容器和其他身份的 MCP 流不能被当作当前授权", () => {
  const bound = {
    agentId: "a1",
    generation: "gen-1",
    containerId: "container-1",
  };
  assert.equal(sameContainerMcpOwner(bound, { ...bound }), true);
  assert.equal(
    sameContainerMcpOwner(bound, { ...bound, generation: "gen-2" }),
    false,
  );
  assert.equal(
    sameContainerMcpOwner(bound, { ...bound, containerId: "container-2" }),
    false,
  );
  assert.equal(
    sameContainerMcpOwner(bound, { ...bound, agentId: "a2" }),
    false,
  );
  assert.equal(sameContainerMcpOwner(bound, null), false);
});
