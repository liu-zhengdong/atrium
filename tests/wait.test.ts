import { test } from "node:test";
import assert from "node:assert/strict";
import { Problem } from "../server/problem.ts";
import { reconnectingWait } from "../cli/wait-options.ts";

test("等待断连后带着响应头给的游标重连；耗尽时给续等命令", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const calls: (number | undefined)[] = [];
  const result = await reconnectingWait({
    seconds: 5,
    request: async (_timeout, cursor, observe) => {
      calls.push(cursor);
      if (calls.length === 1) {
        observe(7);
        throw new Problem(503, "断开", "service_unavailable");
      }
      if (calls.length === 2) return { restarting: true, cursor: 9 };
      return { restarting: false, cursor: undefined };
    },
    restarting: (r) => r.restarting,
    nextCursor: (r) => r.cursor,
    resume: (cursor) => `atrium events wait --after ${cursor}`,
  });
  assert.equal(result.restarting, false);
  assert.deepEqual(calls, [undefined, 7, 9]);
  await assert.rejects(
    reconnectingWait({
      seconds: 0,
      cursor: 3,
      request: async () => ({}),
      restarting: () => false,
      resume: (cursor) => `atrium events wait --after ${cursor}`,
    }),
    (error: unknown) =>
      error instanceof Problem &&
      error.code === "service_unavailable" &&
      error.nextCommand === "atrium events wait --after 3",
  );
  await assert.rejects(
    reconnectingWait({
      seconds: 5,
      request: async () => {
        throw new Problem(400, "参数错");
      },
      restarting: () => false,
      resume: () => "",
    }),
    /参数错/,
  );
});
