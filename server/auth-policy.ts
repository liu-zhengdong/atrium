// Authorization is based on Fastify's matched route, never on the raw URL.
// New routes require the user credential unless deliberately listed here.
const separatelyAuthenticatedRoutes = new Set([
  "POST /api/auth/rotate", // user or local instance-control credential
  "GET /api/service",
  "GET /api/service/health",
  "POST /api/service/prepare-restart",
  "POST /api/service/stop",
]);

export type AuthPolicy = "separate" | "user";
export function authPolicy(method: string, route: string): AuthPolicy {
  const key = `${method === "HEAD" ? "GET" : method} ${route}`;
  return separatelyAuthenticatedRoutes.has(key) ? "separate" : "user";
}
