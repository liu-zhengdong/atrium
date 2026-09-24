// Called from probe-pi: same disposable profile, actual installed entry and real Pi.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Accounts } from "../server/accounts.ts";

export async function verifyIdentity({
  folder,
  profile,
  cwd,
  runtimes,
  store,
  baseUrl,
  wait,
  raw,
  hash,
  hashes,
  fixtureAccount,
}) {
  const response = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "长期身份验证",
      template: profile,
      description: "终端与后台共用的身份",
    }),
  });
  assert.equal(response.status, 201);
  const agent = (await response.json()).agent;
  new Accounts(store, join(folder, "data")).assign(agent.id, fixtureAccount);
  const command = resolve("bin/atrium.mjs");
  mkdirSync(join(folder, "bin"));
  symlinkSync(command, join(folder, "bin", "atrium"));
  const env = {
    ...process.env,
    ATRIUM_DATA: join(folder, "data"),
    ATRIUM_PI_HOME: join(folder, ".pi"),
  };
  assert(
    execFileSync(command, ["list"], { env, encoding: "utf8" }).includes(
      "长期身份验证",
    ),
  );
  const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const tmux = `atrium-named-${Date.now()}`;
  const launch = () =>
    execFileSync("tmux", [
      "new-session",
      "-d",
      "-s",
      tmux,
      "-x",
      "100",
      "-y",
      "32",
      "-c",
      cwd,
      `env ATRIUM_DATA=${shell(env.ATRIUM_DATA)} PI_ACP_DIR=${shell(env.PI_ACP_DIR)} PI_MCP_CONFIG_MODE=exclusive PI_OFFLINE=1 PATH=${shell(join(folder, "bin") + ":" + env.PATH)} atrium run ${agent.ref}`,
    ]);
  const input = (text) => {
    execFileSync("tmux", ["send-keys", "-t", tmux, "-l", text]);
    execFileSync("tmux", ["send-keys", "-t", tmux, "Enter"]);
  };
  const pane = () =>
    execFileSync("tmux", ["capture-pane", "-p", "-t", tmux, "-S", "-1000"], {
      encoding: "utf8",
    });
  const owner = join(env.PI_ACP_DIR, "identities", `${agent.id}.json`);
  let started = false;
  try {
    launch();
    started = true;
    await wait(async () => {
      await runtimes.discover();
      return runtimes
        .directory()
        .runtimes.some((r) => r.identityId === agent.id);
    }, "具名 CLI 启动实际 Pi");
    await runtimes.pump(agent.id);
    const first = structuredClone(runtimes.connections.get(agent.id).info);
    assert.equal(first.identityId, agent.id);
    assert.equal(first.mode, "tui");
    const chat = store.createChat(agent.name, [agent.id], agent.id);
    const duplicate = spawnSync(command, ["run", agent.ref], {
      env,
      cwd: folder,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already occupied/);
    await assert.rejects(
      runtimes.rpc("_pi/identity/start", {
        identityId: agent.id,
        agentDirectory: agent.agent_directory,
        cwd,
      }),
      /already occupied/,
    );
    input("ATR_IDENTITY_FIRST");
    await wait(
      () => pane().includes("BASELINE_READY"),
      "具名 TUI 实际模型回合完成",
    );
    input("/new");
    await wait(async () => {
      await runtimes.pump(agent.id);
      const current = runtimes.connections.get(agent.id)?.info;
      return current && current.sessionId !== first.sessionId;
    }, "具名身份中的原生 new");
    input("ATR_IDENTITY_SECOND");
    await wait(async () => {
      await runtimes.pump(agent.id);
      const info = runtimes.connections.get(agent.id)?.info;
      return (
        info &&
        !info.busy &&
        existsSync(info.sessionFile) &&
        readFileSync(info.sessionFile, "utf8").includes(
          "ATR_IDENTITY_SECOND",
        ) &&
        readFileSync(info.sessionFile, "utf8").includes('"role":"assistant"')
      );
    }, "新会话实际模型回合完成");
    const switched = structuredClone(runtimes.connections.get(agent.id).info);
    assert.equal(switched.pid, first.pid);
    assert.equal(switched.identityId, agent.id);
    assert.equal(
      store.createChat(agent.name, [agent.id], agent.id).id,
      chat.id,
    );
    assert.notEqual(switched.sessionId, first.sessionId);
    assert(
      readFileSync(switched.sessionFile, "utf8").includes(
        "ATR_IDENTITY_SECOND",
      ),
    );
    const capture = pane();
    writeFileSync(join(raw, "named-tui.txt"), capture, { mode: 0o400 });
    hashes.push({ name: "named-tui.txt", sha256: hash(capture) });
    execFileSync("tmux", ["send-keys", "-t", tmux, "C-d"]);
    await wait(() => !existsSync(owner), "正常退出释放具名占用");
    started = false;
    await runtimes.pump(agent.id);
    launch();
    started = true;
    await wait(async () => {
      await runtimes.discover();
      const r = runtimes
        .directory()
        .runtimes.find((r) => r.identityId === agent.id);
      return r && r.pid !== first.pid;
    }, "退出后同名重启");
    await runtimes.pump(agent.id);
    const resumed = runtimes.connections.get(agent.id).info;
    assert.equal(resumed.sessionId, switched.sessionId);
    assert.equal(resumed.identityId, agent.id);
    assert.equal(
      store.createChat(agent.name, [agent.id], agent.id).id,
      chat.id,
    );
    assert.notEqual(resumed.pid, first.pid);
    execFileSync("tmux", ["send-keys", "-t", tmux, "C-d"]);
    await wait(() => !existsSync(owner), "第二次正常退出");
    started = false;
    await runtimes.pump(agent.id);
    await runtimes.start(agent.id);
    const backend = runtimes.connections.get(agent.id).info;
    assert.equal(backend.identityId, agent.id);
    assert.equal(backend.mode, "rpc");
    assert.equal(backend.sessionId, switched.sessionId);
    const blocked = spawnSync(command, ["run", agent.ref], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /already occupied/);
    await runtimes.rpc("_pi/identity/stop", { identityId: agent.id });
    return {
      ref: agent.ref,
      identity: agent.id,
      checks: [
        "actual-atrium-run-entry",
        "tui-tui-rejected",
        "tui-rpc-rejected",
        "rpc-tui-rejected",
        "native-new-stable-identity",
        "exit-restart-resumes-session",
        "same-chat-after-restart",
        "tui-to-rpc-same-identity",
      ],
    };
  } catch (error) {
    if (started) {
      try {
        writeFileSync(join(folder, "failed-named-tui.txt"), pane());
      } catch {}
    }
    throw error;
  } finally {
    if (started) {
      try {
        execFileSync("tmux", ["kill-session", "-t", tmux]);
      } catch {}
    }
    // 按用户入口执行的 atrium list 会在后台拉起服务；验完停掉，别占着默认端口挡住用户自己的服务。
    try {
      execFileSync(command, ["stop"], { env, stdio: "ignore" });
    } catch {}
  }
}
