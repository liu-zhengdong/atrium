// Authorization is based on Fastify's matched route, never on the raw URL.
// New routes require the user credential unless deliberately listed here.
const publicRoutes = new Set([
  "GET /auth/claim/:code", // one-use login code checked by the handler
  "GET /api/auth/session", // only reports whether the supplied cookie is valid
  "POST /hooks/:ref/:token", // per-agent push token checked by the handler
  "GET /*", // static Web shell and assets; API misses are handled as 404
]);
const separatelyAuthenticatedRoutes = new Set([
  "POST /api/auth/rotate", // user or local instance-control credential
  "GET /api/service",
  "GET /api/service/health",
  "POST /api/service/prepare-restart",
  "POST /api/service/restart-when-idle",
  "POST /api/service/probe",
  "POST /api/service/wake",
  "POST /api/service/stop",
  "POST /mcp/:id", // identity credential checked in the MCP handler
]);

export type AuthPolicy = "public" | "separate" | "user";
export function authPolicy(method: string, route: string): AuthPolicy {
  const key = `${method === "HEAD" ? "GET" : method} ${route}`;
  if (publicRoutes.has(key)) return "public";
  if (separatelyAuthenticatedRoutes.has(key)) return "separate";
  return "user";
}

// A miss must not turn into an unauthenticated SPA 200 for encoded API paths.
export function protectedNamespace(rawUrl: string): boolean {
  let path = rawUrl.split("?", 1)[0]!;
  for (let depth = 0; depth < 3; depth++) {
    try {
      path = decodeURIComponent(path);
      path = new URL(path.replace(/^\/+/, "/"), "http://localhost").pathname;
    } catch {
      return true;
    }
    if (/^\/(api|mcp)(\/|;|$)/i.test(path)) return true;
  }
  return false;
}
