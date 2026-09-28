import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Problem } from "../server/problem.ts";
import {
  MATERIAL_MAX_BYTES,
  MATERIAL_MAX_FILES,
  pathProblem,
  sizeText,
  tooBig,
} from "../server/materials/model.ts";
import { recordNext } from "./contract.ts";
import { oneLine, printJson, table, when } from "./format.ts";
import type { Command, Values } from "./main.ts";
import { str } from "./args.ts";

/**
 * 资料（t192）：挂在节点上的设计稿、调研报告这类文件或目录，短号 mN。
 * add 把文件或目录传给服务存进数据目录（同一节点同名的再加就是新版本），派活时提示词只附清单，
 * 执行者按需 get；清理只归档不删（archive / restore / keep），真删（rm）只有用户。
 */

const client = async () => (await import("./service.ts")).connect();

type Material = {
  ref: string;
  node: string;
  node_name: string | null;
  kind: "file" | "dir";
  name: string;
  note: string;
  version: number;
  bytes: number;
  files: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  superseded_by: string | null;
  last_read_at: number | null;
  last_read_by: string | null;
  archived: boolean;
  archived_at: number | null;
  archive_note: string | null;
  keep_at: number | null;
  keep_note: string | null;
};
type Stale = { kind: string; reason: string };
type Detail = Material & {
  versions: {
    version: number;
    bytes: number;
    files: number;
    note: string | null;
    created_by: string;
    created_at: number;
  }[];
  reads: { version: number; reader: string; at: number }[];
  links: { ref: string; ended: boolean }[];
  stale: Stale | null;
  supersedes: string[];
};

const who = (reader: string | null) =>
  reader === null ? "" : reader === "secretary" ? "秘书" : reader;
const readText = (m: Material) =>
  m.last_read_at
    ? `${when(m.last_read_at)} ${who(m.last_read_by)} 读过`
    : "还没人读过";

type Collected = {
  kind: "file" | "dir";
  name: string;
  files: { path: string; abs: string; size: number }[];
  skipped: string[];
};

/**
 * 收集要加的文件：单个文件，或目录下的全部文件（相对路径用 / 分段）。
 * 隐藏的（以 . 开头）跳过并告知；软链接只收指向目录里面的，指向外面的报错；先算大小，超了不读。
 */
export function collect(input: string): Collected {
  let stat;
  try {
    stat = statSync(input);
  } catch {
    throw new Problem(400, `文件|目录: 读不到 ${input}`, "usage");
  }
  const name = basename(resolve(input));
  if (stat.isFile() && stat.size > MATERIAL_MAX_BYTES)
    throw new Problem(400, tooBig(stat.size), "usage");
  if (stat.isFile())
    return {
      kind: "file",
      name,
      files: [{ path: name, abs: resolve(input), size: stat.size }],
      skipped: [],
    };
  if (!stat.isDirectory())
    throw new Problem(400, `文件|目录: ${input} 不是文件或目录`, "usage");
  const root = realpathSync(input);
  const files: Collected["files"] = [];
  const skipped: string[] = [];
  const seen = new Set<string>([root]);
  let size = 0;
  const walk = (dir: string, prefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".")) {
        skipped.push(rel);
        continue;
      }
      let full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          skipped.push(rel);
          continue;
        }
        if (real !== root && !real.startsWith(root + sep))
          throw new Problem(
            400,
            `文件|目录: ${rel} 是指向目录外的软链接，不收；把它指向的内容复制进来再加`,
            "usage",
          );
        full = real;
      }
      const info = statSync(full);
      if (info.isDirectory()) {
        if (seen.has(full)) continue;
        seen.add(full);
        walk(full, rel);
      } else if (info.isFile()) {
        const problem = pathProblem(rel);
        if (problem) throw new Problem(400, `文件|目录: ${problem}`, "usage");
        size += info.size;
        if (size > MATERIAL_MAX_BYTES)
          throw new Problem(400, tooBig(size), "usage");
        files.push({ path: rel, abs: full, size: info.size });
        if (files.length > MATERIAL_MAX_FILES)
          throw new Problem(
            400,
            `文件|目录: 超过 ${MATERIAL_MAX_FILES} 个文件；打成压缩包再加`,
            "usage",
          );
      } else skipped.push(rel);
    }
  };
  walk(root, "");
  return { kind: "dir", name, files, skipped };
}

function materialLines(list: Material[]) {
  if (!list.length) return "（没有）";
  return table([
    ["资料", "名称", "说明", "节点", "版本", "大小", "读取"],
    ...list.map((m) => [
      m.ref,
      oneLine(m.name, 30),
      oneLine(m.note, 36),
      m.node,
      `v${m.version}`,
      sizeText(m.bytes),
      readText(m),
    ]),
  ]);
}

function detailText(d: Detail) {
  const state = d.archived
    ? `已归档（${when(d.archived_at!)}${d.archive_note ? `：${d.archive_note}` : ""}）`
    : d.superseded_by
      ? `已被 ${d.superseded_by} 取代`
      : "在用";
  return [
    `${d.ref} ${d.name}（${d.kind === "dir" ? `目录，${d.files} 个文件` : "文件"}） · 挂在 ${d.node}${d.node_name ? ` ${d.node_name}` : ""}`,
    `说明：${d.note || "（没写）"}`,
    `状态：${state} · 当前 v${d.version}，${sizeText(d.bytes)} · 加于 ${when(d.created_at)}（${who(d.created_by)}）`,
    ...(d.supersedes.length ? [`取代了：${d.supersedes.join("、")}`] : []),
    ...(d.links.length
      ? [
          `关联：${d.links.map((l) => `${l.ref}${l.ended ? "（已结束）" : ""}`).join("、")}`,
        ]
      : []),
    ...(d.keep_note ? [`留下：${d.keep_note}（清理线索不再提）`] : []),
    ...(d.stale ? [`清理线索：疑似没用——${d.stale.reason}`] : []),
    "",
    "版本（新的在前）：",
    ...d.versions.map(
      (v) =>
        `- v${v.version} ${when(v.created_at)} ${who(v.created_by)} · ${v.files} 个文件 ${sizeText(v.bytes)}${v.note ? ` · ${v.note}` : ""}`,
    ),
    "",
    `谁读过（最近 ${d.reads.length} 次）：`,
    ...(d.reads.length
      ? d.reads.map((r) => `- ${when(r.at)} ${who(r.reader)} 读 v${r.version}`)
      : ["（还没人读过）"]),
  ].join("\n");
}

/** material ls --stale：清理线索（疑似没用的，看全部时另列可以真删的）。 */
async function stale(values: Values, json: boolean) {
  const node = str(values, "node");
  const result = await (
    await client()
  ).get<{
    stale: (Material & { stale: Stale })[];
    purge: (Material & { total_bytes: number })[];
  }>(`/materials/stale${node ? `?node=${encodeURIComponent(node)}` : ""}`);
  if (json) printJson(result);
  else
    console.log(
      [
        `疑似没用（${result.stale.length} 份）：`,
        ...(result.stale.length
          ? result.stale.map(
              (m) => `- ${m.ref} ${m.name}（${m.node}）：${m.stale.reason}`,
            )
          : ["（没有）"]),
        ...(node
          ? []
          : [
              "",
              `可以真删（归档超过一年且大于 10 MB，要用户点头；${result.purge.length} 份）：`,
              ...(result.purge.length
                ? result.purge.map(
                    (m) =>
                      `- ${m.ref} ${m.name}（${m.node}）：归档于 ${when(m.archived_at!)}，共 ${sizeText(m.total_bytes)}`,
                  )
                : ["（没有）"]),
            ]),
      ].join("\n"),
    );
  const first = result.stale[0];
  if (first)
    recordNext(
      `用不上就归档：atrium material archive ${first.ref} --note 原因；要留：atrium material keep ${first.ref} --note 原因`,
    );
}

export const materialCommands: Record<string, Command> = {
  "material add": {
    args: "节点 文件|目录 --note 一句话 [--name 名称] [--supersedes mN] [--for t1,k1,d1]",
    about:
      "把文件或目录作为资料挂到节点上（存进数据目录，单版至多 20 MB，隐藏文件不收）；同一节点同名的再加就是新版本；--supersedes 标旧资料被取代，--for 关联任务、要点或决定（清理线索看它们是否结束）",
    options: {
      note: { type: "string" },
      name: { type: "string" },
      supersedes: { type: "string" },
      for: { type: "string" },
    },
    positionals: [2, 2],
    async run({ positionals: [node, path], values, json }) {
      const found = collect(path!);
      const name = str(values, "name") ?? found.name;
      const files = found.files.map((f) => ({
        path: found.kind === "file" ? name : f.path,
        data: readFileSync(f.abs).toString("base64"),
      }));
      const body: Record<string, unknown> = {
        node,
        kind: found.kind,
        name,
        files,
      };
      for (const key of ["note", "supersedes", "for"])
        if (str(values, key) !== undefined) body[key] = str(values, key);
      const result = await (
        await client()
      ).post<{ material: Material; outcome: string }>("/materials", body);
      const m = result.material;
      if (json) printJson({ ...result, skipped: found.skipped });
      else
        console.log(
          [
            result.outcome === "new"
              ? `已挂上 ${m.ref} ${m.name} → ${m.node}（v1，${m.files} 个文件，${sizeText(m.bytes)}）`
              : result.outcome === "version"
                ? `${m.ref} ${m.name} 加了新版本 v${m.version}（${m.files} 个文件，${sizeText(m.bytes)}）`
                : `${m.ref} ${m.name} 内容和当前版本 v${m.version} 一样，没加新版本`,
            ...(found.skipped.length
              ? [
                  `跳过 ${found.skipped.length} 个隐藏文件或特殊文件：${found.skipped.slice(0, 5).join("、")}${found.skipped.length > 5 ? " 等" : ""}`,
                ]
              : []),
          ].join("\n"),
        );
      recordNext(`看：atrium material show ${m.ref}`);
    },
  },
  "material ls": {
    args: "[--node 节点] [--archived] [--stale] [--before mN] [--limit 条数]",
    about:
      "列资料（新的在前）：短号、名称、一句话、节点、版本、大小、最近谁读过；缺省不含归档的，--archived 只列归档的；--stale 列清理线索：疑似没用的资料（被取代，或 90 天没读且关联都结束；由这一块的 leader 定归档还是留），看全部时另列归档超过一年且大于 10 MB、可以真删的（要用户点头）",
    options: {
      node: { type: "string" },
      archived: { type: "boolean", default: false },
      stale: { type: "boolean" },
      before: { type: "string" },
      limit: { type: "string" },
    },
    positionals: [0, 0],
    async run({ values, json }) {
      if (values.stale === true) return stale(values, json);
      const query = new URLSearchParams();
      for (const key of ["node", "before", "limit"])
        if (str(values, key) !== undefined) query.set(key, str(values, key)!);
      if (values.archived === true) query.set("archived", "1");
      const page = await (
        await client()
      ).get<{ materials: Material[]; next_before: string | null }>(
        `/materials${query.size ? `?${query}` : ""}`,
      );
      if (json) printJson(page);
      else console.log(materialLines(page.materials));
      recordNext(
        page.next_before
          ? `往下看：atrium material ls${values.archived === true ? " --archived" : ""}${str(values, "node") ? ` --node ${str(values, "node")}` : ""} --before ${page.next_before}`
          : page.materials[0]
            ? `看一份：atrium material show ${page.materials[0].ref}`
            : "挂一份：atrium material add 节点 文件|目录 --note 一句话",
      );
    },
  },
  "material show": {
    args: "mN",
    about: "看一份资料：说明、状态、版本、关联、谁读过、清理线索",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const detail = await (
        await client()
      ).get<Detail>(`/materials/${encodeURIComponent(reference!)}`);
      if (json) printJson(detail);
      else console.log(detailText(detail));
      recordNext(`取：atrium material get ${detail.ref}`);
    },
  },
  "material get": {
    args: "mN [--out 目录] [--version 版本]",
    about:
      "取资料到 --out 目录（缺省当前目录）下，按名称落成文件或目录，已存在就报错；缺省当前版本；执行者在任务里也能用（读取记在任务上）",
    options: { out: { type: "string" }, version: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      const { connectForRead } = await import("./service.ts");
      const c = await connectForRead();
      const out = resolve(str(values, "out") ?? ".");
      const body: Record<string, string> = {};
      if (str(values, "version") !== undefined)
        body.version = str(values, "version")!;
      const task = process.env.ATRIUM_TASK?.trim();
      if (task) body.task = task;
      // 先看落到哪、会不会撞，撞了不记读取。
      const { name } = await c.get<{ name: string }>(
        `/materials/${encodeURIComponent(reference!)}`,
      );
      if (existsSync(join(out, name)))
        throw new Problem(
          409,
          `${join(out, name)} 已存在；换个目录：atrium material get ${reference} --out 另一个目录`,
          "conflict",
        );
      const opened = await c.post<{
        ref: string;
        kind: "file" | "dir";
        name: string;
        version: number;
        bytes: number;
        files: { path: string; size: number }[];
      }>(`/materials/${encodeURIComponent(reference!)}/get`, body);
      if (pathProblem(opened.name) || opened.name.includes("/"))
        throw new Problem(502, `服务返回了坏名称：${opened.name}`);
      const target = join(out, opened.name);
      if (existsSync(target))
        throw new Problem(
          409,
          `${target} 已存在；换个目录：atrium material get ${opened.ref} --out 另一个目录`,
          "conflict",
        );
      for (const file of opened.files) {
        // 服务给的路径也再查一遍，写不出目标目录。
        const problem = pathProblem(file.path);
        if (problem) throw new Problem(502, `服务返回了坏路径：${problem}`);
        const dest =
          opened.kind === "file"
            ? target
            : join(target, ...file.path.split("/"));
        if (relative(out, dest).startsWith(".."))
          throw new Problem(502, `服务返回了越界路径：${file.path}`);
        const query = new URLSearchParams({
          version: String(opened.version),
          path: file.path,
        });
        const got = await c.get<{ data: string }>(
          `/materials/${encodeURIComponent(opened.ref)}/files?${query}`,
        );
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, Buffer.from(got.data, "base64"));
      }
      const result = { ...opened, path: target };
      if (json) printJson(result);
      else
        console.log(
          `已取 ${opened.ref} ${opened.name} v${opened.version}（${opened.files.length} 个文件，${sizeText(opened.bytes)}）→ ${target}`,
        );
    },
  },
  "material archive": {
    args: "mN [--note 原因] [--undo]",
    about:
      "归档资料：不进清单和派活提示词、清理线索也不再提，文件留着可恢复（只归档不删）；--undo 恢复归档的，重新进清单和派活提示词",
    options: { note: { type: "string" }, undo: { type: "boolean" } },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      if (values.undo === true) {
        const m = await (
          await client()
        ).post<Material>(
          `/materials/${encodeURIComponent(reference!)}/restore`,
          str(values, "note") === undefined
            ? {}
            : { note: str(values, "note") },
        );
        if (json) printJson(m);
        else console.log(`已恢复 ${m.ref} ${m.name} → ${m.node}`);
        recordNext(`看：atrium material show ${m.ref}`);
        return;
      }
      const m = await (
        await client()
      ).post<Material>(
        `/materials/${encodeURIComponent(reference!)}/archive`,
        str(values, "note") === undefined ? {} : { note: str(values, "note") },
      );
      if (json) printJson(m);
      else console.log(`已归档 ${m.ref} ${m.name}`);
      recordNext(`恢复：atrium material archive ${m.ref} --undo`);
    },
  },
  "material keep": {
    args: "mN --note 原因",
    about: "清理线索说疑似没用、但决定留下：写一句原因，之后清理线索不再提它",
    options: { note: { type: "string" } },
    positionals: [1, 1],
    async run({ positionals: [reference], values, json }) {
      if (str(values, "note") === undefined)
        throw new Problem(400, "--note: 留下要写一句原因", "usage");
      const m = await (
        await client()
      ).post<Material>(`/materials/${encodeURIComponent(reference!)}/keep`, {
        note: str(values, "note"),
      });
      if (json) printJson(m);
      else console.log(`留下 ${m.ref} ${m.name}：${m.keep_note}`);
      recordNext(`看其余线索：atrium material ls --stale --node ${m.node}`);
    },
  },
  "material rm": {
    args: "mN",
    about:
      "真删资料（库里的记录与全部版本的文件，删了找不回来）；只有用户能删，平时用不上就 archive",
    positionals: [1, 1],
    async run({ positionals: [reference], json }) {
      const m = await (
        await client()
      ).delete<Material>(`/materials/${encodeURIComponent(reference!)}`);
      if (json) printJson(m);
      else console.log(`已删除 ${m.ref} ${m.name}（全部版本）`);
    },
  },
};
