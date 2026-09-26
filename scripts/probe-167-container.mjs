// Explicit isolated image probe. No real identity, model or account is mounted.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const root = mkdtempSync(join(tmpdir(), "atrium167-acp-"));
const identity = join(root, "identity"),
  desktop = join(root, "desktop");
const name = `atrium167-probe-${root.split("-").at(-1)}`;
mkdirSync(identity, { mode: 0o777 });
mkdirSync(desktop, { mode: 0o777 });
const args = [
  "run",
  "--rm",
  "-i",
  "--name",
  name,
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "128",
  "--memory",
  "512m",
  "--cpus",
  "1",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
  "--user",
  "1000:1000",
  "--workdir",
  "/workspace",
  "-v",
  `${identity}:/identity:rw`,
  "-v",
  `${desktop}:/workspace:rw`,
  "-e",
  "HOME=/identity",
  "-e",
  "PI_CODING_AGENT_DIR=/identity",
  "-e",
  "PI_ACP_DIR=/identity/.acp",
  "-e",
  "PI_MCP_TOOL_EXPOSURE=proxy-only",
  "-e",
  "PI_ACP_PI_COMMAND=/opt/atrium/node_modules/.bin/pi",
  "atrium-agent:167-probe",
];
const child = spawn("docker", args, {
  env: { PATH: process.env.PATH },
  stdio: "pipe",
});
const closed = new Promise((resolve) => child.once("close", resolve));
let stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
const connection = client({ name: "atrium-167-probe" })
  .onRequest("session/request_permission", () => ({
    outcome: { outcome: "cancelled" },
  }))
  .onNotification("session/update", () => undefined)
  .connect(
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
const deadline = setTimeout(
  () => connection.close(new Error("probe timeout")),
  20_000,
).unref();
try {
  const info = await connection.agent.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "atrium-167-probe" },
  });
  if (!info._meta?.["pi-acp/runtime/v1"] || !info._meta?.["pi-acp/identity/v1"])
    throw new Error("ACP capabilities missing");
  console.log("ACP_INIT_OK no model, no account, no live identity");
} catch (error) {
  console.error("ACP_INIT_FAILED", error, stderr.slice(-1000));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  connection.close();
  child.kill("SIGTERM");
  await closed;
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 5000 });
  const lingering = spawnSync("docker", ["inspect", name], {
    stdio: "ignore",
    timeout: 5000,
  });
  if (lingering.status === 0) throw new Error("probe container still exists");
  rmSync(root, { recursive: true, force: true });
}
