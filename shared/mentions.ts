export function resolveMentions(
  body: string,
  agents: { id: string; name: string }[],
): string[] {
  if (!agents.length) return [];
  const byName = new Map(agents.map((agent) => [agent.name, agent.id]));
  const names = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `(?:^|\\s)@(${names.join("|")})(?=\\s|$|[，。！？,:])`,
    "gu",
  );
  return [
    ...new Set(
      [...body.matchAll(pattern)].map((match) => byName.get(match[1])!),
    ),
  ];
}
