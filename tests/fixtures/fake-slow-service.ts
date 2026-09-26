// 假服务（service-start.test.ts）：按 ATRIUM_FAKE_* 模拟慢启动、启动失败或旧版本服务。
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { claimService, servicePort } from "../../server/service-state.ts";

const data = process.env.ATRIUM_DATA!;
if (process.env.ATRIUM_FAKE_EXIT) {
  console.error("fake service: 配置损坏，无法启动");
  process.exit(Number(process.env.ATRIUM_FAKE_EXIT));
}
// 慢启动期间不写日志：只要进程还活着就该继续等。
await delay(Number(process.env.ATRIUM_FAKE_DELAY_MS ?? 0));
const port = servicePort();
const lease = claimService(data, port);
const version = process.env.ATRIUM_FAKE_VERSION ?? "0.0.1";
const send = (
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${lease.record.token}`) {
    if (request.url?.startsWith("/api/service"))
      return send(response, 401, { error: "服务控制凭据无效" });
  }
  if (request.method === "GET" && request.url === "/api/service")
    return send(response, 200, {
      instance: lease.record.instance,
      pid: process.pid,
      stopping: false,
      version,
      userAuth: "user-v1",
    });
  // 旧服务没登记的服务控制接口落到用户认证（与真实旧服务一致）。
  if (request.url?.startsWith("/api/service/"))
    return send(response, 401, {
      error:
        "用户认证失效；请运行 atrium auth rotate（确认 ATRIUM_DATA 指向当前数据目录）",
      code: "auth_required",
    });
  return send(response, 404, { error: "接口不存在", code: "not_found" });
});
server.listen(port, "127.0.0.1");
console.error(`fake service ready on ${port}`);
const stop = () => {
  lease.release();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
