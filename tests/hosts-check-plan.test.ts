import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkBaseline,
  checkRefusal,
  checkRoleText,
  chooseCheckHost,
  LOCAL_MARGIN,
  type CheckCandidate,
} from "../server/hosts/check-plan.ts";
import { commandRefusal, sourceRefusal } from "../server/agent/plan.ts";
import {
  MAX_BUNDLE_BYTES,
  type CheckSource,
} from "../server/hosts/protocol.ts";
import { mergeHostReadings } from "../server/quota-readers/merge.ts";
import type { ReaderOutcome } from "../server/quota-readers/index.ts";
import { accountKey } from "../server/quota-readers/credentials.ts";
import { claudeAccount } from "../server/quota-readers/claude.ts";
import { parseCodexLogin } from "../server/quota-readers/codex.ts";
import { claudeAccountFile } from "../server/quota-readers/paths.ts";
import { usableByProvider } from "../server/tasks/quota-source.ts";
import { holderOf, type HolderFacts } from "../server/tasks/holder.ts";

/** 远程执行者第 2 步（#358）：检查派到哪台、代理照不照做、额度按账号合并、看板文案。纯函数穷举。 */

const local = (over: Partial<CheckCandidate> = {}): CheckCandidate => ({
  id: 1,
  kind: "local",
  connection: "local",
  paused: false,
  platform: "darwin",
  repos: ["*"],
  cpus: 8,
  load: 0,
  running: 0,
  max: 2,
  busy: null,
  ...over,
});
const remote = (
  id: number,
  over: Partial<CheckCandidate> = {},
): CheckCandidate => ({
  id,
  kind: "remote",
  connection: "online",
  paused: false,
  platform: "darwin",
  repos: ["*"],
  cpus: 4,
  load: 0,
  running: 0,
  max: 1,
  busy: null,
  ...over,
});
const need = { repo: "o/r", urgent: false, platform: "darwin" };

test("检查派到哪台：本机不比远程忙太多就在本机；本机忙或满去最空的远程；远程都接不了回本机", () => {
  // 只有本机：本机。
  assert.deepEqual(chooseCheckHost([local()], need), {
    host: 1,
    kind: "local",
  });
  // 两边都闲：本机（省掉传提交、装依赖）。
  assert.deepEqual(chooseCheckHost([local(), remote(2)], need), {
    host: 1,
    kind: "local",
  });
  // 本机每核负载比远程高出 LOCAL_MARGIN 以上：去远程。
  const busyLocal = local({ load: 8 * (LOCAL_MARGIN + 0.1) });
  assert.deepEqual(chooseCheckHost([busyLocal, remote(2)], need), {
    host: 2,
    kind: "remote",
  });
  // 本机 175 负载（t147 的真实场景）、两台远程：挑每核负载 + 检查占用最低的。
  const overloaded = local({ load: 175 });
  assert.deepEqual(
    chooseCheckHost(
      [overloaded, remote(2, { load: 3, cpus: 4 }), remote(3, { load: 1 })],
      need,
    ),
    { host: 3, kind: "remote" },
  );
  // 本机检查满了（在跑 + 排队 ≥ 上限）或自己说太忙：去远程。
  assert.equal(
    chooseCheckHost([local({ running: 2 }), remote(2)], need).kind,
    "remote",
  );
  assert.equal(
    chooseCheckHost([local({ busy: "本机太忙" }), remote(2)], need).kind,
    "remote",
  );
  // 本机暂停接活：不优先，但远程都接不了时检查仍回本机。
  assert.equal(
    chooseCheckHost([local({ paused: true }), remote(2)], need).kind,
    "remote",
  );
  assert.deepEqual(
    chooseCheckHost(
      [local({ paused: true }), remote(2, { connection: "offline" })],
      need,
    ),
    { host: 1, kind: "local" },
  );
  // 试过的远程不再挑：换另一台，再不行回本机。
  assert.deepEqual(
    chooseCheckHost([overloaded, remote(2), remote(3)], need, new Set([2])),
    { host: 3, kind: "remote" },
  );
  assert.deepEqual(
    chooseCheckHost([overloaded, remote(2)], need, new Set([2])),
    { host: 1, kind: "local" },
  );
  // 紧急（t215）：本机能跑就在本机，立刻跑、不占名额，不去远程传提交、装依赖；本机暂停接活才去远程。
  assert.equal(
    chooseCheckHost([local({ running: 2, busy: "忙" }), remote(2)], {
      ...need,
      urgent: true,
    }).kind,
    "local",
  );
  assert.equal(
    chooseCheckHost([local({ paused: true }), remote(2)], {
      ...need,
      urgent: true,
    }).kind,
    "remote",
  );
  assert.equal(
    chooseCheckHost(
      [local({ running: 2, busy: "忙" }), remote(2, { load: 400 })],
      { ...need, urgent: true },
    ).kind,
    "local",
  );
});

test("远程能不能接检查：不在线、暂停、仓库没登记、太忙、检查满了都不接", () => {
  assert.equal(checkRefusal(remote(2), need), null);
  assert.equal(checkRefusal(local({ paused: true }), need), null);
  for (const [over, reason] of [
    [{ connection: "offline" }, /h2 不在线/],
    [{ connection: "pending" }, /h2 不在线/],
    [{ paused: true }, /暂停/],
    [{ repos: ["x/y"] }, /没登记能接仓库 o\/r/],
    [{ busy: "这台太忙" }, /这台太忙/],
    [{ running: 1 }, /最多跑 1 个检查/],
    [{ platform: "win32" }, /h2 是 win32，与检查基准 darwin 平台不同/],
    [{ platform: "linux" }, /接活、不跑把关检查/],
    [{ platform: null }, /h2 还没上报平台/],
  ] as const)
    assert.match(
      checkRefusal(remote(2, over as Partial<CheckCandidate>), need) ?? "",
      reason,
    );
  // 解析不出仓库（"?"）只有登记了 * 的能接。
  assert.equal(checkRefusal(remote(2), { ...need, repo: "?" }), null);
  assert.match(
    checkRefusal(remote(2, { repos: ["o/r"] }), { ...need, repo: "?" }) ?? "",
    /没登记/,
  );
});

test("检查基准平台（t201）：缺省本机平台、仓库可另配；别的平台的主机接活不跑把关检查", () => {
  assert.equal(checkBaseline(null, "darwin"), "darwin");
  assert.equal(checkBaseline("", "darwin"), "darwin");
  assert.equal(checkBaseline("linux\n", "darwin"), "linux");
  assert.equal(checkBaseline(" win32 ", "linux"), "win32");
  assert.equal(checkBaseline("windows", "darwin"), "darwin");
  assert.equal(checkBaseline("freebsd", "linux"), "linux");

  // 本机忙到必须外派，唯一空着的远程是 Windows：不派过去，回本机排队。
  const overloaded = local({ load: 175 });
  assert.deepEqual(
    chooseCheckHost([overloaded, remote(3, { platform: "win32" })], need),
    {
      host: 1,
      kind: "local",
    },
  );
  // 同平台与别的平台都有：只挑同平台的，哪怕别的平台更空。
  assert.deepEqual(
    chooseCheckHost(
      [
        overloaded,
        remote(2, { load: 3 }),
        remote(3, { platform: "win32" }),
        remote(4, { platform: "linux", load: 0 }),
      ],
      need,
    ),
    { host: 2, kind: "remote" },
  );
  // 仓库配了别的基准（linux），本机 darwin 空着也不优先，去 linux 那台；没有 linux 的回本机。
  const linuxNeed = { ...need, platform: "linux" };
  assert.deepEqual(
    chooseCheckHost(
      [local(), remote(4, { platform: "linux", load: 2 })],
      linuxNeed,
    ),
    { host: 4, kind: "remote" },
  );
  assert.deepEqual(chooseCheckHost([local(), remote(2)], linuxNeed), {
    host: 1,
    kind: "local",
  });

  // host show 的「把关检查」一行。
  assert.equal(
    checkRoleText("local", "darwin", "darwin"),
    "跑（检查基准平台 darwin）",
  );
  assert.equal(
    checkRoleText("remote", "darwin", "darwin"),
    "接活，也跑把关检查（与检查基准同为 darwin）",
  );
  assert.equal(
    checkRoleText("remote", "win32", "darwin"),
    "接活、不跑把关检查（平台不同：win32，检查基准 darwin）",
  );
  assert.equal(
    checkRoleText("remote", null, "darwin"),
    "接活、不跑把关检查（还没上报平台）",
  );
  assert.match(checkRoleText("local", "linux", "darwin"), /仍在本机跑/);
});

test("代理照不照做按提交检查：克隆在数据目录里、地址与分支合法、提交是完整哈希、bundle 不超限", () => {
  const data = "/srv/agent";
  const source: CheckSource = {
    url: "https://github.com/o/r.git",
    clone: "/srv/agent/repos/o-r",
    commit: "a".repeat(40),
    base: "main",
  };
  assert.equal(sourceRefusal(source, "linux", data), null);
  assert.equal(
    sourceRefusal({ ...source, bundle: "QUJD" }, "linux", data),
    null,
  );
  for (const [bad, reason] of [
    [{ clone: "/etc/o-r" }, /不在代理数据目录里/],
    [{ clone: "/srv/agent/../etc" }, /不在代理数据目录里/],
    [{ url: "--upload-pack=x" }, /仓库地址/],
    [{ url: "a b" }, /仓库地址/],
    [{ commit: "HEAD" }, /提交号/],
    [{ commit: "a".repeat(39) }, /提交号/],
    [{ base: "-x" }, /基础分支/],
    [{ base: "main;rm" }, /基础分支/],
    [{ bundle: "A".repeat(Math.ceil(MAX_BUNDLE_BYTES / 3) * 4 + 4) }, /太大/],
  ] as const)
    assert.match(
      sourceRefusal({ ...source, ...bad } as CheckSource, "linux", data) ?? "",
      reason,
    );
  // Windows 路径按那台的规则判。
  assert.equal(
    sourceRefusal(
      { ...source, clone: "C:\\agent\\repos\\o-r" },
      "win32",
      "C:\\agent",
    ),
    null,
  );
  const check = { id: "x", kind: "check" as const, task: 1, urgent: false };
  assert.equal(commandRefusal({ ...check, source }, "linux", data), null);
  assert.equal(
    commandRefusal(
      { ...check, worktree: "/srv/agent/repos/o-r-t1-x" },
      "linux",
      data,
    ),
    null,
  );
  assert.match(
    commandRefusal(check, "linux", data) ?? "",
    /要么给工作树、要么给提交/,
  );
  assert.match(
    commandRefusal(
      { ...check, source, worktree: "/srv/agent/repos/w" },
      "linux",
      data,
    ) ?? "",
    /要么给工作树、要么给提交/,
  );
  assert.match(
    commandRefusal({ ...check, worktree: "/tmp/w" }, "linux", data) ?? "",
    /不在代理数据目录里/,
  );
});

const noteOf = (outcome: ReaderOutcome) =>
  outcome.ok ? outcome.note : undefined;

const good = (
  refreshedAt: number,
  account: string | null,
  used = 10,
): ReaderOutcome => ({
  ok: true,
  result: {
    ok: true,
    plan: "Pro",
    windows: [
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: used,
        resetsAt: null,
        periodSeconds: 604800,
      },
    ],
    refreshedAt,
    account,
  },
  note: null,
});

test("额度多主机合并：同一账号只算一份取最新；认不出账号按主机分开；本机账号优先；别的账号写明没算", () => {
  const now = 10_000_000;
  // 同一账号在 h1、h2 都读到：取 h2 更新的那份，不加说明。
  let merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", good(now - 5000, "aaaa1111", 10)]]),
    reports: [
      {
        host: "h2",
        readings: [
          { provider: "codex", outcome: good(now - 1000, "aaaa1111", 30) },
        ],
      },
    ],
    now,
  });
  let codex = merged.get("codex")!;
  assert.equal(codex.from, "h2");
  assert.ok(codex.outcome.ok);
  assert.equal(
    codex.outcome.ok && codex.outcome.result.windows[0]!.usedPercent,
    30,
  );
  assert.equal(noteOf(codex.outcome), null);
  // 本机读不到、h2 读到：用 h2 的，说明读自 h2。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["claude", { ok: false, reason: "没登录" }]]),
    reports: [
      {
        host: "h2",
        readings: [{ provider: "claude", outcome: good(now, "bbbb2222") }],
      },
    ],
    now,
  });
  assert.equal(merged.get("claude")!.from, "h2");
  assert.equal(noteOf(merged.get("claude")!.outcome), "读自 h2");
  // 两台是不同账号：本机那个算数，另一个写明没算进来。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", good(now - 9000, "aaaa1111")]]),
    reports: [
      {
        host: "h2",
        readings: [{ provider: "codex", outcome: good(now, "cccc3333") }],
      },
      {
        host: "h3",
        readings: [{ provider: "codex", outcome: good(now, "cccc3333") }],
      },
    ],
    now,
  });
  codex = merged.get("codex")!;
  assert.equal(codex.from, "h1");
  assert.equal(noteOf(codex.outcome), "h2、h3 登录的是另一个账号，没算进来");
  // 认不出账号的读数按主机各算各的；本机没有时取最新的那台。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map(),
    reports: [
      {
        host: "h2",
        readings: [{ provider: "opencode", outcome: good(now - 50, null) }],
      },
      {
        host: "h3",
        readings: [{ provider: "opencode", outcome: good(now - 10, null) }],
      },
    ],
    now,
  });
  assert.equal(merged.get("opencode")!.from, "h3");
  // 读数太旧不用；都读不到时给本机的原因。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", { ok: false, reason: "本机没登录" }]]),
    reports: [
      {
        host: "h2",
        readings: [
          { provider: "codex", outcome: good(now - 7 * 3600_000, "a1") },
        ],
      },
    ],
    now,
  });
  assert.deepEqual(merged.get("codex"), {
    outcome: { ok: false, reason: "本机没登录" },
    from: null,
  });
  // 本机没读（自带读取关着）、只有别的主机读不到：写明是哪台的原因。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map(),
    reports: [
      {
        host: "h2",
        readings: [
          {
            provider: "claude",
            outcome: { ok: false, reason: "没有找到登录" },
          },
        ],
      },
    ],
    now,
  });
  assert.deepEqual(merged.get("claude"), {
    outcome: { ok: false, reason: "没有找到登录（h2）" },
    from: null,
  });
  // 本机的读数不会被自称 h1 的上报顶掉。
  merged = mergeHostReadings({
    local: "h1",
    localReadings: new Map([["codex", good(now - 100, "a1")]]),
    reports: [
      {
        host: "h1",
        readings: [{ provider: "codex", outcome: good(now, "zz") }],
      },
    ],
    now,
  });
  assert.equal(noteOf(merged.get("codex")!.outcome), null);
});

test("CLI 能在哪几台用：按 provider 把同一家的几个工具合起来", () => {
  const usable = usableByProvider({
    usable: [
      { host: "h1", tools: ["claude", "codex"] },
      { host: "h2", tools: ["codex", "opencode"] },
      { host: "h3", tools: [] },
    ],
  });
  assert.deepEqual(usable.get("claude"), ["h1"]);
  assert.deepEqual(usable.get("codex"), ["h1", "h2"]);
  assert.deepEqual(usable.get("opencode"), ["h2"]);
});

test("账号指纹：不可逆、不含账号 id 与令牌；claude 看 .claude.json 的账号，codex 看用户 + 账号", () => {
  const key = accountKey("claude", "uuid-1:org-1");
  assert.match(key, /^[a-f0-9]{16}$/);
  assert.notEqual(key, accountKey("codex", "uuid-1:org-1"));
  assert.equal(
    claudeAccount(
      JSON.stringify({
        oauthAccount: { accountUuid: "uuid-1", organizationUuid: "org-1" },
      }),
    ),
    key,
  );
  assert.equal(claudeAccount(JSON.stringify({ projects: {} })), null);
  assert.equal(claudeAccount("not json"), null);
  assert.equal(claudeAccount(undefined), null);
  assert.equal(
    claudeAccountFile("linux", "/home/u", {}),
    "/home/u/.claude.json",
  );
  assert.equal(
    claudeAccountFile("win32", "C:\\Users\\u", { CLAUDE_CONFIG_DIR: "D:\\cc" }),
    "D:\\cc\\.claude.json",
  );
  const idToken = (claims: object) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const login = (tokens: object) =>
    parseCodexLogin(
      JSON.stringify({ tokens: { access_token: "secret-token", ...tokens } }),
    );
  const a = login({
    account_id: "acct-1",
    id_token: idToken({
      "https://api.openai.com/auth": { chatgpt_user_id: "user-1" },
    }),
  });
  const b = login({
    account_id: "acct-1",
    id_token: idToken({
      "https://api.openai.com/auth": { chatgpt_user_id: "user-2" },
    }),
  });
  assert.ok(a && !a.apiKeyOnly && b && !b.apiKeyOnly);
  // 同一工作区的两个人额度各算各的。
  assert.notEqual(a.account, b.account);
  assert.equal(a.account, accountKey("codex", "user-1:acct-1"));
  assert.doesNotMatch(a.account ?? "", /secret|acct|user/);
  const none = login({});
  assert.ok(none && !none.apiKeyOnly);
  assert.equal(none.account, null);
});

const facts = (over: Partial<HolderFacts>): HolderFacts => ({
  status: "running",
  delivery_stage: null,
  online_wait: 0,
  worker: "claude-opus",
  queued: null,
  review_task: null,
  schedule_state: null,
  schedule_reason: null,
  waiting_for: [],
  auto: false,
  block: null,
  returned: null,
  merge_returned: null,
  escalated: null,
  processing_by: null,
  inbox: null,
  route: "secretary",
  council_escalated: false,
  ...over,
});

test("看板：检查在别的主机上跑时说在 hN 上；本机或旧记录照旧", () => {
  assert.equal(
    holderOf(facts({ checking: { host: "h2" } }))?.text,
    "claude-opus 交付了，在 h2 上跑检查",
  );
  assert.equal(
    holderOf(facts({ checking: { host: "h1" } }))?.text,
    "claude-opus 交付了，本地检查中",
  );
  assert.equal(holderOf(facts({ checking: null }))?.text, "claude-opus 在做");
  assert.equal(
    holderOf(facts({ delivery_stage: "merging", checking: { host: "h3" } }))
      ?.text,
    "合入中：在 h3 上重跑本地检查",
  );
  assert.equal(
    holderOf(facts({ delivery_stage: "merging", checking: { host: null } }))
      ?.text,
    "合入中：rebase 并重跑本地检查",
  );
});
