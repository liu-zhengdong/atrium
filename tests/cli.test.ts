import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alive, packageRoot, readService } from "../server/service-state.ts";
import { Store } from "../server/store.ts";
import { Accounts } from "../server/accounts.ts";
import { commandAgent } from "../shared/command-agent.ts";
import { RequestError } from "@agentclientprotocol/sdk";
import { errorWithDetails } from "../server/runtime-error.ts";
import { LOCAL_USER } from "../shared/user.ts";

const exec = promisify(execFile);
/** 与 service.test.ts 同一种夹具：隔离数据目录、随机端口、假的 Pi 模板，Pi 命令指向不存在的路径。 */
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-cli-"));
  const data = join(root, "data");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const builtin = join(root, "pi-template");
  mkdirSync(builtin);
  writeFileSync(join(builtin, "settings.json"), '{"packages":[]}');
  writeFileSync(join(builtin, "SYSTEM.md"), "builtin rules");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ATRIUM_DATA: data,
    ATRIUM_PORT: String(port),
    ATRIUM_DESKTOPS: join(root, "desktops"),
    ATRIUM_PI_HOME: join(root, ".pi"),
    ATRIUM_PI_TEMPLATE: builtin,
    PI_ACP_DIR: join(root, "acp"),
    PI_ACP_PI_COMMAND: join(root, "no-such-pi"),
    // 服务白名单会丢掉 PI_*；ATRIUM_PI_BIN 是服务侧的保留开关（#213）。
    ATRIUM_PI_BIN: join(root, "no-such-pi"),
  };
  const cli = async (...args: string[]) => {
    try {
      const output = await exec(
        process.execPath,
        [join(packageRoot, "bin/atrium.mjs"), ...args],
        { env, cwd: root, timeout: 25000 },
      );
      return { ...output, code: 0 };
    } catch (error) {
      const failure = error as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      return {
        stdout: failure.stdout,
        stderr: failure.stderr,
        code: failure.code,
      };
    }
  };
  t.after(async () => {
    await cli("stop");
    const record = readService(data);
    if (record && record.pid !== process.pid && alive(record.pid))
      process.kill(record.pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  return { root, data, env, cli };
}

test(
  "atrium list/show 展示 overview 的真实重试状态",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.cli("create", "重试身份")).code, 0);
    const db = new Store(join(f.data, "atrium.sqlite"));
    const agent = db.agents().find((entry) => entry.ref === "a1")!;
    const chat = db.createChat("私聊", [agent.id], agent.id);
    const queued = db.send(LOCAL_USER, {
      chat_id: chat.id,
      body: "请处理",
      mentions: [],
    });
    // Pin the queued message well before this incident; wall-clock timing must
    // not turn it into a fresh user retry when the CLI runs slowly in CI.
    db.run(
      "UPDATE messages SET created_at=? WHERE id=?",
      1_700_000_000_000,
      queued.id,
    );
    db.setFailure(agent.id, "Connection error.", Date.now(), "provider");
    db.close();
    const show = await f.cli("show", "a1");
    const list = await f.cli("list");
    assert.equal(show.code, 0, show.stderr);
    assert.equal(list.code, 0, list.stderr);
    assert.match(show.stdout, /出错 · .*自动重试（第 1\/3 次）/);
    assert.match(list.stdout, /出错 · .*自动重试（第 1\/3 次）/);
    assert.match(show.stdout, /Connection error\./);
  },
);

test(
  "CLI 从标准输入添加与更换假 setup-token，不把令牌写进命令或回显",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const fake = join(f.root, "claude");
    writeFileSync(
      fake,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify({is_error:false,result:"OK"}));\n',
      { mode: 0o700 },
    );
    f.env.PATH = `${f.root}:${process.env.PATH}`;
    const run = (args: string[], token: string) =>
      new Promise<{ code: number | null; out: string; err: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [join(packageRoot, "bin/atrium.mjs"), ...args],
            { cwd: f.root, env: f.env },
          );
          let out = "",
            err = "";
          child.stdout.on("data", (part: Buffer) => (out += part));
          child.stderr.on("data", (part: Buffer) => (err += part));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, out, err }));
          child.stdin.end(token + "\n");
        },
      );
    // 新建 Claude 账号已封（#242）：拒绝且不读走令牌，也不留账号。
    const refused = await run(
      [
        "account",
        "add",
        "claude-bridge",
        "--name",
        "隔离账号",
        "--setup-token",
        "-",
      ],
      "FAKE_TOKEN_ONE",
    );
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /不再接入 Claude 模型/);
    assert.doesNotMatch(refused.out + refused.err, /FAKE_TOKEN_ONE/);
    const local = await run(["account", "add", "claude-bridge", "--local"], "");
    assert.notEqual(local.code, 0);
    assert.match(local.err, /不再接入 Claude 模型/);
    // 升级前建好的 setup-token 账号照常更换令牌；先拉起服务建好数据库。
    const listed = await f.cli("accounts");
    assert.equal(listed.code, 0, listed.stderr);
    const store = new Store(join(f.data, "atrium.sqlite"));
    const ref = (
      await new Accounts(store, f.data).addSetupToken(
        "隔离账号",
        "FAKE_TOKEN_ONE",
        () => undefined,
      )
    ).id;
    store.close();
    const replaced = await run(
      ["account", "replace-token", ref, "--setup-token", "-"],
      "FAKE_TOKEN_TWO",
    );
    assert.equal(replaced.code, 0, replaced.err);
    assert.doesNotMatch(replaced.out + replaced.err, /FAKE_TOKEN_TWO/);
    assert.equal(
      readFileSync(join(f.data, "accounts", ref, "claude-setup-token"), "utf8"),
      "FAKE_TOKEN_TWO\n",
    );
  },
);

test(
  "命令行覆盖名册、偏好、聊天与通知的主要路径，并拒绝越权与误操作",
  { timeout: 240000 },
  async (t) => {
    const f = await fixture(t);
    const ok = async (...args: string[]) => {
      const result = await f.cli(...args);
      assert.equal(result.code, 0, `${args.join(" ")}：${result.stderr}`);
      return result.stdout;
    };
    const refused = async (...args: string[]) => {
      const result = await f.cli(...args);
      assert(
        [2, 3, 4].includes(result.code),
        `${args.join(" ")} 应被拒：${result.stdout}；退出码 ${result.code}`,
      );
      return result.stderr;
    };

    // 不认识的命令和多余参数在碰数据目录之前就退出。
    const unknown = await refused("bogus");
    assert.match(unknown, /不认识的命令/);
    assert.equal((unknown.match(/最接近的/g) ?? []).length, 1);
    assert.doesNotMatch(unknown, /修正：atrium --help/);
    assert(!existsSync(f.data));
    assert.match(await refused("list", "extra"), /用法：atrium list/);
    assert.match(await refused("show"), /用法：atrium show 名称/);
    assert(!existsSync(f.data));

    // 第一条经服务的命令把服务拉起来，并说清楚。
    const created = await f.cli("create", "林岚");
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /林岚 · a1/);
    assert.match(
      created.stdout.trimEnd().split("\n").at(-1)!,
      /^查看可用账号：atrium accounts$/,
    );
    assert.match(created.stderr, /Atrium 服务已在后台启动/);
    const record = readService(f.data);
    assert(record && alive(record.pid));
    const startup = await f.cli("--no-open");
    assert.equal(startup.code, 0, startup.stderr);
    assert.equal((startup.stdout.match(/停止：atrium stop/g) ?? []).length, 1);
    const invalidCustom = await f.cli(
      "connect",
      "--custom",
      "假服务",
      "--base-url",
      "http://127.0.0.1:1/v1",
      "--api-key",
      "fake",
      "--model",
      "demo",
    );
    assert.equal(invalidCustom.code, 2);
    assert.match(
      invalidCustom.stderr,
      /--custom 要填 provider id：小写字母开头/,
    );
    assert.doesNotMatch(invalidCustom.stderr, /Invalid string|pattern/);
    const badOption = await f.cli("send", "乙", "你好", "--bogus");
    assert.equal(badOption.code, 2);
    assert.match(badOption.stderr, /示例：atrium send 甲 你好/);
    assert.doesNotMatch(badOption.stderr, /修正：/);
    const badOptionJson = await f.cli(
      "send",
      "乙",
      "你好",
      "--bogus",
      "--json",
    );
    assert.equal(badOptionJson.code, 2);
    assert.equal(JSON.parse(badOptionJson.stdout).next, null);
    const again = await f.cli(
      "create",
      "沈默",
      "--from",
      "林岚",
      "--description",
      "评审代码",
    );
    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stderr, /已在后台启动/);

    // 名册与详情
    const list = await ok("list");
    assert.match(list, /a1\s+林岚\s+未分配账号/);
    assert.match(list, /a2\s+沈默\s+未分配账号/);
    const blockedTui = await f.cli("run", "a1");
    assert.equal(blockedTui.code, 4);
    assert.equal(blockedTui.stderr, "未分配账号\n修正：atrium account check\n");
    const blockedStart = await f.cli("start", "a1");
    assert.equal(blockedStart.code, 4);
    assert.equal(
      blockedStart.stderr,
      "未分配账号\n修正：atrium account check\n",
    );
    const preflight = await f.cli("account", "check");
    assert.equal(preflight.code, 4);
    assert.match(preflight.stderr, /atrium assign a1 <账号短号>/);
    assert.equal((preflight.stderr.match(/可用账号：/g) ?? []).length, 1);
    assert.match(preflight.stderr, /添加账号：atrium connect/);
    assert.doesNotMatch(await ok("help"), /atrium credentials /);
    assert.equal((await f.cli("credentials", "a1")).code, 2);
    // 离线身份显示配置里写着的模型
    const invalidModel = await f.cli(
      "model",
      "林岚",
      "deepseek/deepseek-chat",
      "--json",
    );
    assert.equal(invalidModel.code, 3);
    const modelError = JSON.parse(invalidModel.stdout);
    assert.equal(modelError.error.code, "model_not_found");
    assert.doesNotMatch(modelError.error.message, /model:/);
    assert.match(modelError.next, /^atrium model 林岚 deepseek\//);
    assert(modelError.error.candidates.length <= 3);
    const invalidBuiltin = await f.cli(
      "model",
      "林岚",
      "openai/does-not-exist",
    );
    assert.equal(invalidBuiltin.code, 3);
    assert.match(invalidBuiltin.stderr, /最接近的：/);
    assert.match(invalidBuiltin.stderr, /openai\/gpt-/);
    assert.doesNotMatch(invalidBuiltin.stderr, /gpt-4（openai\/gpt-4）/);
    const malformedModel = await f.cli("model", "林岚", "foo", "--json");
    assert.equal(malformedModel.code, 2);
    assert.match(
      JSON.parse(malformedModel.stdout).error.message,
      /模型写法是 provider\/id/,
    );
    assert.doesNotMatch(
      JSON.parse(malformedModel.stdout).error.message,
      /model:/,
    );
    const invalidHeartbeat = await f.cli(
      "config",
      "林岚",
      "--heartbeat",
      "garbage",
      "--json",
    );
    assert.equal(invalidHeartbeat.code, 2);
    assert.match(
      JSON.parse(invalidHeartbeat.stdout).error.message,
      /--heartbeat 要填秒数/,
    );
    assert.doesNotMatch(
      JSON.parse(invalidHeartbeat.stdout).error.message,
      /heartbeat_seconds|Invalid input/,
    );
    const noBody = await f.cli("send", "林岚", "", "--json");
    assert.equal(noBody.code, 2);
    assert.match(JSON.parse(noBody.stdout).error.message, /正文不能为空/);
    assert.doesNotMatch(JSON.parse(noBody.stdout).error.message, /body:/);
    const absentAccount = await f.cli("assign", "林岚", "k999", "--json");
    assert.equal(absentAccount.code, 3);
    assert.equal(
      JSON.parse(absentAccount.stdout).error.code,
      "account_not_found",
    );
    assert.equal(JSON.parse(absentAccount.stdout).next, "atrium accounts");
    await ok("model", "林岚", "deepseek/deepseek-v4-pro:high");
    const preflightJson = await f.cli("account", "check", "--json");
    assert.equal(preflightJson.code, 4);
    assert.equal(
      JSON.parse(preflightJson.stdout).error.code,
      "validation_failed",
    );
    assert.match(
      await ok("list"),
      /a1\s+林岚\s+未分配账号\s+deepseek\/deepseek-v4-pro:high/,
    );
    const listed = (
      JSON.parse(await ok("list", "--json")) as {
        ok: boolean;
        result: { ref: string }[];
      }
    ).result;
    assert.deepEqual(
      listed.map((agent) => agent.ref),
      ["a1", "a2"],
    );
    assert.match(await ok("show", "沈默"), /介绍：评审代码/);
    assert.match(await ok("show", "a2"), /沈默 · a2 · 未分配账号/);
    assert.match(await refused("show", "不存在"), /没有叫「不存在」的 Agent/);
    // 偏好与资料：非法值被拒，合法值落库。
    assert.match(await ok("config", "沈默", "--heartbeat", "45"), /心跳 45 秒/);
    assert.match(await ok("config", "沈默"), /心跳 45 秒/);
    await refused("config", "沈默", "--heartbeat", "1");
    await refused("config", "沈默", "--auto-start", "on");
    assert.match(
      await ok("profile", "沈默", "--description", "评审与测试"),
      /评审与测试/,
    );
    assert.match(
      await refused("profile", "沈默", "--name", "林岚"),
      /已经被使用/,
    );
    assert.match(await ok("user", "--name", "老刘"), /称呼：老刘/);

    // 发言：默认用户名义，目标写身份就打开私聊；再次以身份为目标复用同一私聊。
    assert.match(
      await ok("send", "林岚", "你好，先看看仓库"),
      /已发送 #1 → 林岚（c1）/,
    );
    assert.match(await ok("chats"), /c1\s+林岚\s+私聊/);
    assert.match(await ok("read", "c1"), /#1 .*老刘\(u1\)：你好，先看看仓库/);
    assert.match(await ok("read", "林岚"), /你好，先看看仓库/);
    // 以身份名义发言要有成员资格：沈默不在林岚与用户的私聊里。
    await refused("send", "c1", "我也说一句", "--as", "沈默");
    assert.doesNotMatch(await ok("read", "c1"), /我也说一句/);

    // 建群、以身份名义发言并提及同伴
    assert.match(
      await ok("group", "评审组", "林岚", "沈默"),
      /已建群 评审组（c2）· 成员 2 位/,
    );
    assert.match(
      await ok("send", "c2", "开工了", "--as", "林岚", "--mention", "沈默"),
      /已发送 #\d+ → 评审组（c2）/,
    );
    assert.match(await ok("read", "c2"), /林岚\(a1\)：开工了/);
    assert.match(await ok("chats"), /c2\s+评审组\s+群/);
    // 会话目标也认名称，不只是短号
    assert.match(
      await ok("send", "评审组", "按名字发", "--as", "林岚"),
      /已发送 #\d+ → 评审组（c2）/,
    );
    assert.match(await ok("read", "评审组"), /按名字发/);
    const sentJson = JSON.parse(await ok("send", "c2", "JSON check", "--json"));
    assert.deepEqual(Object.keys(sentJson), ["ok", "result", "next"]);
    assert.match(sentJson.next, /^atrium wait c2 --after \d+$/);
    const readJson = JSON.parse(await ok("read", "c2", "--json"));
    assert.equal(readJson.ok, true);
    assert.match(readJson.next, /^atrium (read|wait) c2 /);
    // 身份排在会话名前面：同名时 --as 开的是两位同伴的私聊，不是用户与它的那个
    assert.match(
      await ok("send", "林岚", "单独聊一句", "--as", "沈默"),
      /已发送 #\d+ → 沈默 · 林岚（c\d+）/,
    );
    assert.doesNotMatch(await ok("read", "c1"), /单独聊一句/);

    // 成员管理：私聊不能加人。
    await ok("create", "周远");
    assert.match(
      await ok("invite", "评审组", "周远"),
      /周远 已加入 评审组（c2）· 成员 3 位/,
    );
    assert.match(
      await ok("kick", "c2", "周远"),
      /周远 已移出 评审组（c2）· 成员 2 位/,
    );
    assert.match(await refused("invite", "c1", "周远"), /私聊不能添加其他成员/);

    // 通知进消息箱；用户审阅不改变已读。
    assert.match(
      await ok("notify", "沈默", "巡检", "请看 c2 的安排"),
      /已通知 沈默 · #\d+/,
    );
    const box = await ok("box", "沈默");
    assert.match(box, /\[system\]\s+巡检 · 未读/);
    assert.match(await ok("box", "沈默"), /未读/);
    assert.match(await ok("box", "沈默", "--pending"), /巡检/);

    // 搜索
    assert.match(await ok("search", "开工"), /开工了/);
    assert.match(await ok("search", "沈默"), /a2\s+沈默/);

    // 停止只对在跑的托管实例有效
    assert.match(await refused("stop", "林岚"), /没在运行/);

    // 删除预览仍需人工确认：离线时 JSON 不能把危险命令作为 next。
    const preview = await f.cli("delete", "周远");
    assert.equal(preview.code, 2, preview.stderr);
    assert.match(preview.stderr, /将删除 周远（a3，未分配账号）/);
    assert.match(preview.stderr, /确认删除：atrium delete 周远 --yes/);
    assert.doesNotMatch(preview.stderr, /先停止：|修正：/);
    const previewJson = await f.cli("delete", "周远", "--json");
    assert.equal(previewJson.code, 2, previewJson.stderr);
    assert.equal(
      JSON.parse(previewJson.stdout).error.code,
      "confirmation_required",
    );
    assert.equal(JSON.parse(previewJson.stdout).next, null);
    assert.match(await ok("list"), /周远/);
    // 邀请后的异步投递可能仍在处理连接；只等待这一明确的临时状态。
    let deleted = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await f.cli("delete", "周远", "--yes");
      if (result.code === 0) {
        assert.match(result.stdout, /已删除 周远（a3）/);
        deleted = true;
        break;
      }
      assert.match(result.stderr, /Agent 正在处理连接，请稍后重试/);
      await delay(100);
    }
    assert(deleted, "投递结束后仍无法删除周远");
    assert.doesNotMatch(await ok("list"), /周远/);
    assert.match(
      await refused("send", "周远", "还在吗"),
      /没有叫「周远」的会话或 Agent/,
    );

    // 群名不保证唯一，撞名时报短号不猜
    const secondGroup = await ok("group", "评审组", "林岚");
    const secondGroupRef = secondGroup.match(/已建群 评审组（(c\d+)）/)?.[1];
    assert(secondGroupRef, secondGroup);
    const clash = /有 2 个会话叫 评审组，请改用短号：c2、c\d+/;
    assert.match(await refused("send", "评审组", "哪个"), clash);
    const clashJson = await f.cli("send", "评审组", "哪个", "--json");
    assert.equal(clashJson.code, 4);
    assert.deepEqual(
      JSON.parse(clashJson.stdout)
        .error.candidates.map((value: { ref: string }) => value.ref)
        .slice(0, 1),
      ["c2"],
    );
    assert.equal(clashJson.stderr, "");
    assert.match(await refused("read", "评审组"), clash);
    assert.match(await refused("invite", "评审组", "沈默"), clash);
    assert.match(await ok("read", "c2"), /按名字发/, "短号仍然直达");

    // 删除群：不带 --yes 只预览；确认后群、消息、成员关系与提醒一起消失
    assert.match(await refused("disband", "评审组"), clash, "撞名时不猜");
    const disbandPreview = await refused("disband", "c2");
    assert.match(
      disbandPreview,
      /将删除 评审组（c2）：成员 2 位、消息 \d+ 条、附件 0 个、共享文件 0 个[^\n]*\n确认删除：atrium disband c2 --yes/,
      "不带 --yes 只预览：摘要一行、确认命令单独一行",
    );
    assert.doesNotMatch(
      disbandPreview,
      /修正/,
      "预览不是修正，不能写成照做就好的命令",
    );
    const disbandPreviewJson = await f.cli("disband", "c2", "--json");
    assert.equal(disbandPreviewJson.code, 2, "预览不上屏时也算没执行");
    const refusedBody = JSON.parse(disbandPreviewJson.stdout) as {
      ok: boolean;
      error: { code: string; message: string };
      next: unknown;
    };
    assert.deepEqual(
      {
        ok: refusedBody.ok,
        code: refusedBody.error.code,
        next: refusedBody.next,
        // --json 只给第一行：确认命令既不进 next，也不进 JSON 正文（与 atrium delete 同一口径）
        inMessage: /确认删除：atrium disband c2 --yes/.test(
          refusedBody.error.message,
        ),
      },
      {
        ok: false,
        code: "confirmation_required",
        next: null,
        inMessage: false,
      },
      "删数据的确认命令不进 next，也不进 JSON 正文",
    );
    assert.match(await ok("read", "c2"), /按名字发/, "预览不删任何东西");
    assert.match(await refused("disband", "c1"), /是私聊，只有群可以删除/);
    assert.match(
      await ok("disband", "c2", "--yes"),
      /已删除 评审组（c2）· 消息 \d+ 条 · 成员 2 位/,
    );
    assert.match(await refused("read", "c2"), /没有叫「c2」的会话/);
    assert.match(await refused("disband", "c2", "--yes"), /没有叫「c2」的会话/);
    const remaining = await ok("chats");
    assert.doesNotMatch(remaining, /^c2\s/m, "要删的群从列表里消失");
    assert.match(
      remaining,
      new RegExp(`^${secondGroupRef}\\s+评审组\\s+群`, "m"),
      "另一个同名群不受影响",
    );
    assert.doesNotMatch(await ok("search", "开工"), /开工了/);
    // 回执按新约定：上屏给下一步命令，--json 是 {ok, result, next}，next 是能直接跑的命令
    assert.match(
      await ok("disband", secondGroupRef, "--yes"),
      new RegExp(
        `已删除 评审组（${secondGroupRef}）[\\s\\S]*看剩下的会话：atrium chats`,
      ),
    );
    await ok("group", "临时组", "林岚");
    const receipt = await f.cli("disband", "临时组", "--yes", "--json");
    assert.equal(receipt.code, 0);
    const json = JSON.parse(receipt.stdout) as {
      ok: boolean;
      result: { name: string };
      next: string;
    };
    assert.deepEqual(
      { ok: json.ok, name: json.result.name, next: json.next },
      { ok: true, name: "临时组", next: "atrium chats" },
      "删除回执给结果与下一步命令",
    );

    // 帮助列出全部命令
    const help = await ok("--help");
    for (const name of [
      "list",
      "show",
      "create",
      "start",
      "stop",
      "delete",
      "config",
      "profile",
      "model",
      "trace",
      "chats",
      "read",
      "send",
      "group",
      "invite",
      "kick",
      "disband",
      "box",
      "notify",
      "search",
      "user",
      "runtimes",
      "attach",
      "promote",
      "run",
    ])
      assert.match(help, new RegExp(`atrium ${name}( |$)`, "m"));

    // 故障可能即时在用户私聊发系统提示；在固定会话编号的断言之后验证。
    const diagnosis = new Store(join(f.data, "atrium.sqlite"));
    diagnosis.setFailure(
      diagnosis.resolveAgentId("a2"),
      errorWithDetails(RequestError.internalError({ details: "缺少运行扩展" })),
    );
    diagnosis.close();
    assert.match(await ok("show", "a2"), /data: \{"details":"缺少运行扩展"\}/);
  },
);

test(
  "分配回执包含身份和账号；撤销时优先给可执行的分配命令",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const cli = join(f.root, "claude");
    writeFileSync(
      cli,
      '#!/bin/sh\n[ "$1" = "--version" ] || exit 2\necho "1.0"\n',
    );
    chmodSync(cli, 0o700);
    writeFileSync(
      join(f.root, "pi-template", "claude-bridge.json"),
      JSON.stringify({ provider: { pathToClaudeCodeExecutable: cli } }),
    );
    assert.equal((await f.cli("create", "甲")).code, 0);
    const store = new Store(join(f.data, "atrium.sqlite"));
    const agent = store.agent(store.resolveAgentId("a1"));
    store.close();
    const settings = join(agent.agent_directory!, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        defaultProvider: "claude-bridge",
        defaultModel: "claude-haiku-4-5",
        packages: [],
      }),
    );
    // 新建 Claude 账号已封（#242）；这里模拟升级前已建好的本机登录账号。
    const refusedLocal = await f.cli(
      "account",
      "add",
      "claude-bridge",
      "--local",
    );
    assert.notEqual(refusedLocal.code, 0);
    assert.match(refusedLocal.stderr, /不再接入 Claude 模型/);
    const seed = new Store(join(f.data, "atrium.sqlite"));
    seed.run(
      "INSERT INTO accounts(provider,name,type,status) VALUES('claude-bridge','Claude Code（本机登录）','local','ready')",
    );
    seed.close();
    const assigned = await f.cli("assign", "甲", "k1");
    assert.equal(assigned.code, 0, assigned.stderr);
    assert.equal(
      assigned.stdout,
      "已分配：甲 → k1 Claude Code（本机登录）\n看分配：atrium accounts\n",
    );
    const repeated = await f.cli("assign", "甲", "k1");
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /^已分配过：甲 → k1/);
    const missingProvider = await f.cli("unassign", "甲");
    assert.equal(missingProvider.code, 2);
    assert.equal(
      missingProvider.stderr,
      "用法：atrium unassign 身份 provider\n修正：atrium unassign 甲 claude-bridge\n",
    );
    const missingJson = await f.cli("unassign", "甲", "--json");
    assert.equal(
      JSON.parse(missingJson.stdout).next,
      "atrium unassign 甲 claude-bridge",
    );
    assert.equal(commandAgent("张.三-甲_1", "a1"), "张.三-甲_1");
    for (const unsafe of ["张 三", "张;三", "张$三", "-选项", "张|三", "张`三"])
      assert.equal(commandAgent(unsafe, "a1"), "a1");
    const renamed = new Store(join(f.data, "atrium.sqlite"));
    renamed.run("UPDATE agents SET name=? WHERE id=?", "张 三", agent.id);
    renamed.close();
    const unsafePreview = await f.cli("delete", "张 三");
    assert.equal(unsafePreview.code, 2, unsafePreview.stderr);
    assert.match(unsafePreview.stderr, /确认删除：atrium delete a1 --yes/);
    assert.doesNotMatch(unsafePreview.stderr, /atrium delete 张 三 --yes/);
    const spacedName = await f.cli("unassign", "张 三");
    assert.equal(spacedName.code, 2);
    assert.match(spacedName.stderr, /修正：atrium unassign a1 claude-bridge/);
    assert.doesNotMatch(spacedName.stderr, /atrium unassign 张 三/);
    const restored = new Store(join(f.data, "atrium.sqlite"));
    restored.run("UPDATE agents SET name=? WHERE id=?", "甲", agent.id);
    restored.close();
    const removal = await f.cli("unassign", "a1", "claude-bridge");
    assert.equal(removal.code, 0, removal.stderr);
    assert.match(removal.stdout, /重新分配：atrium assign a1 k1\n$/);
    assert.doesNotMatch(removal.stdout, /模式：|atrium account check/);
    const asJson = await f.cli("assign", "a1", "k1", "--json");
    assert.equal(asJson.code, 0, asJson.stderr);
    assert.equal(
      JSON.parse(asJson.stdout).result.accountName,
      "Claude Code（本机登录）",
    );
    writeFileSync(
      settings,
      JSON.stringify({
        defaultProvider: "other",
        defaultModel: "unknown",
        packages: [],
      }),
    );
    const unknown = await f.cli("unassign", "甲", "claude-bridge", "--json");
    assert.equal(unknown.code, 0, unknown.stderr);
    assert.equal(JSON.parse(unknown.stdout).next, "atrium account check");
    assert.equal((await f.cli("assign", "a1", "k1", "--json")).code, 0);
    writeFileSync(settings, JSON.stringify({ packages: [] }));
    const noModel = await f.cli("unassign", "a1", "claude-bridge", "--json");
    assert.equal(noModel.code, 0, noModel.stderr);
    assert.equal(JSON.parse(noModel.stdout).next, "atrium assign a1 k1");
  },
);

test(
  "删除运行中的身份给出先停止再删除的命令；带空格名称改用短号",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    // 新测试只传假服务和隔离目录，不把宿主机认证环境传给子进程。
    const allowed = new Set([
      "HOME",
      "USER",
      "LOGNAME",
      "PATH",
      "TERM",
      "ATRIUM_DATA",
      "ATRIUM_PORT",
      "ATRIUM_DESKTOPS",
      "ATRIUM_PI_HOME",
      "ATRIUM_PI_TEMPLATE",
      "PI_ACP_DIR",
      "PI_ACP_PI_COMMAND",
      "ATRIUM_PI_BIN",
    ]);
    for (const key of Object.keys(f.env))
      if (!allowed.has(key)) delete f.env[key];
    f.env.PI_ACP_PI_COMMAND = join(packageRoot, "node_modules/.bin/pi");
    f.env.ATRIUM_PI_BIN = join(packageRoot, "node_modules/.bin/pi");
    const provider = createServer((req, res) => {
      if (req.url === "/v1/models")
        res
          .writeHead(200, { "content-type": "application/json" })
          .end('{"data":[{"id":"demo"}]}');
      else if (req.url === "/v1/chat/completions")
        res
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}\n\ndata: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => provider.close(() => resolve())),
    );
    const base = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
    for (const args of [
      ["create", "张 三"],
      [
        "connect",
        "--custom",
        "fake-local",
        "--base-url",
        base,
        "--api-key",
        "DUMMY_KEY",
        "--model",
        "demo",
      ],
      ["assign", "a1", "k1"],
      ["start", "a1"],
    ]) {
      const result = await f.cli(...args);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    }
    const preview = await f.cli("delete", "张 三");
    assert.equal(preview.code, 2, preview.stderr);
    assert.match(
      preview.stderr,
      /先停止：atrium stop a1\n确认删除：atrium delete a1 --yes/,
    );
    assert.doesNotMatch(preview.stderr, /修正：|atrium stop 张 三/);
    const previewJson = await f.cli("delete", "a1", "--json");
    assert.equal(previewJson.code, 2, previewJson.stderr);
    assert.deepEqual(JSON.parse(previewJson.stdout), {
      ok: false,
      error: {
        code: "confirmation_required",
        message: "将删除 张 三（a1，在线）：撤销访问与后续唤醒，历史聊天保留。",
      },
      next: "atrium stop a1",
    });
    const refused = await f.cli("delete", "张 三", "--yes");
    assert.equal(refused.code, 4);
    assert.match(
      refused.stderr,
      /Agent 仍在运行[^\n]*\n修正：atrium stop a1\n确认删除：atrium delete a1 --yes/,
    );
    const refusedJson = await f.cli("delete", "a1", "--yes", "--json");
    assert.equal(refusedJson.code, 4);
    assert.equal(JSON.parse(refusedJson.stdout).next, "atrium stop a1");
    assert.equal((await f.cli("stop", "a1")).code, 0);
    const stopped = await f.cli("delete", "a1");
    assert.equal(stopped.code, 2, stopped.stderr);
    assert.match(stopped.stderr, /将删除 张 三（a1，离线）/);
    assert.doesNotMatch(stopped.stderr, /先停止：|修正：/);
    assert.match(stopped.stderr, /确认删除：atrium delete a1 --yes/);
    const stoppedJson = await f.cli("delete", "a1", "--json");
    assert.equal(stoppedJson.code, 2);
    assert.deepEqual(JSON.parse(stoppedJson.stdout), {
      ok: false,
      error: {
        code: "confirmation_required",
        message: "将删除 张 三（a1，离线）：撤销访问与后续唤醒，历史聊天保留。",
      },
      next: null,
    });
    assert.equal((await f.cli("delete", "a1", "--yes")).code, 0);
  },
);
