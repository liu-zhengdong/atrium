// Called from probe-pi: same disposable profile, actual installed entry and real Pi.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Accounts } from "../server/accounts.ts";

export async function verifyIdentity({
  folder,
  profile,
  cwd,
  runtimes,
  store,
  baseUrl,
  apiFetch,
  wait,
  raw,
  hash,
  hashes,
  fixtureAccount,
}) {
  const response = await apiFetch(`${baseUrl}/api/agents`, {
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
  const shell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  // 每次 launch 换新名字：重 launch 只等 owner 文件释放，旧 tmux 会话可能还没退出，
  // 同名 new-session 会在同一个 tmux server 里撞出 duplicate session。
  let tmux;
  const tmuxNames = new Set();
  const launch = () => {
    tmux = `atrium-named-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tmuxNames.add(tmux);
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
  };
  const input = (text) => {
    execFileSync("tmux", ["send-keys", "-t", tmux, "-l", text]);
    execFileSync("tmux", ["send-keys", "-t", tmux, "Enter"]);
  };
  const pane = () =>
    execFileSync("tmux", ["capture-pane", "-p", "-t", tmux, "-S", "-1000"], {
      encoding: "utf8",
    });
  const owner = join(env.PI_ACP_DIR, "identities", `${agent.id}.json`);
  // 基线：具名阶段开始前已有的 runtime（比如 probe-pi 前面阶段还活着的匿名 TUI）。
  // 断言只针对具名阶段新产生的，清理也只清具名阶段自己产生的，基线一律不碰。
  const baseline = new Map(); // runtimeId -> endpoint
  try {
    for (const name of readdirSync(join(env.PI_ACP_DIR, "runtimes"))) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      try {
        const endpoint = JSON.parse(
          readFileSync(join(env.PI_ACP_DIR, "runtimes", name), "utf8"),
        ).endpoint;
        baseline.set(id, typeof endpoint === "string" ? endpoint : null);
      } catch {
        baseline.set(id, null);
      }
    }
  } catch {}
  // 记录具名阶段新出现的 runtime id 与其 socket 的真实路径（记录里的 endpoint，
  // 扩展自己 unlink 的也是它），收尾按这些路径清，不猜目录。
  const namedRuntimeIds = new Set();
  const namedEndpoints = new Map();
  const collectRuntimeIds = () => {
    try {
      for (const name of readdirSync(join(env.PI_ACP_DIR, "runtimes"))) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (baseline.has(id)) continue;
        namedRuntimeIds.add(id);
        if (!namedEndpoints.has(id)) {
          try {
            const endpoint = JSON.parse(
              readFileSync(join(env.PI_ACP_DIR, "runtimes", name), "utf8"),
            ).endpoint;
            if (typeof endpoint === "string" && endpoint.startsWith("/"))
              namedEndpoints.set(id, endpoint);
          } catch {}
        }
      }
    } catch {}
  };
  const cleanNamedSockets = () => {
    for (const endpoint of namedEndpoints.values()) {
      try {
        unlinkSync(endpoint);
      } catch {}
    }
  };
  try {
    assert(
      execFileSync(command, ["list"], { env, encoding: "utf8" }).includes(
        "长期身份验证",
      ),
    );
    // atrium list 会在后台拉起一个与探针共享 ATRIUM_DATA 的服务。具名阶段只允许探针
    // 进程内的服务在跑：两个服务会竞争 attach 同一个具名 runtime，扩展只认一个控制者，
    // 输掉的一方永远 bind 不上，断言随机超时。这里立刻停掉，finally 里的 stop 兑底。
    assert(env.ATRIUM_PORT, "probe-pi 必须先分配 ATRIUM_PORT");
    execFileSync(command, ["stop"], { env, stdio: "ignore" });
    // 确定性断言：被拉起的服务必须真的停了——它的端口要拒绝连接。
    // 反向验证：注释掉上面的 stop，这里必红（服务还活着，端口可达）。
    await wait(async () => {
      try {
        await fetch(`http://127.0.0.1:${env.ATRIUM_PORT}/api/agents`, {
          signal: AbortSignal.timeout(500),
        });
        return false;
      } catch {
        return true;
      }
    }, "CLI 自动拉起的服务停止");
    launch();
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
    // 具名身份的 runtime 记录只能有一份，且必须落在探针 folder 内
    // （PI_ACP_DIR=folder/pi-acp）；落到全局共享目录说明环境隔离失效。
    const recordDirs = [
      join(env.PI_ACP_DIR, "runtimes"),
      join(homedir(), ".pi", "pi-acp", "runtimes"),
    ];
    const located = [];
    for (const dir of recordDirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
          if (record.identityId === agent.id) located.push(join(dir, name));
        } catch {}
      }
    }
    assert.equal(
      located.length,
      1,
      `具名身份的 runtime 记录应只有一份，实际：${located.join(", ") || "无"}`,
    );
    assert(
      located[0].startsWith(join(env.PI_ACP_DIR, "runtimes") + sep),
      `具名身份的 runtime 记录未落在探针目录内：${located[0]}`,
    );
    collectRuntimeIds();
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
    await runtimes.pump(agent.id);
    launch();
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
    // 成功路径：具名阶段产生的 socket 一个都不许留下；先断言，残留清理在 finally，
    // 扩展真泄漏时这里才红。反向验证：断言前往具名 runtime 的 endpoint 放一个
    // 同名 socket 文件，断言必红。
    collectRuntimeIds();
    const leftSockets = [...namedEndpoints.values()].filter((endpoint) =>
      existsSync(endpoint),
    );
    assert.equal(
      leftSockets.length,
      0,
      `具名阶段的 socket 残留：${leftSockets.join(", ")}`,
    );
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
    if (tmuxNames.size) {
      try {
        writeFileSync(join(folder, "failed-named-tui.txt"), pane());
      } catch {}
    }
    throw error;
  } finally {
    for (const name of tmuxNames) {
      try {
        execFileSync("tmux", ["kill-session", "-t", name]);
      } catch {}
    }
    // 失败路径补清具名阶段产生的 socket：只删收集到的 endpoint，
    // 基线里的其他存活 runtime（以及真实身份正在用的）一律不碰。
    collectRuntimeIds();
    cleanNamedSockets();
    // 反向：清理跑完后，基线里的 runtime socket 必须还在。
    for (const [id, endpoint] of baseline)
      if (endpoint && !existsSync(endpoint))
        throw new Error(
          `基线 runtime ${id.slice(0, 8)} 的 socket 被误删：${endpoint}`,
        );
    // 按用户入口执行的 atrium list 会在后台拉起服务；验完停掉，别占着默认端口挡住用户自己的服务。
    try {
      execFileSync(command, ["stop"], { env, stdio: "ignore" });
    } catch {}
  }
}
