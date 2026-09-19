import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { createApp } from "./app.ts";
import {
  claimService,
  dataDirectory,
  packageRoot,
  servicePort,
  serviceUrl,
} from "./service-state.ts";

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
