import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  addHost,
  editHostConnection,
  ensureHostTables,
  hostRow,
  hostView,
} from "../server/hosts/model.ts";
import { HostTunnels } from "../server/hosts/tunnels.ts";
import {
  retryDelay,
  sshConnection,
  tunnelArgs,
  tunnelPorts,
  type SshConnection,
} from "../server/hosts/tunnel-plan.ts";

test("旧版 hosts 表启动时补 SSH 字段；无关旧运行时表不读写", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE hosts(id INTEGER PRIMARY KEY, name TEXT, kind TEXT); CREATE TABLE legacy_chat(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO legacy_chat VALUES(1,'保留');",
    );
    ensureHostTables(db);
    const columns = (
      db.prepare("PRAGMA table_info(hosts)").all() as { name: string }[]
    ).map((item) => item.name);
    for (const name of [
      "ssh_target",
      "ssh_key",
      "tunnel_local_port",
      "tunnel_remote_port",
    ])
      assert.ok(columns.includes(name));
    assert.deepEqual(
      db
        .prepare("SELECT * FROM legacy_chat")
        .all()
        .map((row) => ({ ...row })),
      [{ id: 1, body: "保留" }],
    );
  } finally {
    db.close();
  }
});

test("SSH 配置与反向转发参数：输入边界、私钥只作为路径传递", () => {
  const ssh = sshConnection({
    ssh: "cpcli@100.70.239.117",
    key: "~/.ssh/id_ed25519",
    tunnel: "4310:14310",
  });
  assert.deepEqual(ssh, {
    target: "cpcli@100.70.239.117",
    key: "~/.ssh/id_ed25519",
    localPort: 4310,
    remotePort: 14310,
  });
  assert.deepEqual(sshConnection({ ssh: "u@host" }, 4310), {
    target: "u@host",
    key: null,
    localPort: 4310,
    remotePort: 4310,
  });
  assert.deepEqual(tunnelArgs(ssh!, "/tmp/key"), [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    "/tmp/key",
    "-R",
    "127.0.0.1:14310:127.0.0.1:4310",
    "cpcli@100.70.239.117",
  ]);
  for (const invalid of ["0:1", "1:65536", "1:0", "1:2:3", "1:2\nfoo", "-1:2"])
    assert.throws(() => tunnelPorts(invalid), /--tunnel/);
  for (const invalid of [
    "-oProxyCommand=evil",
    "x @host",
    "x@../host",
    "x@host\nX",
  ])
    assert.throws(
      () => sshConnection({ ssh: invalid, tunnel: "4310:14310" }),
      /--ssh/,
    );
  assert.throws(
    () => sshConnection({ ssh: "u@host", key: "-bad", tunnel: "4310:14310" }),
    /--key/,
  );
  assert.deepEqual(
    [0, 1, 2, 3, 10].map(retryDelay),
    [1000, 2000, 4000, 8000, 60000],
  );
});

class FakeSsh extends EventEmitter {
  stderr = new PassThrough();
  pid = 100;
}

test("SSH 隧道：记录持久、退出重连、编辑重启、移除和关闭清理", async () => {
  const db = new DatabaseSync(":memory:");
  ensureHostTables(db);
  const ssh = sshConnection({
    ssh: "cpcli@100.70.239.117",
    tunnel: "4310:14310",
  })!;
  const { id } = addHost(db, { name: "ggb", ssh });
  const children: FakeSsh[] = [];
  const stopped: FakeSsh[] = [];
  const manager = new HostTunnels(
    db,
    (connection: SshConnection) => {
      assert.equal(connection.target, ssh.target);
      const child = new FakeSsh();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    (child) => stopped.push(child as unknown as FakeSsh),
  );
  try {
    assert.equal(children.length, 1);
    children[0]!.emit("spawn");
    assert.deepEqual(manager.status(id), { status: "运行中", error: null });
    children[0]!.stderr.write("connect failed");
    children[0]!.emit("exit", 255, null);
    assert.deepEqual(manager.status(id), {
      status: "等待重连",
      error: "connect failed",
    });
    const view = hostView(hostRow(db, id), {
      polling: false,
      running: 0,
      tunnel: manager.status(id),
    });
    assert.equal(view.ssh?.agentServer, "http://127.0.0.1:14310");
    assert.equal(view.ssh?.error, "connect failed");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(children.length, 2);
    children[1]!.emit("spawn");
    assert.deepEqual(manager.status(id), {
      status: "运行中",
      error: "connect failed",
    });
    editHostConnection(db, id, { ...ssh, remotePort: 14311 });
    manager.refresh(hostRow(db, id));
    assert.equal(children.length, 3);
    assert.equal(hostRow(db, id).tunnel_remote_port, 14311);
    manager.remove(id);
    assert.deepEqual(stopped, [children[1], children[2]]);
  } finally {
    manager.close();
    db.close();
  }
});

test("损坏的 SSH 记录单条归档，其余隧道继续启动", () => {
  const db = new DatabaseSync(":memory:");
  ensureHostTables(db);
  const ssh = sshConnection({ ssh: "u@host", tunnel: "4310:14310" })!;
  const bad = addHost(db, { name: "坏记录", ssh }).id;
  const good = addHost(db, { name: "正常", ssh }).id;
  db.prepare("UPDATE hosts SET ssh_target='-oProxyCommand=bad' WHERE id=?").run(
    bad,
  );
  let started = 0;
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    const manager = new HostTunnels(
      db,
      () => {
        started++;
        return new FakeSsh() as unknown as ChildProcess;
      },
      () => undefined,
    );
    assert.equal(started, 1);
    assert.equal(manager.status(good)?.status, "连接中");
    assert.equal(hostRow(db, bad).ssh_target, null);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM host_tunnel_invalid").get()?.n,
      1,
    );
    assert.match(warnings.join("\n"), /SSH 配置无效/);
    manager.close();
  } finally {
    console.warn = original;
    db.close();
  }
});

test("启动时按页接管超过主机列表上限的隧道", () => {
  const db = new DatabaseSync(":memory:");
  ensureHostTables(db);
  const insert = db.prepare(
    "INSERT INTO hosts(name,kind,repos,created_at,updated_at,ssh_target,tunnel_local_port,tunnel_remote_port) VALUES (?,'remote','[]',0,0,'u@host',4310,14310)",
  );
  for (let n = 0; n < 501; n++) insert.run(`远程${n}`);
  let started = 0;
  const manager = new HostTunnels(
    db,
    () => {
      started++;
      return new FakeSsh() as unknown as ChildProcess;
    },
    () => undefined,
  );
  assert.equal(started, 501);
  manager.close();
  db.close();
});
