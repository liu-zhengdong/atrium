import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export type SecretaryTool = "codex" | "opencode";
export type SecretarySession = {
  tool: SecretaryTool;
  sessionId: string;
  cwd: string;
};

export function secretarySessionFile(tool: SecretaryTool) {
  return tool === "opencode" ? "opencode-session.json" : "codex-acp.json";
}

function saveJson(file: string, value: unknown) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function quarantine(file: string) {
  try {
    renameSync(file, `${file}.bad-${randomUUID()}`);
    console.warn(`秘书会话记录 ${basename(file)} 已损坏，已移开`);
  } catch {
    // Another reader may already have moved it.
  }
}

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    quarantine(file);
    return undefined;
  }
}

/** ACP and the one-shot CLI use the same native session ID. */
export function saveSecretarySession(data: string, session: SecretarySession) {
  const directory = join(data, "secretary");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  saveJson(join(directory, secretarySessionFile(session.tool)), {
    sessionId: session.sessionId,
    cwd: session.cwd,
    updated_at: Date.now(),
  });
  saveJson(join(directory, "active.json"), { tool: session.tool });
}

export function loadSecretarySession(
  data: string,
): SecretarySession | undefined {
  const activeFile = join(data, "secretary", "active.json");
  const active = readJson(activeFile) as { tool?: unknown } | undefined;
  if (!active) return undefined;
  if (active.tool !== "codex" && active.tool !== "opencode") {
    quarantine(activeFile);
    return undefined;
  }
  const sessionFile = join(
    data,
    "secretary",
    secretarySessionFile(active.tool),
  );
  const saved = readJson(sessionFile) as
    { sessionId?: unknown; cwd?: unknown } | undefined;
  if (!saved) return undefined;
  if (
    typeof saved.sessionId !== "string" ||
    !saved.sessionId ||
    typeof saved.cwd !== "string" ||
    !isAbsolute(saved.cwd)
  ) {
    quarantine(sessionFile);
    return undefined;
  }
  return { tool: active.tool, sessionId: saved.sessionId, cwd: saved.cwd };
}

export function wakeCount(data: string): number {
  const file = join(data, "secretary", "wake-count.json");
  const value = readJson(file) as { count?: unknown } | undefined;
  if (!value) return 0;
  if (Number.isInteger(value.count) && (value.count as number) >= 0)
    return value.count as number;
  quarantine(file);
  return 0;
}

export function saveWakeCount(data: string, count: number) {
  const directory = join(data, "secretary");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  saveJson(join(directory, "wake-count.json"), { count });
}
