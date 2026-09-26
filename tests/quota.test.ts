import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatQuotaTable } from "../cli/quota.ts";
import { commands, help } from "../cli/main.ts";
import { guide } from "../cli/guide.ts";
import { failure } from "../cli/contract.ts";
import { createApp } from "../server/app.ts";
import { Problem } from "../server/problem.ts";
import {
  listQuota,
  parseQuotaAccounts,
  sortBySpare,
  type QuotaAccount,
} from "../server/tasks/quota.ts";
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

function account(partial: Partial<QuotaAccount> & { providerId: string }) {
  return {
    usedPercent: null,
    periodElapsedPercent: null,
    sparePercent: null,
    hoursToReset: null,
    shortWindowUsedPercent: null,
    refreshedAt: null,
    runtime: null,
    ...partial,
  };
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
    parsed.every((row) => row.runtime === null),
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

test("listQuota：假 pace 按富余降序，runtime 为空", async () => {
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

test("文本表：中文表头、按传入顺序、运行时记录为空", () => {
  const text = formatQuotaTable([
    account({ providerId: "opencode", sparePercent: 59.7, usedPercent: 22 }),
    account({ providerId: "copilot" }),
  ]);
  assert.match(
    text,
    /^账号\s+已用%\s+周期进度%\s+富余%\s+距重置（小时）\s+短窗已用%\s+刷新时间\s+运行时记录$/m,
  );
  const lines = text.split("\n");
  assert.match(lines[1]!, /^opencode\s+22\s+59\.7\s*$/);
  assert.match(lines[2]!, /^copilot\s*$/);
  assert.equal(formatQuotaTable([]), "没有账号额度数据");
});

test("HTTP GET /api/quota：认证、假 pace、缺失 OpenQuota", async (t) => {
  const data = mkdtempSync(join(tmpdir(), "atrium-quota-http-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const guarded = await createApp({
    data: join(data, "guarded"),
    runtime: false,
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
  const { app } = await createApp({
    data,
    runtime: false,
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
  } finally {
    await app.close();
  }

  const missing = await createApp({
    data: join(data, "missing"),
    runtime: false,
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
