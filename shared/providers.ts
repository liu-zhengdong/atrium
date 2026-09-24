export type ProviderMethod = "oauth" | "api_key" | "local";
export type ProviderEntry = {
  id: string;
  name: string;
  methods: ProviderMethod[];
  packagePath: string | null;
};

/** One provider can offer both authentication methods; never duplicate it in the selector. */
export function mergeProviders(entries: ProviderEntry[]): ProviderEntry[] {
  const merged = new Map<string, ProviderEntry>();
  for (const entry of entries) {
    const previous = merged.get(entry.id);
    merged.set(
      entry.id,
      previous
        ? {
            ...entry,
            methods: [...new Set([...previous.methods, ...entry.methods])],
            packagePath: entry.packagePath ?? previous.packagePath,
          }
        : { ...entry, methods: [...new Set(entry.methods)] },
    );
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
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
