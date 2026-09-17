// RPC also provides UI capabilities, so hasUI does not identify a TUI process.
export function runtimeMode(argv: string[], hasUI: boolean): string {
  const mode = argv.find((value) => value.startsWith("--mode="))?.slice(7);
  const index = argv.indexOf("--mode");
  return (
    mode ??
    (index >= 0 ? argv[index + 1] : undefined) ??
    (hasUI ? "tui" : "print")
  );
}
