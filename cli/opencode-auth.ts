import { isDeepStrictEqual } from "node:util";

/**
 * 秘书 opencode 数据目录里的凭据该放什么（#318 遗留）：纯函数，读写见 opencode-serve.ts。
 *
 * 只从用户目录带过来 API key 类条目（auth.json 的 `type: "api"`、`type: "wellknown"`）。OAuth 登录不带：
 * 提供商的刷新令牌多是一次性的，秘书一刷新，用户自己的登录就可能失效。mcp-auth.json 在 opencode 里
 * 只存 MCP 的 OAuth 状态（tokens、clientInfo、codeVerifier），同一条规则下实际一条都不带；拿不准的形状也不带。
 *
 * 秘书目录里原有的条目：上次从用户那边同步的（`synced`）和与用户条目共享令牌的（#318 整份拷过来的 OAuth）
 * 都按这次的结果重算；其余是用户在秘书目录里单独登录的，保留，但同名的 API key 以用户目录为准。
 */

export type Skipped = { name: string; reason: "oauth" | "uncertain" };

export type AuthPlan = {
  /** 秘书那份的新内容；undefined 表示不动（用户那份坏了，没法判断）。 */
  content?: string;
  /** 这次从用户目录带过来的条目名，下次据此认出「上次同步的」。 */
  synced: string[];
  /** 用户目录里没带过来的条目。 */
  skipped: Skipped[];
  /** 坏文件等问题，给人看。 */
  problems: string[];
};

type Entries = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value.length > 0;

/** API key 类条目：opencode 的 `api`（key）与 `wellknown`（key + token，无刷新）。 */
export function isApiKeyEntry(entry: unknown): boolean {
  if (!isObject(entry)) return false;
  if (entry.type === "api") return nonEmpty(entry.key);
  if (entry.type === "wellknown")
    return nonEmpty(entry.key) && nonEmpty(entry.token);
  return false;
}

function classify(entry: unknown): Skipped["reason"] | undefined {
  if (isApiKeyEntry(entry)) return undefined;
  if (
    isObject(entry) &&
    (entry.type === "oauth" ||
      "refresh" in entry ||
      "tokens" in entry ||
      "clientInfo" in entry ||
      "codeVerifier" in entry)
  )
    return "oauth";
  return "uncertain";
}

/** 条目里的令牌字符串（auth.json 的 refresh/access，mcp-auth.json 的 tokens.*）。 */
function secrets(entry: unknown): string[] {
  if (!isObject(entry)) return [];
  const found: unknown[] = [entry.refresh, entry.access, entry.key];
  if (isObject(entry.tokens))
    found.push(entry.tokens.refreshToken, entry.tokens.accessToken);
  return found.filter(nonEmpty) as string[];
}

/** 秘书那份里的条目是不是从用户那份拷过来的：内容相同或共享令牌。 */
function copiedFrom(entry: unknown, source: unknown) {
  if (source === undefined) return false;
  if (isDeepStrictEqual(entry, source)) return true;
  const theirs = new Set(secrets(source));
  return secrets(entry).some((secret) => theirs.has(secret));
}

function parse(text: string): Entries | string {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : "不是 JSON 对象";
  } catch {
    return "不是合法 JSON";
  }
}

/**
 * 算出秘书那份凭据文件的新内容。source、target 为文件原文，没有文件时 undefined；
 * previous 为上次同步过来的条目名。target 坏了按空处理（调用方先把坏文件挪开）。
 */
export function planAuthFile(
  file: string,
  source: string | undefined,
  target: string | undefined,
  previous: readonly string[] = [],
): AuthPlan {
  const problems: string[] = [];
  let theirs: Entries = {};
  if (source !== undefined) {
    const parsed = parse(source);
    if (typeof parsed === "string")
      return {
        synced: [...previous],
        skipped: [],
        problems: [
          `用户的 opencode ${file} ${parsed}，这次不同步，秘书那份不动`,
        ],
      };
    theirs = parsed;
  }
  let ours: Entries = {};
  if (target !== undefined) {
    const parsed = parse(target);
    if (typeof parsed === "string")
      problems.push(`秘书的 ${file} ${parsed}，已挪开重建`);
    else ours = parsed;
  }
  const result: Entries = {};
  for (const [name, entry] of Object.entries(ours)) {
    if (previous.includes(name)) continue;
    if (copiedFrom(entry, theirs[name])) continue;
    result[name] = entry;
  }
  const synced: string[] = [];
  const skipped: Skipped[] = [];
  for (const [name, entry] of Object.entries(theirs)) {
    const reason = classify(entry);
    if (reason) {
      skipped.push({ name, reason });
      continue;
    }
    result[name] = entry;
    synced.push(name);
  }
  return {
    content: `${JSON.stringify(result, null, 2)}\n`,
    synced,
    skipped,
    problems,
  };
}

/** 秘书用不上的提供商：用户那边只有 OAuth 登录，秘书目录里也没有它的凭据。 */
export function oauthOnly(plan: AuthPlan): string[] {
  if (plan.content === undefined) return [];
  const present = parse(plan.content) as Entries;
  return plan.skipped
    .filter((item) => item.reason === "oauth" && !(item.name in present))
    .map((item) => item.name);
}

/**
 * 秘书界面启动时的提示。知道所用模型（`提供商/模型`）时，只在它的提供商只有 OAuth 凭据时提示；
 * 不知道模型时，列出只有 OAuth 的提供商。
 */
export function oauthHint(
  home: string,
  providers: readonly string[],
  model?: string,
): string | undefined {
  const how = `请给秘书换用有 API key 的提供商（opencode 界面里 /models），或在秘书目录里单独登录：XDG_DATA_HOME=${home} opencode auth login`;
  if (model) {
    const provider = model.split("/", 1)[0]!;
    if (!providers.includes(provider)) return undefined;
    return `秘书所用模型 ${model} 的提供商 ${provider} 在你的 opencode 里只有 OAuth 登录；为免刷新令牌让你自己的登录失效，没带给秘书。${how}`;
  }
  if (!providers.length) return undefined;
  return `这些提供商在你的 opencode 里只有 OAuth 登录，没带给秘书（免得刷新令牌让你自己的登录失效）：${providers.join("、")}。秘书若用它们的模型，${how}`;
}

/** 没带过来的 MCP 登录的提示。 */
export function mcpHint(
  home: string,
  skipped: readonly Skipped[],
): string | undefined {
  if (!skipped.length) return undefined;
  return `这些 MCP 服务的登录（OAuth 或无法判断）没带给秘书：${skipped.map((item) => item.name).join("、")}；秘书要用时在秘书目录里单独登录：XDG_DATA_HOME=${home} opencode mcp auth <名称>`;
}
