import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPresence } from "../web/components/AgentAvatar.tsx";

test("忙碌优先于在线；未连接为离线", () => {
  assert.equal(
    agentPresence({ available: true, runtime: { busy: true } }),
    "busy",
  );
  assert.equal(
    agentPresence({ available: true, runtime: { busy: false } }),
    "online",
  );
  assert.equal(agentPresence({ available: true, runtime: null }), "online");
  assert.equal(agentPresence({ available: false, runtime: null }), "offline");
  assert.equal(agentPresence(undefined), "offline");
});

test("重试后已开始新回合：进程不忙也是干活", () => {
  assert.equal(
    agentPresence({ available: true, runtime: { busy: false }, working: true }),
    "busy",
  );
  assert.equal(
    agentPresence({ available: true, runtime: null, working: true }),
    "busy",
  );
  assert.equal(
    agentPresence({ available: true, runtime: { busy: false } }),
    "online",
    "旧服务端没有 working 字段时行为不变",
  );
});
