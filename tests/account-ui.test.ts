import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountRow } from "../web/settings/AccountRow.tsx";
import type { Account } from "../web/settings/types.ts";

test("setup-token account renders its own type, entry date and recovery command", () => {
  const account: Account = {
    id: "k7",
    provider: "claude-bridge",
    name: "Claude 独立账号",
    type: "setup_token",
    status: "error",
    expires: null,
    credential_updated_at: new Date("2026-09-25T12:00:00.000Z").getTime(),
    last_error: "令牌失效",
    assigned: [],
  };
  const html = renderToStaticMarkup(
    createElement(AccountRow, {
      account,
      accounts: [account],
      agents: [],
      focused: false,
      change: async (task) => task(),
      openAgent: () => {},
      relogin: () => {},
    }),
  );
  assert.match(html, /Claude 令牌/);
  assert.match(html, /2026.*9.*25.*录入/);
  assert.match(html, /atrium account replace-token k7 --setup-token -/);
  assert.doesNotMatch(html, /API Key/);
});
