export type ProviderMethod = "oauth" | "api_key" | "local";
export type ProviderEntry = {
  id: string;
  name: string;
  methods: ProviderMethod[];
};

/**
 * 不再列出的旧供应商（#242）：账号数据保留，但不再刷新、登录或分配。
 * fix 是能直接执行的修正；没有就只说明。
 */
export const RETIRED_PROVIDERS: Record<
  string,
  { reason: string; fix?: string }
> = {
  "xai-auth": {
    reason:
      "xAI 已改用 Pi 自带的 xai 供应商，旧 xai-auth 账号不再刷新或分配；请重新登录 xai，把身份分到新账号后删除旧账号",
    fix: "atrium connect xai",
  },
  antigravity: {
    reason: "Antigravity 不再支持，账号数据保留但不再刷新或分配",
  },
};

/**
 * 新建 Claude 账号的入口已封（#242）：Claude 以后走 Claude Code 后端（#193）。
 * 既有 claude-bridge 账号与分配照常可用，更换令牌等对既有账号的操作不受影响。
 */
export const CLAUDE_CLOSED =
  "Atrium 不再接入 Claude 模型，Claude 以后走 Claude Code 后端（#193）；已有的 Claude 账号与分配照常可用";

export function retiredProvider(id: string) {
  return Object.hasOwn(RETIRED_PROVIDERS, id)
    ? RETIRED_PROVIDERS[id]
    : undefined;
}

export function methodsFor(
  provider: ProviderEntry,
  chosen?: ProviderMethod,
): ProviderMethod[] {
  return chosen
    ? provider.methods.includes(chosen)
      ? [chosen]
      : []
    : provider.methods;
}

export function defaultAccountName(
  provider: ProviderEntry,
  accounts: { name: string }[],
): string {
  const used = new Set(accounts.map((account) => account.name));
  if (!used.has(provider.name)) return provider.name;
  let index = 2;
  while (used.has(`${provider.name} ${index}`)) index++;
  return `${provider.name} ${index}`;
}

export function matchingProviders(
  providers: ProviderEntry[],
  method: ProviderMethod,
  search: string,
): ProviderEntry[] {
  const query = search.trim().toLowerCase();
  return providers
    .filter(
      (item) =>
        item.methods.includes(method) &&
        `${item.id} ${item.name}`.toLowerCase().includes(query),
    )
    .sort((a, b) => {
      const rank = (item: ProviderEntry) =>
        item.name.toLowerCase().startsWith(query)
          ? 0
          : item.id.toLowerCase().startsWith(query)
            ? 1
            : 2;
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
}

export function assignedAccountLabel(
  ref: string,
  provider: string,
  accounts: {
    id: string;
    name: string;
    provider: string;
    assigned: string[];
  }[],
): string | undefined {
  const account = accounts.find(
    (item) => item.provider === provider && item.assigned.includes(ref),
  );
  return account && `${account.name}（${account.id}）`;
}

export function currentAssignment(
  ref: string,
  provider: string,
  accounts: { id: string; provider: string; assigned: string[] }[],
): string | undefined {
  return accounts.find(
    (account) =>
      account.provider === provider && account.assigned.includes(ref),
  )?.id;
}

export function assignmentFailure(
  agent: { ref: string; name: string },
  error: unknown,
  provider: ProviderEntry,
  accounts: { id: string; provider: string; assigned: string[] }[],
): string {
  const reason = error instanceof Error ? error.message : String(error);
  const current = currentAssignment(agent.ref, provider.id, accounts);
  if (current && /已有此 (?:provider|供应商) 的账号|已分配此账号/.test(reason))
    return `${agent.name}（${agent.ref}）已在用 ${provider.name} ${current}`;
  return `${agent.name}（${agent.ref}）：${reason.replace(/^Error:\s*/, "").replaceAll("provider", "供应商")}`;
}

export function assignmentSummary(
  added: string[],
  replaced: string[],
  failures: string[],
): string {
  return [
    added.length ? `新分配：${added.join("、")}` : "",
    replaced.length ? `替换：${replaced.join("、")}` : "",
    failures.length ? `失败：${failures.join("；")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function accountLabel(
  provider: ProviderEntry,
  name: string,
  id: string,
): string {
  return `${name.startsWith(provider.name) ? name : `${provider.name} ${name}`}（${id}）`;
}

export function skipProvider(provider?: ProviderEntry): boolean {
  return !!provider;
}
export function skipMethod(provider?: ProviderEntry): boolean {
  return !!provider && provider.methods.length === 1;
}
