// Docker-only negative/positive probe of the per-container MCP stdio bridge.
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { ContainerMcpBridge } from "../server/container-mcp-bridge.ts";

const run = (args, timeout = 12_000) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout });
  if (result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed: ${(result.stderr ?? "").slice(-500)}`,
    );
  return result.stdout.trim();
};
const exec = promisify(execFile);
const name = `atrium167-bridge-${process.pid}`;
const web = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const call = JSON.parse(Buffer.concat(chunks).toString());
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: call.id,
      result: { marker: "host-side-only" },
    }),
  );
});
web.listen(0, "127.0.0.1");
await once(web, "listening");
const port = web.address().port;
let bridge;
try {
  const id = run([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "1000:1000",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--entrypoint",
    "sleep",
    "atrium-agent:167-probe",
    "120",
  ]);
  const hostSecret = `host-capability-${process.pid}`;
  let active = true;
  bridge = new ContainerMcpBridge(
    id,
    `http://127.0.0.1:${port}/mcp/${hostSecret}`,
    () => active,
  );
  await bridge.start();
  const call = `fetch('http://127.0.0.1:19671/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})}).then(async r=>console.log(r.status+' '+await r.text()))`;
  const good = (
    await exec("docker", ["exec", id, "node", "-e", call], { timeout: 12_000 })
  ).stdout.trim();
  if (
    !good.includes(
      '200 {"jsonrpc":"2.0","id":3,"result":{"marker":"host-side-only"}}',
    )
  )
    throw new Error(`forward failed: ${good}`);
  active = false;
  const stale = (
    await exec("docker", ["exec", id, "node", "-e", call], { timeout: 12_000 })
  ).stdout.trim();
  if (stale !== "403") throw new Error(`stale bridge accepted: ${stale}`);
  if (!(await bridge.drain())) throw new Error("bridge drain failed");
  const env = (await exec("docker", ["exec", id, "env"], { timeout: 5000 }))
    .stdout;
  const config = run(["inspect", id, "--format", "{{json .Config.Env}}"]);
  if (env.includes(hostSecret) || config.includes(hostSecret))
    throw new Error("host capability leaked to container");
  console.log(
    "BRIDGE_OK host-only URL; good MCP 200; old-generation 403; host capability absent from container env",
  );
} finally {
  bridge?.close();
  spawnSync("docker", ["rm", "-f", name], { timeout: 5000, stdio: "ignore" });
  const lingering = spawnSync("docker", ["inspect", name], {
    timeout: 5000,
    stdio: "ignore",
  });
  await new Promise((resolve) => web.close(resolve));
  if (lingering.status === 0)
    throw new Error("bridge probe container still exists");
}
