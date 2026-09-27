import { execFile } from "node:child_process";
import { stat, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { allBoundaries, chainLevels } from "../org/boundary-store.ts";
import { effective } from "../org/boundaries.ts";
import { nodes, ref } from "../org/model.ts";
import { allShares } from "../org/share-store.ts";
import { ownAmount } from "../org/shares.ts";
import { all } from "./ledger-model.ts";
import { BudgetProblem } from "./budget-problem.ts";

const run = promisify(execFile);
const GB = 1024 ** 3;
type Worktree = { node_id: number; worktree: string };

/** du 结果仅保留一个巡检周期；路径必须来自账本已有任务的 worktree。 */
export class DiskBudget {
  private cache = new Map<string, { at: number; gb: number }>();
  private cursor = 0;
  constructor(
    private readonly db: DatabaseSync,
    private readonly data: string,
  ) {}

  private async size(path: string): Promise<number> {
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.at < 30_000) return cached.gb;
    try {
      await stat(path);
      const { stdout } = await run("du", ["-sk", path], {
        timeout: 10_000,
        maxBuffer: 1024,
      });
      const gb = (Number.parseInt(stdout, 10) * 1024) / GB;
      if (!Number.isFinite(gb)) throw new Error("du 输出无效");
      this.cache.set(path, { at: Date.now(), gb });
      return gb;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  /** 看门狗每轮只巡五个 worktree，避免 du 扫描长期占住派活。 */
  async refresh() {
    const rows = all<{ id: number; worktree: string }>(
      this.db,
      "SELECT id,worktree FROM tasks WHERE id>? AND worktree IS NOT NULL ORDER BY id LIMIT 5",
      this.cursor,
    );
    if (!rows.length) {
      this.cursor = 0;
      return;
    }
    this.cursor = rows.at(-1)!.id;
    await Promise.all(
      rows.map((row) => this.size(row.worktree).catch(() => 0)),
    );
  }

  async check(nodeId: number | null, repo?: string | null) {
    const list = nodes(this.db);
    const node =
      list.find((n) => n.id === nodeId) ??
      list.find((n) => n.parent_id === null);
    const boundaries = node ? allBoundaries(this.db) : new Map();
    const levels = node
      ? [
          ...chainLevels(list, boundaries, node.parent_id),
          {
            node: node.id,
            name: node.name,
            entries: boundaries.get(node.id) ?? [],
          },
        ]
      : [];
    const minFree = Math.max(
      15,
      ...effective(levels)
        .filter((b) => b.param?.key === "disk_min_free_gb")
        .map((b) => b.param!.value),
    );
    const space = await statfs(repo ?? this.data);
    const free = (space.bavail * space.bsize) / GB;
    if (free < minFree)
      throw new BudgetProblem(
        `磁盘可用约 ${free.toFixed(1)} GB，低于章程下限 ${minFree} GB；先清理组织临时产物`,
      );
    if (nodeId === null || !node) return;
    const shares = allShares(this.db);
    const chain = [];
    let current = node;
    while (current) {
      if (ownAmount(shares.get(current.id) ?? [], "disk", "") !== undefined)
        chain.push(current);
      current = list.find((n) => n.id === current!.parent_id)!;
    }
    if (!chain.length) return;
    const paths = all<Worktree>(
      this.db,
      "SELECT node_id,worktree FROM tasks WHERE node_id IS NOT NULL AND worktree IS NOT NULL ORDER BY id DESC LIMIT 2001",
    );
    if (paths.length > 2000)
      throw new BudgetProblem("任务 worktree 超过 2000 条，无法核对磁盘份额");
    const usage = new Map<number, number>();
    for (const row of paths)
      usage.set(
        row.node_id,
        (usage.get(row.node_id) ?? 0) + (await this.size(row.worktree)),
      );
    for (const current of chain) {
      const limit = ownAmount(shares.get(current.id) ?? [], "disk", "");
      if (limit !== undefined) {
        const subtree = new Set([current.id]);
        for (const candidate of list) {
          let parent = candidate.parent_id;
          while (parent !== null) {
            if (parent === current.id) {
              subtree.add(candidate.id);
              break;
            }
            parent = list.find((n) => n.id === parent)?.parent_id ?? null;
          }
        }
        const used = [...usage].reduce(
          (sum, [id, gb]) => sum + (subtree.has(id) ? gb : 0),
          0,
        );
        if (used >= limit)
          throw new BudgetProblem(
            `${ref(current.id)} ${current.name} 的磁盘份额 ${limit} GB，worktree 已占约 ${used.toFixed(2)} GB；先清理该节点已结束任务的 worktree`,
          );
      }
    }
  }
}
