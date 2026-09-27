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
  "GET /map/format.js",
  "GET /map/style.css",
]);
const mapReadRoutes = new Set([
  "GET /api/map/tree",
  "GET /api/map/nodes/:id",
  "GET /api/map/now",
  "GET /api/map/stream",
  "GET /api/map/roles",
  "GET /api/map/roles/:id",
  "GET /api/map/skills",
  "GET /api/map/workers",
  "GET /api/map/workers/:id",
  "GET /api/map/leaders",
  "GET /api/map/leaders/:id",
]);

export type AuthPolicy =
  "separate" | "user" | "map-login" | "map-page" | "map-read";
export function authPolicy(method: string, route: string): AuthPolicy {
  const key = `${method === "HEAD" ? "GET" : method} ${route}`;
  if (separatelyAuthenticatedRoutes.has(key)) return "separate";
  if (mapLoginRoutes.has(key)) return "map-login";
  if (mapPageRoutes.has(key)) return "map-page";
  if (mapReadRoutes.has(key)) return "map-read";
  return "user";
}
