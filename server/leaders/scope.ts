/**
 * leader 的权限边界（纯函数，穷举测试）。leader 进程拿的是服务签发的 leader 令牌，
 * 服务端按「路由 → 规则 → 作用范围」判定，不靠提示词自律；没列出的写接口一律拒绝。
 *
 * 可以：在本节点及子节点建任务、派活、重派、捎话、停、记备注、请专员与会审；任务牵涉到自己负责的部分时，记备注与捎话；改本节点及子节点的要点、阶段与全景人话字段；
 * 写自己的备忘与决定记录；给子节点指派下层 leader；确认投给自己的事件；上交。
 * 不可以：动别的节点的任务、改章程与边界预算、建删节点、拍板会审、改技能、清额度、登记 leader 等。
 */

export type LeaderRule =
  | "read"
  | "task-create"
  | "task"
  | "task-remark"
  | "task-patch"
  | "review-create"
  | "point"
  | "stages"
  | "node-edit"
  | "map-edit"
  | "leader-edit"
  | "self"
  | "escalate"
  | "events-ack"
  | "patrol-decide"
  | "deny";

const RULES: Record<string, LeaderRule> = {
  "POST /api/tasks": "task-create",
  "PATCH /api/tasks/:id": "task-patch",
  "POST /api/tasks/:id/note": "task-remark",
  "POST /api/tasks/:id/tell": "task-remark",
  "POST /api/tasks/:id/run": "task",
  "POST /api/tasks/:id/stop": "task",
  "POST /api/reviews": "review-create",
  "POST /api/events/ack": "events-ack",
  "POST /api/org/nodes/:id/points": "point",
  "PATCH /api/org/points/:id": "point",
  "DELETE /api/org/points/:id": "point",
  "PUT /api/org/nodes/:id/stages": "stages",
  "PATCH /api/org/nodes/:id": "node-edit",
  "PATCH /api/map/nodes/:id": "map-edit",
  "PATCH /api/leaders/:id": "leader-edit",
  // 备忘与决定记录按 ?as= 定主人，guard 已把它锁成自己，不必再判。
  "PUT /api/memo": "self",
  "POST /api/decisions": "self",
  "POST /api/decisions/:id/supersede": "self",
  "POST /api/leaders/:id/escalate": "escalate",
  "POST /api/patrol/findings/:id/decide": "patrol-decide",
};

/** 读接口都放行（订阅者名另由 asVerdict 锁定为自己）；写接口只认表里列出的。 */
export function leaderRule(method: string, route: string): LeaderRule {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return "read";
  return RULES[`${verb} ${route}`] ?? "deny";
}

export const ESCALATE_HINT = "atrium leader escalate --kind beyond 说明";

/** 越权回执：说清楚不能做什么，并提示上交。 */
export const denied = (leader: string, what: string) =>
  `${leader} 无权${what}；需要的话上交秘书：${ESCALATE_HINT}`;

/** 拒绝写接口时的说明：常见几类给具体原因。 */
export function denyReason(leader: string, method: string, route: string) {
  const key = `${method.toUpperCase()} ${route}`;
  if (key === "PUT /api/org/nodes/:id/docs/:doc" || route.endsWith("/revert"))
    return denied(
      leader,
      "改章程、边界与预算（改阶段用 atrium org stages 节点 --file 文件）",
    );
  if (key === "POST /api/reviews/:id/decide")
    return denied(leader, "拍板上交的会审（那是用户的决定）");
  if (key === "POST /api/org/nodes" || key === "POST /api/map/nodes")
    return denied(leader, "新建组织节点");
  if (route.startsWith("/api/quota")) return denied(leader, "改额度标记");
  if (route.startsWith("/api/skill")) return denied(leader, "改组织技能");
  if (route.startsWith("/api/workers/profiles"))
    return denied(leader, "改执行者档案");
  if (key === "POST /api/leaders") return denied(leader, "登记新的 leader");
  if (route.startsWith("/api/hosts"))
    return denied(leader, "登记、移除或暂停执行机器");
  return denied(leader, `调用 ${key}`);
}

/** 订阅者名（?as=）：不给就是自己，给了只能是自己。 */
export function asVerdict(leader: string, as: string | undefined) {
  if (as === undefined || as === "" || as === leader) return null;
  return denied(leader, `以 ${as} 的名义操作，只能用自己（${leader}）`);
}

export type ScopeNode = {
  id: number;
  parent_id: number | null;
  leader: string | null;
  archived_at: number | null;
};

/** 作用范围：leader 负责的（未归档）节点及其全部子节点。 */
export function scopeOf(list: readonly ScopeNode[], leader: string) {
  const led = new Set(
    list
      .filter((n) => n.leader === leader && n.archived_at === null)
      .map((n) => n.id),
  );
  const scope = new Set<number>();
  const visit = (id: number) => {
    if (scope.has(id)) return;
    scope.add(id);
    for (const child of list) if (child.parent_id === id) visit(child.id);
  };
  for (const id of led) visit(id);
  return { led, scope };
}

/** 一处要落在范围里的引用：what 是人话（如「任务 t5 的归属部分 o3」）。 */
export type ScopeCheck = { what: string; node: number | null };

/** 引用逐条落在范围里才放行；node 为 null 表示查不到归属，一律算范围外。 */
export function scopeVerdict(
  leader: string,
  scope: ReadonlySet<number>,
  checks: readonly ScopeCheck[],
) {
  for (const check of checks)
    if (check.node === null || !scope.has(check.node))
      return denied(leader, `动${check.what}：不在你负责的部分里`);
  return null;
}

/**
 * 记备注、捎话（#373）：任务在范围里照常；不在时，任务牵涉的部分（显式或自动）有一个在范围里也行——
 * 被牵涉部分的 leader 可以说话，但不能派、停、改。
 */
export function remarkVerdict(
  leader: string,
  scope: ReadonlySet<number>,
  check: ScopeCheck,
  involved: readonly number[],
) {
  if (involved.some((id) => scope.has(id))) return null;
  return scopeVerdict(leader, scope, [check]);
}

/** 负责人（owner）：不写或写自己；不能把事件改投给别人。 */
export function ownerVerdict(leader: string, owner: unknown) {
  if (owner === undefined || owner === null || owner === "" || owner === leader)
    return null;
  return denied(leader, `把任务负责人设为 ${String(owner)}`);
}

/** 改节点：只允许给子节点（负责节点以下）换 leader。 */
export function nodeEditVerdict(input: {
  leader: string;
  keys: readonly string[];
  node: number;
  led: ReadonlySet<number>;
  scope: ReadonlySet<number>;
}) {
  const extra = input.keys.filter((k) => k !== "leader" && k !== "reason");
  if (extra.length || !input.keys.includes("leader"))
    return denied(
      input.leader,
      `改节点的${extra.length ? ` ${extra.join("、")} ` : "其他字段"}（只能给子节点指派 leader）`,
    );
  if (input.led.has(input.node))
    return denied(input.leader, "改自己负责的节点的 leader");
  if (!input.scope.has(input.node))
    return denied(input.leader, "给不在你负责部分里的节点指派 leader");
  return null;
}

/** 全景人话字段可改；--detail 会改章程正文，不行。 */
export function mapEditVerdict(leader: string, keys: readonly string[]) {
  if (keys.includes("detail") || keys.includes("rev"))
    return denied(leader, "改章程正文（--detail）");
  return null;
}

/** 自己的登记：只能改自己的备忘。 */
export function leaderEditVerdict(
  leader: string,
  target: string,
  keys: readonly string[],
) {
  if (target !== leader) return denied(leader, `改 ${target} 的登记`);
  const extra = keys.filter((k) => k !== "memo");
  if (extra.length)
    return denied(leader, `改自己的 ${extra.join("、")}（只能改备忘）`);
  return null;
}

export function escalateVerdict(leader: string, target: string) {
  return target === leader ? null : denied(leader, `替 ${target} 上交`);
}

/** 确认事件：只能确认投给自己的。 */
export function ackVerdict(
  leader: string,
  subscribers: readonly (string | null)[],
) {
  const others = subscribers.filter((s) => s !== null && s !== leader);
  return others.length
    ? denied(leader, `确认投给 ${[...new Set(others)].join("、")} 的事件`)
    : null;
}
