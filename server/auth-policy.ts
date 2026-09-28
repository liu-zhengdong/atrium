// Authorization is based on Fastify's matched route, never on the raw URL.
// New routes require the user credential unless deliberately listed here.
const separatelyAuthenticatedRoutes = new Set([
  "POST /api/auth/rotate", // user or local instance-control credential
  "GET /api/service",
  "GET /api/service/info", // 免认证：只回服务身份与数据目录，供撞端口时说明（t71）
  "GET /api/service/health",
  "POST /api/service/prepare-restart",
  "POST /api/service/stop",
]);
// 全景网页（#322）：一次性链接自己校验 code；页面与静态文件只认本机会话 cookie；
// 只读接口用户令牌或本机会话都行。写接口不在这里，只认用户令牌。
const mapLoginRoutes = new Set(["GET /map/login"]);
const mapPageRoutes = new Set([
  "GET /map",
  "GET /map/app.js",
  "GET /map/boot.js",
  "GET /map/format.js",
  "GET /map/style.css",
]);
const mapReadRoutes = new Set([
  "GET /api/map/tree",
  "GET /api/map/nodes/:id",
  "GET /api/map/now",
  "GET /api/map/stream",
  "GET /api/map/specialists",
  "GET /api/map/specialists/:id",
  "GET /api/map/skills",
  "GET /api/map/workers",
  "GET /api/map/workers/:id",
  "GET /api/map/leaders",
  "GET /api/map/leaders/:id",
  "GET /api/map/decisions",
]);

// 拍板选项单：用户令牌，或本机全景网页会话（须带同源 Origin，cookie 为 SameSite=Strict）。
// 只有这两条写接口对网页开放；leader 令牌另由 leaders/guard.ts 与 choices/store.ts 按节点设置判。
const mapWriteRoutes = new Set([
  "POST /api/choices/:id/pick",
  "POST /api/choices/:id/pass",
]);

// 远程主机的代理（#358）：接入认一次性接入码（请求体里），其余认主机令牌，都由路由自己校验；
// 代理经用户自己的转发或 VPN 连进来，Host 不一定是本机名。
const agentRoutes = new Set([
  "POST /api/agent/join",
  "POST /api/agent/hello",
  "POST /api/agent/poll",
  "POST /api/agent/reply",
  "POST /api/agent/log",
  "POST /api/agent/exit",
  "POST /api/agent/check-log",
  "POST /api/agent/quota",
]);

export type AuthPolicy =
  | "separate"
  | "user"
  | "map-login"
  | "map-page"
  | "map-read"
  | "map-write"
  | "agent";
export function authPolicy(method: string, route: string): AuthPolicy {
  const key = `${method === "HEAD" ? "GET" : method} ${route}`;
  if (separatelyAuthenticatedRoutes.has(key)) return "separate";
  if (agentRoutes.has(key)) return "agent";
  if (mapLoginRoutes.has(key)) return "map-login";
  if (mapPageRoutes.has(key)) return "map-page";
  if (mapReadRoutes.has(key)) return "map-read";
  if (mapWriteRoutes.has(key)) return "map-write";
  return "user";
}
