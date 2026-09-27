import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { formatQuotaTable } from "../cli/quota.ts";
import { commands, help } from "../cli/main.ts";
import { guide } from "../cli/guide.ts";
import { failure } from "../cli/contract.ts";
import { createApp } from "../server/app.ts";
import { Problem } from "../server/problem.ts";
import {
  holdRuntime,
  holdRuntimes,
  listQuota,
  parseQuotaAccounts,
  sortBySpare,
  type QuotaAccount,
} from "../server/tasks/quota.ts";
import {
  clock,
  DEFAULT_UNKNOWN_HOLD_MS,
  ensureQuotaHoldTable,
  placeHold,
  quotaReason,
  releaseHold,
  type QuotaHold,
} from "../server/tasks/quota-holds.ts";
import {
  readOpenquotaPace,
  resolveOpenquotaBin,
  OPENQUOTA_BIN,
} from "../server/tasks/openquota.ts";

const SAMPLE = [
  {
    providerId: "codex",
    usedPercent: 14,
    periodElapsedPercent: 8.4,
    sparePercent: -5.6,
    hoursToReset: 153.9,
    shortWindowUsedPercent: null,
    refreshedAt: "2026-09-26T17:07:58Z",
  },
  {
    providerId: "opencode",
    usedPercent: 22,
    periodElapsedPercent: 81.7,
    sparePercent: 59.7,
    hoursToReset: 30.8,
    shortWindowUsedPercent: 0,
    refreshedAt: "2026-09-26T17:07:59Z",
  },
  {
    providerId: "copilot",
    usedPercent: null,
    periodElapsedPercent: null,
    sparePercent: null,
    hoursToReset: null,
    shortWindowUsedPercent: null,
    refreshedAt: "2026-09-23T07:55:30Z",
  },
  {
    providerId: "claude",
    usedPercent: 9,
    periodElapsedPercent: 63.2,
    sparePercent: 54.2,
    hoursToReset: 61.8,
    shortWindowUsedPercent: 0,
    refreshedAt: "2026-09-26T17:07:58Z",
  },
];

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "atrium-quota-"));
  return {
    dir,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeBin(dir: string, source: string) {
  const bin = join(dir, "openquota");
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  return bin;
}

function paceScript(payload: unknown) {
  return `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`;
}

const NOW = Date.now();
const HOUR = 3_600_000;

function account(partial: Partial<QuotaAccount> & { providerId: string }) {
  return {
    usedPercent: null,
    periodElapsedPercent: null,
    sparePercent: null,
    hoursToReset: null,
    shortWindowUsedPercent: null,
    refreshedAt: null,
    runtime: null,
    hold: null,
    ...partial,
  };
}

/** 内存库：额度标记表 + 现在时刻，方便按账号放标记。 */
function holdDb() {
  const db = new DatabaseSync(":memory:");
  ensureQuotaHoldTable(db);
  return db;
}

test("命令表、帮助与说明书收录 atrium quota", () => {
  assert.equal(commands.quota.args, "[--json]");
  assert.match(commands.quota.about, /额度富余/);
  assert.match(help(), /atrium quota \[--json\]/);
  assert.match(guide(commands), /派活前看额度：atrium quota/);
});

test("parseQuotaAccounts / sortBySpare：沿用字段、富余降序、无数据排最后", () => {
  const parsed = parseQuotaAccounts(
    JSON.stringify([...SAMPLE, 1, { usedPercent: 1 }]),
  );
  assert.deepEqual(
    parsed.map((row) => row.providerId),
    ["codex", "opencode", "copilot", "claude"],
  );
  assert.equal(
    parsed.every((row) => row.runtime === null && row.hold === null),
    true,
  );
  assert.deepEqual(
    sortBySpare(parsed).map((row) => row.providerId),
    ["opencode", "claude", "codex", "copilot"],
  );
  assert.equal(parseQuotaAccounts("[]").length, 0);
  assert.throws(() => parseQuotaAccounts("oops"), /OpenQuota 输出无法解析/);
  assert.throws(() => parseQuotaAccounts("{}"), /OpenQuota 输出无法解析/);
});

test("运行时记录：有未到期标记写预计恢复时刻，--json 字段同源", () => {
  const until = NOW + 2 * HOUR;
  const hold: QuotaHold = {
    provider: "codex",
    until,
    reason: quotaReason("codex", new Date(until)),
    since: NOW - 60_000,
  };
  const runtime = holdRuntime(hold, NOW)!;
  assert.equal(runtime.note, `额度用尽，预计 ${clock(until)} 恢复`);
  assert.match(runtime.note, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} 恢复$/);
  assert.deepEqual(runtime.hold, { until, reason: hold.reason });
  assert.deepEqual(holdRuntime(undefined, NOW), null);
});

test("运行时记录：标记已到期或没有标记都留空", () => {
  assert.equal(
    holdRuntime(
      { provider: "codex", until: NOW, reason: null, since: NOW - HOUR },
      NOW,
    ),
    null,
    "已到期不再挡住派活",
  );
  assert.equal(holdRuntime(undefined, NOW), null, "没有标记");
  assert.deepEqual(
    [
      ...holdRuntimes(
        [
          {
            provider: "codex",
            until: NOW - 1,
            reason: null,
            since: NOW - 2 * HOUR,
          },
        ],
        NOW,
      ),
    ],
    [],
  );
});

test("运行时记录：恢复时间未知时不编时刻，只说未知", () => {
  // 判定依据写着恢复时间未知（报文没给时间），即使兜底到期时刻还在明天。
  const until = NOW + 30 * 60_000;
  const reason = quotaReason("claude", null);
  const runtime = holdRuntime(
    { provider: "claude", until, reason, since: NOW - 30 * 60_000 },
    NOW,
  )!;
  assert.equal(runtime.note, "额度用尽，恢复时间未知");
  assert.deepEqual(runtime.hold, { until, reason });
  // until 为空（手工写入）同样按未知处理，到期时刻按 since + 兜底算。
  const manual = holdRuntime(
    { provider: "kimi", until: null, reason: "手工标记", since: NOW - 60_000 },
    NOW,
  )!;
  assert.equal(manual.note, "额度用尽，恢复时间未知");
  assert.equal(manual.hold.until, NOW - 60_000 + DEFAULT_UNKNOWN_HOLD_MS);
  assert.equal(
    holdRuntime(
      {
        provider: "kimi",
        until: null,
        reason: "手工标记",
        since: NOW - 2 * HOUR,
      },
      NOW,
    ),
    null,
    "按 since + 兜底已过期",
  );
});

test("resolveOpenquotaBin：显式路径优先于环境变量", () => {
  assert.equal(resolveOpenquotaBin(), OPENQUOTA_BIN);
  assert.equal(
    resolveOpenquotaBin(undefined, { ATRIUM_OPENQUOTA_BIN: "/tmp/fake" }),
    "/tmp/fake",
  );
  assert.equal(
    resolveOpenquotaBin("/explicit", { ATRIUM_OPENQUOTA_BIN: "/tmp/fake" }),
    "/explicit",
  );
});

test("共享 OpenQuota 读取：校验调用参数并区分缺失、解析和执行失败", async () => {
  const { dir, done } = temp();
  try {
    const bin = fakeBin(
      dir,
      '#!/bin/sh\n[ "$1" = pace ] && [ "$2" = --json ] || exit 3\necho \'[{"providerId":"codex"}]\'\n',
    );
    assert.deepEqual(await readOpenquotaPace({ bin }), {
      ok: true,
      rows: [{ providerId: "codex" }],
    });
    assert.deepEqual(await readOpenquotaPace({ bin: join(dir, "missing") }), {
      missing: true,
    });
    writeFileSync(bin, "#!/bin/sh\necho oops\n");
    assert.deepEqual(await readOpenquotaPace({ bin }), { error: "parse" });
    writeFileSync(bin, "#!/bin/sh\nexit 3\n");
    assert.deepEqual(await readOpenquotaPace({ bin }), { error: "failed" });
  } finally {
    done();
  }
});

test("listQuota：假 pace 按富余降序，没有额度标记时 runtime 为空", async () => {
  const { dir, done } = temp();
  try {
    const bin = fakeBin(dir, paceScript(SAMPLE));
    const result = await listQuota({ bin });
    assert.deepEqual(
      result.accounts.map((row) => [
        row.providerId,
        row.sparePercent,
        row.runtime,
      ]),
      [
        ["opencode", 59.7, null],
        ["claude", 54.2, null],
        ["codex", -5.6, null],
        ["copilot", null, null],
      ],
    );
    assert.equal(result.accounts[0]!.usedPercent, 22);
    assert.equal(result.accounts[0]!.shortWindowUsedPercent, 0);
    assert.equal(result.accounts[0]!.refreshedAt, "2026-09-26T17:07:59Z");
  } finally {
    done();
  }
});

test("listQuota：未到期标记落到对应账号，标记已过期和未标记的账号留空", async () => {
  const { dir, done } = temp();
  const db = holdDb();
  try {
    const bin = fakeBin(dir, paceScript(SAMPLE));
    // codex 未到期（2 小时后恢复）；claude 的标记 1 分钟前就到期了。
    const until = NOW + 2 * HOUR;
    const reason = quotaReason("codex", new Date(until));
    placeHold(db, { provider: "codex", until, reason }, NOW);
    placeHold(
      db,
      { provider: "claude", until: NOW - 60_000, reason: "额度用尽：claude" },
      NOW - 2 * HOUR,
    );
    const result = await listQuota({ bin, db, now: NOW });
    const byProvider = new Map(
      result.accounts.map((row) => [row.providerId, row]),
    );
    assert.equal(
      byProvider.get("codex")!.runtime,
      `额度用尽，预计 ${clock(until)} 恢复`,
    );
    assert.deepEqual(byProvider.get("codex")!.hold, { until, reason });
    assert.equal(byProvider.get("claude")!.runtime, null, "已过期的标记不显示");
    assert.equal(byProvider.get("claude")!.hold, null);
    assert.equal(byProvider.get("opencode")!.runtime, null, "没有标记");
    assert.equal(byProvider.get("opencode")!.hold, null);
    assert.equal(byProvider.get("copilot")!.hold, null);
  } finally {
    db.close();
    done();
  }
});

test("listQuota：按兜底时长配置决定 until 为空的手工标记是否还挡着", async () => {
  const { dir, done } = temp();
  const db = holdDb();
  try {
    const bin = fakeBin(dir, paceScript(SAMPLE));
    // until 只可能来自手工写入：到期时刻按 since + 兜底时长算。
    db.prepare(
      "INSERT INTO quota_holds(provider,until,reason,since) VALUES (?,?,?,?)",
    ).run("codex", null, "手工标记", NOW - 10 * 60_000);
    const short = await listQuota({ bin, db, now: NOW, unknownMs: 5 * 60_000 });
    assert.equal(
      short.accounts.find((row) => row.providerId === "codex")!.runtime,
      null,
      "5 分钟兜底下已过期",
    );
    const long = await listQuota({ bin, db, now: NOW });
    assert.equal(
      long.accounts.find((row) => row.providerId === "codex")!.runtime,
      "额度用尽，恢复时间未知",
    );
    assert.equal(
      long.accounts.find((row) => row.providerId === "codex")!.hold!.until,
      NOW - 10 * 60_000 + DEFAULT_UNKNOWN_HOLD_MS,
    );
  } finally {
    db.close();
    done();
  }
});

test("listQuota：找不到 OpenQuota 时中文提示，不带英文原生错误", async () => {
  await assert.rejects(
    () => listQuota({ bin: join(tmpdir(), "no-such-openquota-atrium") }),
    (error: unknown) => {
      assert.ok(error instanceof Problem);
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, "not_found");
      assert.match(error.message, /未找到 OpenQuota/);
      assert.doesNotMatch(error.message, /ENOENT|no such file/i);
      const cli = failure(error);
      assert.notEqual(cli.exit, 0);
      assert.match(cli.message, /未找到 OpenQuota/);
      return true;
    },
  );
});

test("listQuota：输出无法解析或非 0 退出时中文失败", async () => {
  const { dir, done } = temp();
  try {
    const bin = fakeBin(dir, "#!/bin/sh\necho oops\n");
    await assert.rejects(() => listQuota({ bin }), /OpenQuota 输出无法解析/);
    writeFileSync(bin, "#!/bin/sh\nexit 3\n");
    await assert.rejects(() => listQuota({ bin }), /读取 OpenQuota 额度失败/);
  } finally {
    done();
  }
});

test("listQuota：子进程环境不传凭据", async () => {
  const { dir, done } = temp();
  try {
    const seen = join(dir, "seen.env");
    const bin = fakeBin(dir, `#!/bin/sh\nenv > "${seen}"\necho '[]'\n`);
    await listQuota({
      bin,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        OPENAI_API_KEY: "sk-secret",
        GH_TOKEN: "ghs_secret",
        LANG: "zh_CN.UTF-8",
      },
    });
    const dumped = (await import("node:fs")).readFileSync(seen, "utf8");
    assert.match(dumped, /^HOME=/m);
    assert.doesNotMatch(dumped, /OPENAI_API_KEY|GH_TOKEN|sk-secret|ghs_secret/);
  } finally {
    done();
  }
});

test("文本表：中文表头、按传入顺序、运行时记录列照服务端文案", () => {
  const note = `额度用尽，预计 ${clock(NOW + HOUR)} 恢复`;
  const text = formatQuotaTable([
    account({ providerId: "opencode", sparePercent: 59.7, usedPercent: 22 }),
    account({
      providerId: "codex",
      runtime: note,
      hold: { until: NOW + HOUR, reason: null },
    }),
    account({ providerId: "copilot" }),
  ]);
  assert.match(
    text,
    /^账号\s+已用%\s+周期进度%\s+富余%\s+距重置（小时）\s+短窗已用%\s+刷新时间\s+运行时记录$/m,
  );
  const lines = text.split("\n");
  assert.match(lines[1]!, /^opencode\s+22\s+59\.7\s*$/);
  assert.match(
    lines[2]!,
    /^codex\s+额度用尽，预计 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 恢复$/,
  );
  assert.match(lines[3]!, /^copilot\s*$/);
  assert.equal(formatQuotaTable([]), "没有账号额度数据");
});

test("HTTP GET /api/quota：认证、假 pace、缺失 OpenQuota", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-quota-http-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const guarded = await createApp({
    data: join(data, "guarded"),
  });
  try {
    const denied = await guarded.app.inject({
      url: "/api/quota",
      headers: { host: "127.0.0.1" },
    });
    assert.equal(denied.statusCode, 401);
  } finally {
    await guarded.app.close();
  }

  const { dir, done } = temp();
  t.after(done);
  const bin = fakeBin(dir, paceScript(SAMPLE));
  const { app, db } = await createApp({
    data,

    auth: false,
    quotaBin: bin,
  });
  try {
    const ok = await app.inject({
      url: "/api/quota",
      headers: { host: "127.0.0.1" },
    });
    assert.equal(ok.statusCode, 200);
    const body = ok.json() as { accounts: QuotaAccount[] };
    assert.deepEqual(
      body.accounts.map((row) => row.providerId),
      ["opencode", "claude", "codex", "copilot"],
    );
    assert.equal(body.accounts[0]!.runtime, null);
    assert.equal(body.accounts[0]!.hold, null);
    // 记下未到期标记后，同一个接口把记录挂到对应账号上。
    const until = Date.now() + HOUR;
    const reason = quotaReason("codex", new Date(until));
    placeHold(db, { provider: "codex", until, reason }, Date.now());
    const held = (
      await app.inject({ url: "/api/quota", headers: { host: "127.0.0.1" } })
    ).json() as { accounts: QuotaAccount[] };
    const codex = held.accounts.find((row) => row.providerId === "codex")!;
    assert.equal(codex.runtime, `额度用尽，预计 ${clock(until)} 恢复`);
    assert.deepEqual(codex.hold, { until, reason });
    assert.equal(
      held.accounts.find((row) => row.providerId === "opencode")!.hold,
      null,
    );
    releaseHold(db, "codex", Date.now());
    const released = (
      await app.inject({ url: "/api/quota", headers: { host: "127.0.0.1" } })
    ).json() as { accounts: QuotaAccount[] };
    assert.equal(
      released.accounts.find((row) => row.providerId === "codex")!.runtime,
      `额度用尽，预计 ${clock(until)} 恢复`,
      "标记未到期，运行时也还没解除",
    );
    // 到点的标记不显示；运行时解除后同样不留记录。
    const past = Date.now() - 1000;
    placeHold(
      db,
      {
        provider: "claude",
        until: past,
        reason: quotaReason("claude", new Date(past)),
      },
      Date.now() - HOUR,
    );
    const expired = (
      await app.inject({ url: "/api/quota", headers: { host: "127.0.0.1" } })
    ).json() as { accounts: QuotaAccount[] };
    assert.equal(
      expired.accounts.find((row) => row.providerId === "claude")!.runtime,
      null,
      "已到期的标记不显示",
    );
    assert.equal(releaseHold(db, "claude", Date.now()), true);
    const gone = (
      await app.inject({ url: "/api/quota", headers: { host: "127.0.0.1" } })
    ).json() as { accounts: QuotaAccount[] };
    assert.equal(
      gone.accounts.find((row) => row.providerId === "claude")!.hold,
      null,
      "标记解除后不留记录",
    );
  } finally {
    await app.close();
  }

  const missing = await createApp({
    data: join(data, "missing"),

    auth: false,
    quotaBin: join(dir, "missing-openquota"),
  });
  try {
    const failed = await missing.app.inject({
      url: "/api/quota",
      headers: { host: "127.0.0.1" },
    });
    assert.equal(failed.statusCode, 404);
    assert.match(failed.json().error, /未找到 OpenQuota/);
    assert.doesNotMatch(JSON.stringify(failed.json()), /ENOENT|no such file/i);
  } finally {
    await missing.app.close();
  }
});
