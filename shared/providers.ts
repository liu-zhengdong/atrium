export type ProviderMethod = "oauth" | "api_key";
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

export function skipProvider(provider?: ProviderEntry): boolean {
  return !!provider;
}
export function skipMethod(provider?: ProviderEntry): boolean {
  return !!provider && provider.methods.length === 1;
}
