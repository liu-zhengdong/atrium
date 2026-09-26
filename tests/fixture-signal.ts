import { execFileSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { alive, readService } from "../server/service-state.ts";

/**
 * 测试被中断（Ctrl-C、超时强杀）时的收尾：夹具起的后台服务、它的子进程
 * （pi-atrium 等）、夹具自己 spawn 的等待进程都不该留在世界上。
 * t.after 正常走完时反注册；只有进程中途被信号打断才走这里。
 * 测试进程本身被 SIGKILL 时没有任何收尾机会，不在本机制范围内。
 */

export type OpenFixture = {
  data: string;
  root: string;
  children: Set<ChildProcess>;
};

const openFixtures = new Set<OpenFixture>();
let installed = false;

/** ps 树上收集 pid 的全部后代（服务的 ACP 子进程可能自成进程组，组杀够不到）。 */
export function descendantsOf(pid: number): number[] {
  const out: number[] = [];
  try {
    const ps = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
    });
    const byParent = new Map<number, number[]>();
    for (const line of ps.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!child || !parent) continue;
      const siblings = byParent.get(parent);
      if (siblings) siblings.push(child);
      else byParent.set(parent, [child]);
    }
    const stack = [pid];
    while (stack.length > 0) {
      for (const child of byParent.get(stack.pop()!) ?? []) {
        out.push(child);
        stack.push(child);
      }
    }
  } catch {
    /* ps 不可用时退化为只杀进程组 */
  }
  return out;
}

function stopFixture(fixture: OpenFixture): void {
  for (const child of fixture.children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  const record = readService(fixture.data);
  if (record && record.pid !== process.pid && alive(record.pid)) {
    for (const pid of descendantsOf(record.pid))
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已死 */
      }
    try {
      process.kill(-record.pid, "SIGKILL");
    } catch {
      try {
        process.kill(record.pid, "SIGKILL");
      } catch {
        /* 已死 */
      }
    }
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

/** 夹具创建时登记：进程被打断时由信号处理器统一收尾。 */
export function trackFixture(data: string, root: string): OpenFixture {
  const fixture = { data, root, children: new Set<ChildProcess>() };
  openFixtures.add(fixture);
  if (!installed) {
    installed = true;
    const bail = (signal: NodeJS.Signals) => {
      for (const open of [...openFixtures]) stopFixture(open);
      openFixtures.clear();
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once("SIGINT", () => bail("SIGINT"));
    process.once("SIGTERM", () => bail("SIGTERM"));
  }
  return fixture;
}

/** t.after 清理完成后反注册，信号处理器只管还开着的夹具。 */
export function untrackFixture(fixture: OpenFixture): void {
  openFixtures.delete(fixture);
}

/** 夹具 spawn 的子进程（如 wait）一并纳入中断收尾。 */
export function trackChild(fixture: OpenFixture, child: ChildProcess): void {
  fixture.children.add(child);
  child.on("exit", () => fixture.children.delete(child));
}
