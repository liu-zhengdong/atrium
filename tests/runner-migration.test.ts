import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateRunner } from "../cli/runner-migration.ts";
import type { Client } from "../cli/service.ts";
import { Problem } from "../server/problem.ts";

test("one-time migration waits visibly with a limit, hands off identities separately and leaves failures alone", async () => {
  const agents = [
    {
      id: "a1",
      ref: "a1",
      name: "忙碌",
      runner: null,
      running: true,
      runtime: { busy: true },
    },
    {
      id: "a2",
      ref: "a2",
      name: "已就绪",
      runner: null,
      running: true,
      runtime: { busy: false },
    },
    {
      id: "a3",
      ref: "a3",
      name: "坏身份",
      runner: null,
      running: false,
      runtime: null,
    },
  ];
  const actions: string[] = [];
  const client = {
    get: async () => ({ agents: agents.map((a) => ({ ...a })) }),
    post: async (path: string) => {
      actions.push(path);
      if (path.includes("/a3/")) throw new Problem(503, "本身份失败");
      return {};
    },
    put: async (path: string) => {
      actions.push(path);
      const agent = agents.find((a) => path.includes(`/${a.id}/`))!;
      agent.runner = { id: "r1" } as never;
      agent.running = false;
      return {};
    },
  } as unknown as Client;
  const lines: string[] = [];
  const result = await migrateRunner(client, "r1", 0.02, (line) =>
    lines.push(line),
  );
  assert.deepEqual(result.migrated, ["a2"]);
  assert.deepEqual(result.skipped, ["a1"]);
  assert.match(result.failed[0]!, /a3.*本身份失败/);
  assert(lines.some((line) => line.includes("仍在等待：a1 忙碌")));
  assert(
    lines.some((line) => line.includes("下次") || line.includes("稍后运行")),
  );
  assert(actions.includes("/agents/a2/start"));
  assert(!actions.some((path) => path.includes("/agents/a1/start")));
});

test("terminal identity reports the actual 409 once instead of waiting until the deadline", async () => {
  const started = Date.now();
  const result = await migrateRunner(
    {
      get: async () => ({
        agents: [
          {
            id: "a1",
            ref: "a1",
            name: "终端",
            runner: null,
            running: false,
            runtime: null,
          },
        ],
      }),
      post: async () => {
        throw new Problem(409, "终端身份不由服务管理");
      },
    } as unknown as Client,
    "r1",
    3,
    () => undefined,
  );
  assert.deepEqual(result.skipped, []);
  assert.match(result.failed[0]!, /a1：终端身份不由服务管理/);
  assert(Date.now() - started < 1000);
});

test("one identity's failed start does not restart the old writer or block a sleeping identity", async () => {
  const agents = [
    {
      id: "a1",
      ref: "a1",
      name: "启动失败",
      runner: null,
      running: true,
      runtime: { busy: false },
    },
    {
      id: "a2",
      ref: "a2",
      name: "原先休眠",
      runner: null,
      running: false,
      runtime: null,
    },
  ];
  const actions: string[] = [];
  const client = {
    get: async () => ({ agents: agents.map((a) => ({ ...a })) }),
    post: async (path: string) => {
      actions.push(path);
      if (path === "/agents/a1/start") throw new Problem(503, "启动失败");
      return {};
    },
    put: async (path: string) => {
      actions.push(path);
      const agent = agents.find((a) => path.includes(`/${a.id}/`))!;
      agent.runner = { id: "r1" } as never;
      return {};
    },
  } as unknown as Client;
  const result = await migrateRunner(client, "r1", 1, () => undefined);
  assert.deepEqual(result.migrated, ["a2"]);
  assert.match(result.failed[0]!, /已交接但启动失败/);
  assert(!actions.includes("/agents/a2/start"));
  assert(!actions.some((path) => path.includes("unbind")));
});
