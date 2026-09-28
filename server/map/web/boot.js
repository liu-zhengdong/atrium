// 全景网页的取数策略：组织根首屏立刻要的接口，以及连上 SSE 时要不要重取。
// 不碰 DOM。执行者统计（/workers，交付聚合）不挡首屏，画完再补。

export const emptyWorkers = () => ({
  role: null,
  rows: [],
  pending: true,
});

/**
 * 组织根页：节点、专员、技能、负责人立刻取；执行者统计标成 pending，稍后补。
 * `get` 与网页里的同名函数一样，路径相对于 `/api/map`。
 */
export async function fetchRootOrg(get, key) {
  const [node, roles, skills, leaders] = await Promise.all([
    get(`/nodes/${encodeURIComponent(key)}`),
    get("/specialists"),
    get("/skills"),
    get("/leaders"),
  ]);
  return {
    page: "node",
    node,
    team: roles.specialists,
    org: {
      roles: roles.specialists,
      skills: skills.skills,
      workers: emptyWorkers(),
      leaders: leaders.leaders,
    },
  };
}

/** 刷新时留下上次的执行者统计，避免页签闪成「还没有」。 */
export function keepWorkers(next, prev) {
  if (!next?.org || !prev?.org?.workers || prev.org.workers.pending)
    return next;
  return { ...next, org: { ...next.org, workers: prev.org.workers } };
}

export function withWorkers(data, workers) {
  if (!data?.org) return data;
  return {
    ...data,
    org: { ...data.org, workers: { ...workers, pending: false } },
  };
}

/** 第一次 hello 只点亮顶栏；重连才整页重取（可能漏了 changed）。 */
export const sseReloadOnHello = (alreadyGreeted) => !!alreadyGreeted;
