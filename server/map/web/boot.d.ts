// 与 boot.js 同名的类型声明，只给测试与类型检查用（浏览器直接加载 boot.js）。
export function emptyWorkers(): {
  role: null;
  rows: unknown[];
  pending: true;
};
export function fetchRootOrg(
  get: (path: string) => Promise<Record<string, unknown>>,
  key: string,
): Promise<{
  page: "node";
  node: unknown;
  team: unknown;
  org: {
    roles: unknown;
    skills: unknown;
    workers: ReturnType<typeof emptyWorkers>;
    leaders: unknown;
  };
}>;
export function keepWorkers<T>(next: T, prev: unknown): T;
export function withWorkers<T>(data: T, workers: object): T;
export function sseReloadOnHello(alreadyGreeted: boolean): boolean;
