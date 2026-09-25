import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalPath, clone } from "./clone.ts";

/** Rebase paths embedded in copied JSON (including MCP args and package metadata). */
export function rewriteIdentityConfigs(
  template: string,
  target: string,
  created: string[] = [],
  alias = template,
  finalTarget = target,
) {
  const roots = [...new Set([template, alias])];
  const paths = roots.map((root) => {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      root,
      pattern: new RegExp(`${escaped}(?:/[^\\s\\"'\`,;(){}\\[\\]?#&]*)?`, "g"),
    };
  });
  const staged = finalTarget !== target;
  function ownPath(suffix: string) {
    return staged && !/^(npm|git|local)\//.test(suffix)
      ? join(
          "local",
          "template",
          createHash("sha256").update(suffix).digest("hex").slice(0, 12),
          suffix,
        )
      : suffix;
  }
  function rewrite(
    value: unknown,
    kind: "config" | "text" = "config",
  ): unknown {
    if (typeof value === "string") {
      let result = value;
      for (const { root, pattern } of paths)
        result = result.replace(pattern, (source) => {
          const suffix = relative(root, source);
          if (suffix === ".." || suffix.startsWith(`..${sep}`)) return source;
          // Historical template backups are not identity seed data. Preserve
          // their absence rather than copying raw evidence into a new agent.
          if (suffix === "backups" || suffix.startsWith(`backups${sep}`)) {
            if (kind === "config")
              throw new Error("身份配置引用了模板备份，需人工处理");
            return "（原身份备份未继承）";
          }
          // Migration stages only npm/git/local. Other template paths must live
          // under local/ so they travel with the staged tree on commit.
          const path = ownPath(suffix);
          const destination = join(target, path);
          if (suffix && !existsSync(destination) && existsSync(source)) {
            mkdirSync(dirname(destination), { recursive: true });
            created.push(destination);
            clone(
              source,
              destination,
              { recursive: true, dereference: true },
              undefined,
              { from: root, to: target },
            );
          }
          return join(finalTarget, path);
        });
      if (roots.some((root) => result.includes(root)))
        throw new Error("身份配置中含无法转换的模板路径");
      return result;
    }
    if (Array.isArray(value)) return value.map((item) => rewrite(item, kind));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rewrite(item, kind)]),
      );
    return value;
  }
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name !== "auth.json") {
        const json = entry.name.endsWith(".json");
        const text =
          /\.(md|yaml|yml|toml|jsonc|mjs|sh|txt|js|ts)$/.test(entry.name) &&
          !/^(npm|git)\//.test(relative(target, file));
        if (!json && !text) continue;
        const before = readFileSync(file, "utf8");
        if (!roots.some((root) => before.includes(root))) continue;
        const after = json
          ? JSON.stringify(rewrite(JSON.parse(before)), null, 2) + "\n"
          : (rewrite(before, "text") as string);
        if (before !== after) writeFileSync(file, after);
      }
    }
  }
  visit(target);
  if (!staged) return;
  // cp has already rebased absolute links into the stage. Any link to a
  // template file not included in npm/git/local must be materialized there too.
  const visited = new Set<string>();
  function visitLinks(dir: string) {
    if (visited.has(dir)) return;
    visited.add(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visitLinks(file);
      else if (entry.isSymbolicLink()) {
        const link = readlinkSync(file);
        const resolved = resolve(dirname(file), link);
        const source = join(
          canonicalPath(dirname(resolved)),
          resolved.split(sep).at(-1)!,
        );
        const suffix = relative(canonicalPath(target), source);
        if (
          suffix === ".." ||
          suffix.startsWith(`..${sep}`) ||
          isAbsolute(suffix)
        )
          continue;
        const destination = join(target, ownPath(suffix));
        const original = join(template, suffix);
        if (!existsSync(destination) && existsSync(original)) {
          mkdirSync(dirname(destination), { recursive: true });
          clone(original, destination, { recursive: true }, undefined, {
            from: template,
            to: target,
          });
          if (lstatSync(destination).isDirectory()) visitLinks(destination);
        }
        if (destination !== source) {
          rmSync(file);
          symlinkSync(relative(dirname(file), destination) || ".", file);
        }
      }
    }
  }
  visitLinks(target);
}
