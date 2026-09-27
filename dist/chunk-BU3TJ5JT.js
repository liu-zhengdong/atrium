// server/problem.ts
var Problem = class extends Error {
  constructor(statusCode, message, code, candidates, nextCommand) {
    super(message);
    this.statusCode = statusCode;
    this.candidates = candidates;
    this.nextCommand = nextCommand;
    this.code = code ?? {
      400: "usage",
      404: "not_found",
      403: "conflict",
      409: "conflict",
      503: "service_unavailable"
    }[statusCode] ?? "internal";
  }
  statusCode;
  candidates;
  nextCommand;
  code;
};
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    row = next;
  }
  return row[b.length];
}
function closest(reference, entries) {
  const distance = editDistance;
  const input = reference.toLowerCase();
  return entries.map((entry) => ({
    entry,
    score: entry.ref.toLowerCase() === input ? -2 : entry.ref.toLowerCase().startsWith(input) || entry.name.toLowerCase().startsWith(input) ? -1 : Math.min(
      distance(input, entry.name.toLowerCase()),
      distance(input, entry.name.toLowerCase().split(/\s+/)[0])
    )
  })).sort(
    (a, b) => a.score - b.score || a.entry.ref.localeCompare(b.entry.ref, void 0, { numeric: true })
  ).slice(0, 3).map(({ entry }) => ({ ref: entry.ref, name: entry.name }));
}

export {
  Problem,
  closest
};
