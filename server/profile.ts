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
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { templateChoice } from "./identity-env.ts";
import { fileURLToPath } from "node:url";
import { Problem } from "./store.ts";
import { local, resolveInstalled } from "./package-spec.ts";
import {
  markOwn,
  prepareOwnPackages,
  type AgentDefaults,
  type PackageEntry,
} from "./identity-packages.ts";
import {
  formatModelSpec,
  splitModelSpec,
  type ModelSpec,
} from "../shared/model.ts";
const require = createRequire(import.meta.url);
export const defaultTemplate = () => templateChoice(process.env).path;
const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
/** 原地更新配置：先写同目录临时文件再改名，中断不会留下半截的 settings.json。 */
const writeSettings = (file: string, settings: Record<string, unknown>) => {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, file);
};
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
/**
 * Rule, model, MCP and bridge files an identity keeps as its own copies; one the
 * template lacks is skipped.
 * claude-bridge.json names the Claude CLI to run: without it the bridge falls back
 * to the SDK's bundled CLI, which lists no newer models. It is copied, not linked,
 * because the bridge writes its startup-notice date into this file.
 */
const OWNED_FILES = [
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "models.json",
  "mcp.json",
  "claude-bridge.json",
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
/**
 * Notes the app itself hands every identity, from server/notes/. They come
 * from Atrium, not the user's vault: they hold this identity's post in the
 * organization — duties, reporting line, decisions pending and made.
 */
const BUNDLED_NOTES = ["职责"];
const bundledNotesDir = fileURLToPath(new URL("./notes/", import.meta.url));
/**
 * Add the bundled notes the identity lacks; its own copies are kept. `fresh` is
 * for an identity forked from another: the copy it got describes the source's
 * post, so it starts over from the blank note, without the Evolution log and
 * sub-notes that came along.
 */
function seedBundledNotes(directory: string, fresh = false) {
  for (const base of BUNDLED_NOTES) {
    if (fresh)
      for (const name of [`${base}.md`, `${base}-Evolution.md`, base])
        rmSync(join(directory, name), { recursive: true, force: true });
    try {
      // wx: an existing note, or a link standing in its place, is left alone.
      writeFileSync(
        join(directory, `${base}.md`),
        readFileSync(join(bundledNotesDir, `${base}.md`)),
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
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
  writeSettings(file, settings);
}

const settingsFile = (directory: string) => join(directory, "settings.json");

/**
 * 身份用哪个模型，事实来源是身份目录的 settings.json，由用户经 CLI／WebUI 维护。
 * 没设过返回 null（跟随 pi 自己的默认）；配置文件读不出来就照原样抛，
 * 这是用户必须看见的故障，不能悄悄当成「没设过」再拿旧模型开跑。
 */
export function readIdentityModel(directory: string): ModelSpec | null {
  const file = settingsFile(directory);
  if (!existsSync(file)) return null;
  const settings = readJson(file);
  const provider = settings.defaultProvider;
  const model = settings.defaultModel;
  if (typeof provider !== "string" || typeof model !== "string") return null;
  const thinking = settings.defaultThinkingLevel;
  return splitModelSpec(
    `${provider}/${model}${typeof thinking === "string" ? `:${thinking}` : ""}`,
  );
}

const modelKeys = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
] as const;

/** 切换运行中的模型失败时，只恢复模型字段，不覆盖同时修改的其他设置。 */
export function snapshotIdentityModel(directory: string) {
  const settings = readJson(settingsFile(directory));
  return Object.fromEntries(
    modelKeys
      .filter((key) => Object.hasOwn(settings, key))
      .map((key) => [key, settings[key]]),
  );
}
export function restoreIdentityModel(
  directory: string,
  previous: Record<string, unknown>,
) {
  const file = settingsFile(directory);
  const settings = readJson(file);
  for (const key of modelKeys) delete settings[key];
  Object.assign(settings, previous);
  writeSettings(file, settings);
}

/** 整体替换这三个键：输入的写法就是存下来的写法，不留上一次的思考强度。 */
export function writeIdentityModel(directory: string, spec: ModelSpec) {
  const file = settingsFile(directory);
  if (!existsSync(file))
    throw new Problem(409, "这个身份还没有自己的配置文件，请先启动一次");
  const settings = readJson(file);
  settings.defaultProvider = spec.provider;
  settings.defaultModel = spec.model;
  if (spec.thinking) settings.defaultThinkingLevel = spec.thinking;
  else delete settings.defaultThinkingLevel;
  writeSettings(file, settings);
  return formatModelSpec(spec);
}

/** Add owned and bundled notes an identity predates. Its own copies win; no overwrite. */
export function syncIdentityNotes(
  directory: string,
  template = defaultTemplate(),
) {
  const own = join(directory, "notes.json");
  // Without notes.json, Pi's notes live in <identity>/notes — the same place.
  const target = existsSync(own)
    ? notesDirectory(readJson(own), directory)
    : ownedNotesDir(directory);
  // Only ever write into the notes directory this app laid out for the identity.
  if (target !== ownedNotesDir(directory)) return;
  makeOwnedDir(target);
  seedBundledNotes(target);
  const source = join(template, "notes.json");
  if (!existsSync(own) || !existsSync(source)) return;
  const sourceDir = notesDirectory(readJson(source), template);
  if (!sourceDir || !existsSync(sourceDir)) return;
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
export function syncIdentityProfile(directory: string, shared = true) {
  syncIdentityPackages(directory);
  const left: string[] = [];
  try {
    adoptIdentityConfig(directory);
  } catch (error) {
    // The message already names every part that stayed shared.
    left.push(`配置未能转成自有副本：${error}`);
  }
  if (shared)
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
 * legacy packages resolved to their shared install or selected package specs and resource paths pointing at
 * what the identity owns. Decides the content; writes nothing.
 */
function buildSettings(
  source: Record<string, unknown>,
  template: string,
  selected?: PackageEntry[],
) {
  const settings: Record<string, unknown> = {};
  for (const key of CARRIED_KEYS)
    if (source[key] !== undefined) settings[key] = source[key];
  const packages = Array.isArray(source.packages) ? source.packages : [];
  settings.packages = injectBundledPackages(
    (selected ?? packages).map((entry: unknown) => {
      const value =
        typeof entry === "string"
          ? entry
          : (entry as { source: string }).source;
      if (typeof value !== "string")
        throw new Problem(400, "配置模板含无效 package");
      if (selected) return entry;
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

/** Owned rules, notes, resources, and package installs; credentials follow the existing account-link behavior. */
export function prepareProfile(
  identityId: string,
  template = defaultTemplate(),
  piHome: string,
  defaults?: AgentDefaults,
) {
  template = realpathSync(template);
  const target = join(piHome, "atrium", "agents", identityId);
  // A legacy record's directory may already hold its managed session and logs;
  // identity.json marks a prepared profile, any other existing content is kept.
  if (existsSync(join(target, "identity.json")))
    throw new Problem(409, "身份配置目录已存在，未覆盖");
  const sourceSettings = existsSync(join(template, "settings.json"))
    ? readJson(join(template, "settings.json"))
    : {};
  const packages =
    defaults?.packages ??
    ((Array.isArray(sourceSettings.packages)
      ? sourceSettings.packages
      : []) as PackageEntry[]);
  const settings = buildSettings(sourceSettings, template, packages);
  if (defaults?.model) {
    settings.defaultProvider = defaults.model.provider;
    settings.defaultModel = defaults.model.model;
  } else if (
    defaults &&
    !defaults.model &&
    typeof sourceSettings.defaultProvider === "string"
  ) {
    delete settings.defaultProvider;
    delete settings.defaultModel;
  }
  // Owned files (OWNED_FILES) and notes become this identity's own copies.
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
    for (const name of ["npm", "git"]) {
      const dest = join(target, name);
      if (existsSync(dest))
        throw new Problem(409, `身份已有 ${name} 目录，未覆盖`);
      created.push(dest);
    }
    const ownPackages = prepareOwnPackages(template, target, packages);
    settings.packages = injectBundledPackages(ownPackages);
    writeSettings(join(target, "settings.json"), settings);
    markOwn(target);
    created.push(join(target, ".atrium-packages.json"));
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
        if (kind === "skills" && defaults) {
          makeOwnedDir(dest);
          for (const skill of defaults.skills) {
            const from = join(template, kind, skill);
            if (existsSync(from)) copyResourceDir(from, join(dest, skill));
            else throw new Problem(400, `模板技能不存在：${skill}`);
          }
        } else copyResourceDir(join(template, kind), dest);
        created.push(dest);
      }
    // Without notes.json Pi reads <identity>/notes, so the bundled notes land
    // there whether or not the template configures notes.
    const notesDir = ownedNotesDir(target);
    if (!existsSync(notesDir)) {
      makeOwnedDir(notesDir);
      created.push(notesDir);
    }
    if (existsSync(join(template, "notes.json"))) {
      const notes = readJson(join(template, "notes.json"));
      const sourceDir = notesDirectory(notes, template);
      if (sourceDir && existsSync(sourceDir)) {
        if (inside(template, sourceDir))
          cpSync(sourceDir, notesDir, {
            recursive: true,
            dereference: true,
          });
        else copyOwnedNotes(sourceDir, notesDir);
      }
      write(
        join(target, "notes.json"),
        notesSettings(notesDir, notes.maxContextBytes),
      );
      created.push(join(target, "notes.json"));
    }
    // A template with identity.json is another identity being forked.
    seedBundledNotes(notesDir, existsSync(join(template, "identity.json")));
    return target;
  } catch (error) {
    for (const path of created) rmSync(path, { recursive: true, force: true });
    throw error;
  }
}
