import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  cleanIdentityEnvironment,
  identityEnvironmentContext,
  identityScopedVariables,
  templateChoice,
} from "./identity-env.ts";
import { createApp } from "./app.ts";
import {
  claimService,
  dataDirectory,
  packageRoot,
  servicePort,
  serviceUrl,
} from "./service-state.ts";
import { ensureWebDist } from "./web-dist.ts";

await ensureWebDist(packageRoot);
const data = dataDirectory();
const lease = claimService(data, servicePort());
let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await app?.close();
    lease.release();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};
// Release only after application cleanup; crash records are reclaimed after PID exit.
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
try {
  // The CLI can check the Pi-home layout; the service also checks recorded paths
  // for identities whose directories have been moved outside that layout.
  const dbPath = join(data, "atrium.sqlite");
  let identityDirectories: string[] = [];
  if (process.env.PI_CODING_AGENT_DIR && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='agents'").get())
          identityDirectories = db
            .prepare(
              "SELECT agent_directory FROM agents WHERE agent_directory IS NOT NULL",
            )
            .all()
            .map((row) => String(row.agent_directory));
      } finally {
        db.close();
      }
    } catch (error) {
      console.warn("读取身份目录失败，继续按 Pi 目录判断：", error);
    }
  }
  const cleaned = cleanIdentityEnvironment(
    process.env,
    identityEnvironmentContext(
      process.env,
      process.env.ATRIUM_PI_HOME,
      identityDirectories,
    ),
  );
  const fromCli = (process.env.ATRIUM_IGNORED_IDENTITY_ENV ?? "")
    .split(",")
    .filter((key) =>
      identityScopedVariables.some((allowed) => allowed === key),
    );
  delete process.env.ATRIUM_IGNORED_IDENTITY_ENV;
  for (const key of cleaned.ignored) delete process.env[key];
  const ignored = [...new Set([...fromCli, ...cleaned.ignored])];
  if (ignored.length) console.log(`已忽略身份环境变量：${ignored.join(", ")}`);
  const template = templateChoice(process.env);
  console.log(`Pi 模板：${template.path}（来源：${template.source}）`);
  ({ app } = await createApp({
    data,
    webRoot: join(packageRoot, "dist"),
  }));
  const authorize = (value: string | undefined) => {
    const actual = Buffer.from(value ?? "");
    const expected = Buffer.from(`Bearer ${lease.record.token}`);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  const status = () => ({
    instance: lease.record.instance,
    pid: process.pid,
    stopping,
  });
  app.get("/api/service", (request, reply) => {
    if (!authorize(request.headers.authorization))
      return reply.code(401).send({ error: "服务控制凭据无效" });
    return status();
  });
  app.post("/api/service/stop", (request, reply) => {
    if (!authorize(request.headers.authorization))
      return reply.code(401).send({ error: "服务控制凭据无效" });
    reply.raw.once("finish", () => {
      void shutdown();
    });
    return status();
  });
  await app.listen({ port: lease.record.port, host: "127.0.0.1" });
  console.log(`Atrium → ${serviceUrl(lease.record)}\n数据：${data}`);
} catch (error) {
  console.error(error);
  await app?.close();
  lease.release();
  process.exitCode = 1;
}
