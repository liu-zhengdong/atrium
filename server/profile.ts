import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { Problem } from "./store.ts";
import { local, resolveInstalled } from "./package-spec.ts";
const require = createRequire(import.meta.url);
export const defaultTemplate = () =>
  resolve(
    process.env.ATRIUM_PI_TEMPLATE ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), ".pi/agent"),
  );
const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
const copyOwned = (from: string, to: string) =>
  writeFileSync(to, readFileSync(realpathSync(from)));
const linked = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
/** Containment test; a path with nothing on disk is compared as written. */
const inside = (root: string, path: string) => {
  const base = realpathSync(root);
  let target = resolve(path);
  try {
    target = realpathSync(target);
  } catch {
    // Absent: the literal path already says where it would land.
  }
  return target === base || target.startsWith(base + sep);
};
/** Notes an identity keeps for itself; the rest of a personal vault stays put. */
const OWNED_NOTES = ["USER", "self-evolution"];
/** Rule, model and MCP files an identity keeps as its own copies. */
const OWNED_FILES = [
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "models.json",
  "mcp.json",
];
/**
 * Resource directories an identity keeps as its own. These are what an Agent
 * writes as it evolves — a skill it wrote must not appear in every identity.
 * Pi reads <PI_CODING_AGENT_DIR>/<kind> on its own, and Atrium points that at
 * the identity directory, so owning the directory is all it takes.
 */
const OWNED_DIRS = ["extensions", "skills", "prompts", "themes"] as const;
/** Settings paths may carry an enable/disable prefix; strip it to get the path. */
const bare = (path: string) => path.replace(/^[!+-]/, "");
/**
 * Copy a resource directory, keeping any copy the identity already made.
 * FICLONE makes this near-free on APFS/Btrfs — a 19MB skill's node_modules is
 * shared until someone writes — and falls back to a full copy elsewhere.
 */
const copyResourceDir = (from: string, to: string) =>
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: false,
    mode: constants.COPYFILE_FICLONE,
  });
const notesSettings = (directory: string, maxContextBytes: unknown) => ({
  directory,
  ...(maxContextBytes === undefined ? {} : { maxContextBytes }),
});
/** Where an identity keeps its own notes. The layout is decided here only. */
const ownedNotesDir = (directory: string) => join(directory, "notes");
/** Directories holding identity-private content; the mode is decided here only. */
const makeOwnedDir = (path: string) =>
  mkdirSync(path, { recursive: true, mode: 0o700 });
const notesDirectory = (notes: Record<string, unknown>, root: string) =>
  typeof notes.directory === "string" ? local(notes.directory, root) : null;
/**
 * Copy the owned notes the identity lacks; copies it already has are kept.
 * Each note brings its Evolution log and its same-named folder of sub-notes.
 */
function copyOwnedNotes(sourceDir: string, directory: string) {
  for (const base of OWNED_NOTES)
    for (const name of [`${base}.md`, `${base}-Evolution.md`, base]) {
      const from = join(sourceDir, name),
        dest = join(directory, name);
      if (!existsSync(from) || existsSync(dest)) continue;
      if (statSync(from).isDirectory())
        cpSync(from, dest, { recursive: true, dereference: true });
      else copyOwned(from, dest);
    }
}
const BUNDLED_PACKAGE_NAMES = new Set([
  "@liuser/pi-atrium",
  "@liuser/pi-acp",
  "@liuser/pi-mcp-adapter",
  "@liuser/pi-notes",
]);

const BUNDLED_PACKAGE_PATH =
  /(?:^|\/)(?:@liuser\/)?(?:pi-atrium|pi-acp|pi-mcp-adapter|pi-notes)(?:\/|$)/;

function packageNameAt(path: string): string | undefined {
  try {
    const name = readJson(join(path, "package.json")).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

function entryPath(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "source" in entry) {
    const source = (entry as { source: unknown }).source;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
}

/** Paths that are this app's Pi bundle, including stale pi-acp / adapter / notes. */
export function isBundledPackagePath(path: string): boolean {
  const name = packageNameAt(path);
  if (name && BUNDLED_PACKAGE_NAMES.has(name)) return true;
  return BUNDLED_PACKAGE_PATH.test(path.replaceAll("\\", "/"));
}

export function bundledPackagePath(): string {
  return dirname(require.resolve("@liuser/pi-atrium/package.json"));
}

/** Keep user packages; replace any bundled copy with the current app install. */
export function injectBundledPackages(packages: unknown[]): unknown[] {
  const bridge = bundledPackagePath();
  const kept: unknown[] = [];
  for (const entry of packages) {
    const path = entryPath(entry);
    if (path === undefined) {
      kept.push(entry);
      continue;
    }
    if (isBundledPackagePath(path)) continue;
    kept.push(entry);
  }
  kept.push(bridge);
  return kept;
}

/** Rewrite an existing identity's settings before Pi loads packages. */
export function syncIdentityPackages(directory: string) {
  const file = join(directory, "settings.json");
  if (!existsSync(file)) return;
  const settings = readJson(file);
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const next = injectBundledPackages(packages);
  if (JSON.stringify(packages) === JSON.stringify(next)) return;
  settings.packages = next;
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Add owned notes an identity predates. Its own copies win; no overwrite. */
export function syncIdentityNotes(
  directory: string,
  template = defaultTemplate(),
) {
  const own = join(directory, "notes.json");
  const source = join(template, "notes.json");
  if (!existsSync(own) || !existsSync(source)) return;
  // Only ever write into the notes directory this app laid out for the identity.
  const target = notesDirectory(readJson(own), directory);
  if (target !== ownedNotesDir(directory)) return;
  const sourceDir = notesDirectory(readJson(source), template);
  if (!sourceDir || !existsSync(sourceDir)) return;
  makeOwnedDir(target);
  copyOwnedNotes(sourceDir, target);
}

/**
 * Profiles made before this layout symlinked their rules into the user's global
 * config: the Agent rewriting a rule rewrote the user's file, and the user's
 * edits changed the Agent. Replace each link with its content; the rename keeps
 * the link in place until the copy is whole.
 */
function adoptLinkedFiles(directory: string) {
  const failed: string[] = [];
  for (const name of OWNED_FILES) {
    const path = join(directory, name);
    if (!linked(path)) continue;
    const staging = `${path}.adopting`;
    try {
      writeFileSync(staging, readFileSync(realpathSync(path)));
      renameSync(staging, path);
    } catch {
      rmSync(staging, { force: true });
      failed.push(name);
    }
  }
  return failed;
}

/**
 * Notes pointed outside the identity (an early profile aimed straight at the
 * user's vault) move to its own directory. Only the notes it owns come along;
 * the vault itself is read, never written.
 */
function adoptNotesDirectory(directory: string) {
  const file = join(directory, "notes.json");
  if (!existsSync(file)) return;
  const notes = readJson(file);
  const current = notesDirectory(notes, directory);
  if (!current || inside(directory, current)) return;
  const target = ownedNotesDir(directory);
  // A linked notes dir would make the copy below land back in the vault.
  if (linked(target)) throw new Problem(409, "notes 目录是符号链接，未改动");
  makeOwnedDir(target);
  if (existsSync(current)) copyOwnedNotes(current, target);
  writeFileSync(
    file,
    JSON.stringify(notesSettings(target, notes.maxContextBytes), null, 2) +
      "\n",
    { mode: 0o600 },
  );
}

/**
 * Bring the identity's notes to the current layout. The order is why these two
 * share a function: the top-up only ever writes into the identity's own notes
 * directory, so a profile still pointing at the user's vault has to be moved in
 * first — otherwise the protocol notes it predates are skipped in silence.
 */
function adoptNotes(directory: string, template: string) {
  adoptNotesDirectory(directory);
  syncIdentityNotes(directory, template);
}

/**
 * Old profiles listed the user's global skills, extensions, prompts and themes,
 * so five identities wrote into one shared set. Copy what each was reading into
 * the identity, then drop the shared paths. The copy comes first: if it fails,
 * the reference stays and the identity still finds its resources.
 */
function adoptResourceDirs(directory: string, template: string) {
  const file = join(directory, "settings.json");
  if (!existsSync(file)) return;
  const settings = readJson(file);
  const failed: string[] = [];
  let changed = false;
  for (const kind of OWNED_DIRS) {
    const listed = Array.isArray(settings[kind])
      ? (settings[kind] as unknown[]).filter(
          (path): path is string => typeof path === "string",
        )
      : [];
    const shared = listed.filter((path) => inside(template, bare(path)));
    if (!shared.length) continue;
    const dest = join(directory, kind);
    // A linked resource dir would make the copy land in the user's own set.
    if (linked(dest)) {
      failed.push(kind);
      continue;
    }
    try {
      for (const path of shared)
        if (existsSync(bare(path))) copyResourceDir(bare(path), dest);
    } catch {
      failed.push(kind);
      continue;
    }
    settings[kind] = listed.filter((path) => !shared.includes(path));
    changed = true;
  }
  if (changed)
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", {
      mode: 0o600,
    });
  if (failed.length)
    throw new Problem(500, `未能转成自有目录：${failed.join("、")}`);
}

/**
 * Turn an old profile's shared rules, vault and resource directories into this
 * identity's own copies. Each part is adopted independently, and every part
 * that stayed shared is reported — a silent one would leave the identity
 * writing the user's files.
 */
export function adoptIdentityConfig(
  directory: string,
  template = defaultTemplate(),
) {
  const failed = adoptLinkedFiles(directory);
  const left = failed.length ? [`规则文件未能复制：${failed.join("、")}`] : [];
  for (const step of [
    () => adoptNotes(directory, template),
    () => adoptResourceDirs(directory, template),
  ])
    try {
      step();
    } catch (error) {
      left.push(error instanceof Problem ? error.message : String(error));
    }
  if (left.length) throw new Problem(500, left.join("；"));
}

/** A credential file Pi created but never stored anything in. */
const emptyCredentials = (path: string) => {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  if (!text) return true;
  try {
    const value: unknown = JSON.parse(text);
    return (
      typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 0
    );
  } catch {
    // Unreadable content is still content; replacing it would lose a login.
    return false;
  }
};

/**
 * Point the identity at the shared credential file. Pi reads credentials from
 * <agentDir>/auth.json and offers no way to aim that elsewhere — no setting, no
 * environment variable, only the SDK's authPath — so sharing has to happen at
 * the path. Logging in once in the template gives every identity, including
 * ones created later, the same providers.
 *
 * A copy would go stale instead: Pi rewrites refreshed OAuth tokens in place,
 * and once a provider rotates the refresh token only the copy that refreshed
 * last still works.
 *
 * The identity's own file wins. Content of any kind is a separate login, and a
 * symlink already aimed somewhere is the user's choice; both stay. Returns
 * whether this call created the link.
 */
export function linkSharedCredentials(
  directory: string,
  template = defaultTemplate(),
) {
  const own = join(directory, "auth.json");
  const shared = join(template, "auth.json");
  if (resolve(own) === resolve(shared)) return false;
  if (linked(own)) return false;
  if (existsSync(own) && !emptyCredentials(own)) return false;
  rmSync(own, { force: true });
  // The shared file need not exist yet: Pi creates it on the first login
  // through this link, and every identity reads that login.
  symlinkSync(shared, own);
  return true;
}

/**
 * Bring a profile up to the current layout before Pi reads it, from every start
 * path. The bundled packages must land — without them the identity has no
 * bridge; the rest is best effort and returns what the caller should report.
 */
export function syncIdentityProfile(directory: string) {
  syncIdentityPackages(directory);
  const left: string[] = [];
  try {
    adoptIdentityConfig(directory);
  } catch (error) {
    // The message already names every part that stayed shared.
    left.push(`配置未能转成自有副本：${error}`);
  }
  try {
    linkSharedCredentials(directory);
  } catch (error) {
    left.push(`凭据未能接上共享文件：${error}`);
  }
  return left;
}

/** Settings keys a new identity carries over from the template as written. */
const CARRIED_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "theme",
  "hideThinkingBlock",
  "compaction",
  "retry",
  "transport",
  "enabledModels",
  "thinkingBudgets",
  "defaultTools",
];

/**
 * The settings a new identity starts from: the template's own choices, with
 * packages resolved to where they are installed and resource paths pointing at
 * what the identity owns. Decides the content; writes nothing.
 */
function buildSettings(source: Record<string, unknown>, template: string) {
  const settings: Record<string, unknown> = {};
  for (const key of CARRIED_KEYS)
    if (source[key] !== undefined) settings[key] = source[key];
  const packages = Array.isArray(source.packages) ? source.packages : [];
  settings.packages = injectBundledPackages(
    packages.map((entry: unknown) => {
      const value =
        typeof entry === "string"
          ? entry
          : (entry as { source: string }).source;
      if (typeof value !== "string")
        throw new Problem(400, "配置模板含无效 package");
      const path = resolveInstalled(template, value);
      return typeof entry === "string"
        ? path
        : { ...(entry as object), source: path };
    }),
  );
  for (const kind of OWNED_DIRS) {
    const extra = Array.isArray(source[kind]) ? (source[kind] as string[]) : [];
    // Paths into the template are dropped: the identity gets its own copy of
    // that directory, and Pi reads it without being told. Paths pointing
    // elsewhere are the user's explicit choice and stay.
    settings[kind] = extra
      .map((path) => {
        const prefix = /^[!+-]/.test(path) ? path[0]! : "";
        return prefix + local(prefix ? path.slice(1) : path, template);
      })
      .filter((path) => !inside(template, bare(path)));
  }
  return settings;
}

/** Owned rules, notes and resource dirs; packages stay path references. Credentials are shared by link. */
export function prepareProfile(
  identityId: string,
  template = defaultTemplate(),
  piHome: string,
) {
  template = realpathSync(template);
  const target = join(piHome, "atrium", "agents", identityId);
  // A legacy record's directory may already hold its managed session and logs;
  // identity.json marks a prepared profile, any other existing content is kept.
  if (existsSync(join(target, "identity.json")))
    throw new Problem(409, "身份配置目录已存在，未覆盖");
  const settings = buildSettings(
    existsSync(join(template, "settings.json"))
      ? readJson(join(template, "settings.json"))
      : {},
    template,
  );
  // Rule/model/MCP files and notes become this identity's own copies.
  // Credentials are linked to the shared file; session history is not copied.
  // Identity files are written exclusively (wx) alongside kept legacy content;
  // on failure only what this call created is removed.
  const created: string[] = [];
  makeOwnedDir(target);
  try {
    const sessions = join(target, "sessions");
    if (!existsSync(sessions)) {
      makeOwnedDir(sessions);
      created.push(sessions);
    }
    write(join(target, "identity.json"), { version: 1, identityId });
    created.push(join(target, "identity.json"));
    write(join(target, "settings.json"), settings);
    created.push(join(target, "settings.json"));
    if (linkSharedCredentials(target, template))
      created.push(join(target, "auth.json"));
    for (const name of OWNED_FILES)
      if (existsSync(join(template, name))) {
        const dest = join(target, name);
        copyOwned(join(template, name), dest);
        created.push(dest);
      }
    for (const kind of OWNED_DIRS)
      if (existsSync(join(template, kind))) {
        const dest = join(target, kind);
        copyResourceDir(join(template, kind), dest);
        created.push(dest);
      }
    if (existsSync(join(template, "notes.json"))) {
      const notes = readJson(join(template, "notes.json"));
      const sourceDir = notesDirectory(notes, template);
      const directory = ownedNotesDir(target);
      makeOwnedDir(directory);
      created.push(directory);
      if (sourceDir && existsSync(sourceDir)) {
        if (inside(template, sourceDir))
          cpSync(sourceDir, directory, {
            recursive: true,
            dereference: true,
          });
        else copyOwnedNotes(sourceDir, directory);
      }
      write(
        join(target, "notes.json"),
        notesSettings(directory, notes.maxContextBytes),
      );
      created.push(join(target, "notes.json"));
    }
    return target;
  } catch (error) {
    for (const path of created) rmSync(path, { recursive: true, force: true });
    throw error;
  }
}
