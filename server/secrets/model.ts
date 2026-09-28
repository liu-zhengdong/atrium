import { Problem } from "../problem.ts";
import { workerAllowed } from "../tasks/dispatch/worker-env.ts";

/**
 * 凭据（t194 第 3 步）：挂在组织节点上的令牌、密码这类值（如机器人 token），按「节点 + 名称」找，名称就是注入执行者时的环境变量名。
 * 值只存数据目录凭据区（store.ts），不进日志、事件、提示词、网页；任务声明要用（`task add --secret 名称`）时，
 * 派活那一刻按名称逐个注入执行者环境，是白名单环境之外的唯一例外。
 * 这里只放纯函数（穷举测试）：名称与值校验、按节点链找、合进环境、清理线索、提示词段落。
 */

export const SECRET_NAME_MAX = 64;
/** 单个值的上限：令牌、密码、私钥片段都够用；更大的东西放资料。 */
export const SECRET_VALUE_MAX = 16 * 1024;
/** 一件任务最多声明几个凭据。 */
export const TASK_SECRETS_MAX = 10;
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

const DAY = 24 * 60 * 60 * 1000;
/** 清理线索的门槛（u1 09-28 定）：90 天没用。 */
export const STALE_MS = 90 * DAY;

const usage = (message: string, next?: string) =>
  new Problem(400, message, "usage", undefined, next);

/** 运行时自己设的、会改变执行者或它拉起的程序行为的前缀：不许拿来当凭据名。 */
const RESERVED_PREFIXES = [
  "ATRIUM_",
  "CLAUDE_CODE_",
  "PI_",
  "HERDR_",
  "NODE_",
  "GIT_",
  "LD_",
  "DYLD_",
] as const;
const RESERVED_NAMES = new Set([
  "CLAUDECODE",
  "NO_COLOR",
  "PAGER",
  "GH_PROMPT_DISABLED",
  "BASH_ENV",
  "ENV",
]);

/**
 * 凭据名称的毛病；没毛病返回 null。纯函数。
 * 名称就是环境变量名：大写字母开头，只含大写字母、数字、下划线（三平台一致，Windows 不分大小写也不撞）；
 * 执行者环境本来就有的系统变量、运行时自己设的与会改变程序加载方式的（ATRIUM_*、NODE_*、LD_* 等）不许用。
 */
export function secretNameProblem(name: string): string | null {
  if (!name) return "名称不能为空";
  if (name.length > SECRET_NAME_MAX)
    return `名称不能超过 ${SECRET_NAME_MAX} 个字符`;
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    return `名称应为大写字母开头、只含大写字母数字下划线的环境变量名（如 TELEGRAM_BOT_TOKEN），${name} 不是`;
  if (
    workerAllowed(name, "linux") ||
    workerAllowed(name, "win32") ||
    RESERVED_NAMES.has(name)
  )
    return `是执行者环境本来就有或运行时自己设的变量（${name}），换个名字`;
  const prefix = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  if (prefix)
    return `前缀 ${prefix}* 留给运行时或会改变程序加载方式，换个名字（${name}）`;
  return null;
}

export function secretName(value: unknown, field = "名称"): string {
  const text = typeof value === "string" ? value.trim() : "";
  const problem = secretNameProblem(text);
  if (problem) throw usage(`${field}: ${problem}`);
  return text;
}

/** `--secret A,B`：去重，至多 TASK_SECRETS_MAX 个；空值表示不用凭据。纯函数。 */
export function parseSecretNames(value: unknown, field = "secret"): string[] {
  if (value === undefined || value === null || value === "") return [];
  const items = (
    Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[,，\s]+/)
        : [value]
  )
    .map((item) => (typeof item === "string" ? item.trim() : item))
    .filter((item) => item !== "");
  const names: string[] = [];
  for (const item of items) {
    const name = secretName(item, field);
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > TASK_SECRETS_MAX)
    throw usage(`${field}: 一件任务至多用 ${TASK_SECRETS_MAX} 个凭据`);
  return names;
}

/**
 * 值校验（纯函数）：去掉结尾一个换行（echo、回车带进来的），不能为空、不能含空字符（进不了环境变量）、有上限。
 * 报错一律不带值本身。
 */
export function secretValue(value: unknown): string {
  if (typeof value !== "string") throw usage("值: 应为文本");
  const text = value.replace(/\r?\n$/, "");
  if (!text) throw usage("值: 是空的；从标准输入给值");
  if (text.includes("\0")) throw usage("值: 不能含空字符");
  if (Buffer.byteLength(text) > SECRET_VALUE_MAX)
    throw usage(
      `值: 超过 ${SECRET_VALUE_MAX / 1024} KB；更大的东西挂成资料（atrium material add）`,
    );
  return text;
}

export type SecretCandidate = { id: number; node_id: number; name: string };
export type Resolved = {
  found: SecretCandidate[];
  missing: string[];
};

/**
 * 按节点链找凭据（纯函数）：chain 是本节点在前、逐级往上的节点 id；同名的取最近一层的。
 * candidates 只给没归档的。找到的按 names 的顺序给。
 */
export function resolveSecrets(
  names: readonly string[],
  chain: readonly number[],
  candidates: readonly SecretCandidate[],
): Resolved {
  const depth = new Map(chain.map((id, i) => [id, i]));
  const best = new Map<string, SecretCandidate>();
  for (const c of candidates) {
    const d = depth.get(c.node_id);
    if (d === undefined) continue;
    const had = best.get(c.name);
    if (!had || d < depth.get(had.node_id)!) best.set(c.name, c);
  }
  const found: SecretCandidate[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const hit = best.get(name);
    if (hit) found.push(hit);
    else missing.push(name);
  }
  return { found, missing };
}

/**
 * 把凭据合进执行者环境（纯函数）：白名单环境之外的唯一例外，按名称逐个放行；
 * 名称再过一遍校验，免得把 PATH、ATRIUM_WORKER 这类盖掉（代理那一侧收到的也走这里）。
 */
export function withSecrets(
  env: NodeJS.ProcessEnv,
  secrets: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  if (!secrets) return env;
  const out = { ...env };
  for (const [name, value] of Object.entries(secrets)) {
    const problem = secretNameProblem(name);
    if (problem) throw new Error(`凭据名称不合规：${problem}`);
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error(`凭据 ${name} 的值无效`);
    out[name] = value;
  }
  return out;
}

/** 清理线索要的事实（store 取，这里只判）。 */
export type SecretFacts = {
  archived_at: number | null;
  keep_at: number | null;
  updated_at: number;
  last_used_at: number | null;
};

/**
 * 疑似没用（纯函数）：已归档、leader 写过「留」的不提；90 天没用（从没用过按最后设值的时间算）的提。
 */
export function staleSecret(
  facts: SecretFacts,
  now: number,
): { reason: string } | null {
  if (facts.archived_at !== null || facts.keep_at !== null) return null;
  const since = Math.max(facts.last_used_at ?? 0, facts.updated_at);
  if (now - since < STALE_MS) return null;
  const days = Math.floor((now - since) / DAY);
  return {
    reason: `${facts.last_used_at === null ? "设上后 " : ""}${days} 天没用过`,
  };
}

/** 派活提示词里的一段：只给名称与挂在哪，告诉执行者怎么用、不许外泄。纯函数。 */
export function secretSection(
  list: readonly { name: string; node: string }[],
): string | undefined {
  if (!list.length) return undefined;
  return [
    "下面这些凭据已按名称作为环境变量给你（只在本次运行的进程里有）：",
    ...list.map((s) => `- \`${s.name}\`（挂在 ${s.node}）`),
    "用 `$名称` 引用；值不要打印、回显，不要写进文件、日志、提交、PR、issue 或回复。",
  ].join("\n");
}
