import { posix, win32 } from "node:path";
import { Problem } from "../problem.ts";
import { TOOLS, type Tool } from "../tasks/adapters/types.ts";

/**
 * 执行机器（#358 第 1 步）的判定：连接状态、能不能接这件活、挑哪台、日志续传与重连对账。
 * 全是纯函数，不碰数据库、网络与进程；IO 在 model.ts（落库）、remote.ts（与代理往来）。
 */

/** 本机固定是 h1：服务启动时第一个登记，短号全局持久、不复用。 */
export const LOCAL_HOST = 1;
export const hostRef = (id: number) => `h${id}`;

export function parseHostRef(value: unknown, field = "host"): number {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^h([1-9][0-9]{0,8})$/.exec(text);
  if (!match)
    throw new Problem(
      400,
      `${field}: 应为主机短号，如 h2`,
      "usage",
      undefined,
      "atrium host ls",
    );
  return Number(match[1]);
}

/** `--avoid-host h3,h4`（或数组）：主机短号列表，去重、至多 20 个；空为 []。 */
export function avoidHostsOf(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  const items =
    typeof value === "string"
      ? value.split(/[,，\s]+/)
      : Array.isArray(value)
        ? value
        : null;
  const bad = () =>
    new Problem(400, "avoid_host: 应为主机短号，如 h3 或 h3,h4", "usage");
  if (!items) throw bad();
  const hosts: number[] = [];
  for (const item of items) {
    if (item === "") continue;
    const match =
      typeof item === "string"
        ? /^h([1-9][0-9]{0,8})$/.exec(item.trim())
        : null;
    if (!match) throw bad();
    const id = Number(match[1]);
    if (!hosts.includes(id)) hosts.push(id);
  }
  if (hosts.length > 20)
    throw new Problem(400, "avoid_host: 至多写 20 台主机", "usage");
  return hosts;
}

/** 库里存的避开主机（JSON 数组）；坏记录当没写。 */
export function storedHosts(text: string | null | undefined): number[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value)
      ? value.filter(
          (item): item is number => Number.isSafeInteger(item) && item > 0,
        )
      : [];
  } catch {
    return [];
  }
}

/** 代理多久没来就算离线：长轮询每轮最多 25 秒，留足余量。 */
export const ONLINE_MS = 60_000;

/** 任务行只标远程执行机器；名字来自主机账，心跳过期时提示离线。 */
export function runningHostLabel(
  id: number | null | undefined,
  host:
    | { name: string; joined_at: number | null; last_seen_at: number | null }
    | undefined,
  now: number,
): string | null {
  if (id == null || id === LOCAL_HOST) return null;
  if (!host) return hostRef(id);
  return connection({
    kind: "remote",
    joined: host.joined_at !== null,
    joinExpiresAt: null,
    lastSeenAt: host.last_seen_at,
    polling: false,
    now,
  }) === "offline"
    ? `${host.name}（离线）`
    : host.name;
}
/** 接入码有效期。 */
export const JOIN_TTL_MS = 30 * 60_000;

export type CliState = { installed: boolean; logged_in: boolean | null };

/** 代理上报的机器信息（接入与每次重连时更新）。 */
export type HostInfo = {
  hostname: string;
  os: string;
  arch: string;
  cpus: number;
  mem_mb: number;
  node: string;
  version: string;
  /** 代理的数据目录（绝对路径）：仓库、工作树、任务日志都在它下面。 */
  data_dir: string;
  clis: Partial<Record<Tool, CliState>>;
  /** 代理按自己的核数与环境算出的执行者上限；null 不限。 */
  max_workers: number | null;
  /** 代理能在那台挂组织技能（t232）；旧版代理不报，不给它下发技能。 */
  skills?: boolean;
};

/** 代理每轮长轮询带上的负载。 */
export type HostLoadReport = {
  load: number;
  running: number;
  /** 代理自己判断太忙时的原因；不忙为 null。 */
  busy: string | null;
};

export type Connection = "local" | "online" | "offline" | "pending" | "expired";

export function connection(input: {
  kind: "local" | "remote";
  joined: boolean;
  joinExpiresAt: number | null;
  lastSeenAt: number | null;
  /** 此刻有长轮询挂着。 */
  polling: boolean;
  now: number;
  /** 多久没来算离线；缺省 ONLINE_MS。 */
  onlineMs?: number;
}): Connection {
  if (input.kind === "local") return "local";
  if (!input.joined)
    return (input.joinExpiresAt ?? 0) > input.now ? "pending" : "expired";
  if (input.polling) return "online";
  return input.lastSeenAt !== null &&
    input.now - input.lastSeenAt <= (input.onlineMs ?? ONLINE_MS)
    ? "online"
    : "offline";
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** 状态的一句人话（host ls / show）。 */
export function connectionText(
  state: Connection,
  input: {
    paused: boolean;
    lastSeenAt: number | null;
    joinExpiresAt: number | null;
    now: number;
  },
): string {
  const base =
    state === "local"
      ? "本机"
      : state === "online"
        ? "在线"
        : state === "offline"
          ? input.lastSeenAt === null
            ? "离线"
            : `离线（${minutes(input.now - input.lastSeenAt)} 分钟前最后心跳）`
          : state === "pending"
            ? `待接入（接入码 ${minutes((input.joinExpiresAt ?? input.now) - input.now)} 分钟内有效）`
            : "接入码已过期";
  return input.paused ? `${base} · 已暂停接活` : base;
}

/** 挑主机时的一台候选。 */
export type HostCandidate = {
  id: number;
  kind: "local" | "remote";
  connection: Connection;
  paused: boolean;
  /** 远程主机上报的编码 CLI；本机为 null（本机的已装判定在挑执行者时做过）。 */
  clis: Partial<Record<Tool, CliState>> | null;
  /** 自动派活时这台能接的仓库（owner/name，`*` 表示全部）；显式 --host 不看。 */
  repos: readonly string[];
  running: number;
  max: number | null;
  /** 暂不能再派的原因（本机闸门、代理报的太忙）；能派为 null。 */
  busy: string | null;
  /** 能挂组织技能（t232）：本机总能；远程看代理上报。缺省按能。 */
  skills?: boolean;
};

export type HostNeed = {
  tool: Tool;
  /** 任务仓库的 owner/name；没有仓库为 null，仓库解析不出为 "?"。 */
  repo: string | null;
  urgent: boolean;
  /** 只能在本机跑的原因（如体验巡检要连回本机服务）；能去远程为 null。 */
  localOnly: string | null;
  /** 任务写了避开的主机（`--avoid-host`）；自动挑与指定都不派过去。 */
  avoid?: readonly number[];
  /** 要带组织技能（t232）：自动挑时优先能挂技能的主机。 */
  skills?: boolean;
};

export type HostFit =
  | { ok: true }
  /** never：这台接不了；later：接得了但现在满或太忙，排队等。 */
  | { ok: false; kind: "never" | "later"; reason: string };

export function repoAllowed(repos: readonly string[], repo: string | null) {
  if (repo === null) return true;
  return repos.some(
    (allowed) =>
      allowed === "*" || allowed.toLowerCase() === repo.toLowerCase(),
  );
}

/** 这台能不能接这件活；pinned 表示用户用 --host 指定了它（不看仓库白名单）。 */
export function hostFit(
  candidate: HostCandidate,
  need: HostNeed,
  pinned: boolean,
): HostFit {
  const ref = hostRef(candidate.id);
  const never = (reason: string): HostFit => ({
    ok: false,
    kind: "never",
    reason,
  });
  if (candidate.kind === "remote") {
    if (need.localOnly) return never(`${need.localOnly}，只能在本机跑`);
    if (
      candidate.connection === "pending" ||
      candidate.connection === "expired"
    )
      return never(`${ref} 还没接入`);
    if (candidate.connection === "offline") return never(`${ref} 离线`);
  }
  if (candidate.paused) return never(`${ref} 已暂停接活`);
  if (need.avoid?.includes(candidate.id))
    return never(`任务写了避开 ${ref}（--avoid-host）`);
  if (candidate.clis) {
    const cli = candidate.clis[need.tool];
    if (!cli?.installed) return never(`${ref} 上没装 ${need.tool}`);
    if (cli.logged_in === false)
      return never(`${ref} 上的 ${need.tool} 没登录`);
  }
  if (
    candidate.kind === "remote" &&
    !pinned &&
    !repoAllowed(candidate.repos, need.repo)
  )
    return never(
      need.repo === null
        ? `${ref} 不接这件活`
        : `${ref} 没登记能接仓库 ${need.repo}（atrium host add 时用 --repo 登记）`,
    );
  if (need.urgent) return { ok: true };
  if (candidate.busy)
    return { ok: false, kind: "later", reason: candidate.busy };
  if (candidate.max !== null && candidate.running >= candidate.max)
    return {
      ok: false,
      kind: "later",
      reason: `${ref} 同时最多跑 ${candidate.max} 个执行者，有执行者结束后自动拉起`,
    };
  return { ok: true };
}

export type HostChoice =
  | { kind: "run"; host: number }
  /** host：排队时钉在哪台（用户指定的）；自动挑的不钉，空出来时再挑。 */
  | { kind: "queue"; host: number | null; reason: string }
  | { kind: "refuse"; reason: string };

const utilization = (c: HostCandidate) =>
  c.max === null ? c.running / 1000 : c.running / Math.max(1, c.max);

/** 满了或太忙（紧急任务照样能派）。 */
export const crowded = (c: HostCandidate) =>
  !!c.busy || (c.max !== null && c.running >= c.max);

/**
 * 还有没有哪台能再接一件普通任务（本机或在线的远程、没暂停、不满不忙）；
 * 都没有时排队的普通任务不必一件件再挑主机（t229，drain 据此提前收手）。
 */
export const hasRoom = (candidates: readonly HostCandidate[]) =>
  candidates.some(
    (c) =>
      !c.paused &&
      (c.kind === "local" || c.connection === "online") &&
      !crowded(c),
  );

/**
 * 挑主机：指定了就只看那台（接不了拒绝，满了排队）；没指定在能接的里挑最空的，一样空时本机优先；
 * 紧急的先挑不满不忙的，同样时本机优先；任务写了避开的主机一律不派；
 * 要带组织技能的先挑能挂技能的（t232，挂不了的仍能接，只排在后面）；暂停接活的主机一律不选；
 * 都满或太忙时排队，本机的原因优先（和只有本机时的回执一致）。
 */
export function chooseHost(
  candidates: readonly HostCandidate[],
  need: HostNeed,
  pinned?: number,
): HostChoice {
  if (pinned !== undefined) {
    const candidate = candidates.find((c) => c.id === pinned);
    if (!candidate)
      return { kind: "refuse", reason: `没有主机 ${hostRef(pinned)}` };
    const fit = hostFit(candidate, need, true);
    if (fit.ok) return { kind: "run", host: candidate.id };
    if (fit.kind === "never") return { kind: "refuse", reason: fit.reason };
    return { kind: "queue", host: candidate.id, reason: fit.reason };
  }
  const fits = candidates.map((candidate) => ({
    candidate,
    fit: hostFit(candidate, need, false),
  }));
  // 紧急的：先挑不满不忙的，再挑本机（最稳），再比谁空。
  const ready = fits
    .filter((entry) => entry.fit.ok)
    .map((entry) => entry.candidate)
    .sort(
      (a, b) =>
        (need.urgent ? Number(crowded(a)) - Number(crowded(b)) : 0) ||
        (need.skills
          ? Number(b.skills !== false) - Number(a.skills !== false)
          : 0) ||
        (need.urgent
          ? Number(b.kind === "local") - Number(a.kind === "local")
          : 0) ||
        utilization(a) - utilization(b) ||
        Number(b.kind === "local") - Number(a.kind === "local") ||
        a.id - b.id,
    );
  if (ready.length) return { kind: "run", host: ready[0]!.id };
  const later = fits.filter(
    (
      entry,
    ): entry is {
      candidate: HostCandidate;
      fit: Extract<HostFit, { kind: string }>;
    } => !entry.fit.ok && entry.fit.kind === "later",
  );
  const local = later.find((entry) => entry.candidate.kind === "local");
  const first = local ?? later[0];
  if (first) return { kind: "queue", host: null, reason: first.fit.reason };
  const localNever = fits.find(
    (entry) => entry.candidate.kind === "local" && !entry.fit.ok,
  );
  return {
    kind: "queue",
    host: null,
    reason: `${localNever && !localNever.fit.ok ? localNever.fit.reason : "本机接不了"}，也没有别的主机能接，有主机能接时自动拉起`,
  };
}

// ---- 远程目录布局 ----

/** 代理数据目录下的布局：tasks/<id>/（提示词、日志）、repos/<克隆名>（仓库）、repos/<克隆名>-t<id>-<slug>（工作树）。 */
export type RemoteLayout = {
  dir: string;
  cwd: string;
  clone: string | null;
  worktree: string | null;
};

const flavor = (os: string) => (os === "win32" ? win32 : posix);

/** 克隆目录名：取远端地址的最后两段（owner-name），只留安全字符。 */
export function cloneName(url: string): string {
  const trimmed = url
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/i, "");
  const parts = trimmed
    .split(/[\\/:]+/)
    .filter(Boolean)
    .slice(-2);
  const name = parts
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return name || "repo";
}

export function remoteLayout(
  host: { os: string; data_dir: string },
  task: { id: number; slug: string | null },
  repoUrl: string | null,
): RemoteLayout {
  const path = flavor(host.os);
  const dir = path.join(host.data_dir, "tasks", String(task.id));
  if (!repoUrl || !task.slug)
    return { dir, cwd: path.join(dir, "work"), clone: null, worktree: null };
  const clone = remoteClone(host, repoUrl);
  const worktree = `${clone}-t${task.id}-${task.slug}`;
  return { dir, cwd: worktree, clone, worktree };
}

/** 代理数据目录下这个仓库的克隆（派活与按提交检查共用一份）。 */
export function remoteClone(
  host: { os: string; data_dir: string },
  url: string,
) {
  return flavor(host.os).join(host.data_dir, "repos", cloneName(url));
}

/** 服务派来的路径必须落在代理数据目录里（代理这一侧再查一遍，不信任何绝对路径）。 */
export function insideData(os: string, dataDir: string, target: string) {
  const path = flavor(os);
  if (!path.isAbsolute(target)) return false;
  const rel = path.relative(path.resolve(dataDir), path.resolve(target));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---- 日志续传 ----

/**
 * 代理传来一段日志（按远程日志文件的字节偏移）。expected 是服务已收到的位置。
 * 正好接上：整段写；有重叠（重传）：跳过已有的前缀；有缺口：拒收，让代理从 expected 重传。
 */
export function logAccept(
  expected: number,
  chunk: { offset: number; length: number },
): { kind: "append"; skip: number } | { kind: "gap" } | { kind: "stale" } {
  if (chunk.offset > expected) return { kind: "gap" };
  const skip = expected - chunk.offset;
  if (skip >= chunk.length) return { kind: "stale" };
  return { kind: "append", skip };
}

// ---- 重连对账 ----

export type ServerRun = { task: number; run: number };
export type AgentRun = {
  task: number;
  run: number;
  state: "running" | "exited";
};

/**
 * 代理重连（或服务重启后代理再来）时对账：
 * lost：账本说在这台上跑、代理却不知道这一轮（代理数据丢了），按退出情况不明收尾；
 * orphans：代理还在跑、账本已不认这一轮（任务已结束或换了一轮），让代理结束它。
 * 已退出的由代理的退出上报补传，不在这里处理。
 */
export function reconcile(
  server: readonly ServerRun[],
  agent: readonly AgentRun[],
): { lost: ServerRun[]; orphans: AgentRun[] } {
  const known = new Map(agent.map((run) => [run.task, run]));
  const expected = new Map(server.map((run) => [run.task, run.run]));
  return {
    lost: server.filter((run) => known.get(run.task)?.run !== run.run),
    orphans: agent.filter(
      (run) => run.state === "running" && expected.get(run.task) !== run.run,
    ),
  };
}

/** 代理断线重连的等待（秒）：1、2、4… 封顶 15 秒。 */
export function backoffMs(attempt: number) {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}

export const isKnownTool = (value: unknown): value is Tool =>
  typeof value === "string" && (TOOLS as readonly string[]).includes(value);
