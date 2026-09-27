import { execFileSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { alive, readService } from "../server/service-state.ts";
import { stopService } from "../server/service.ts";
import { killProcessesUnder } from "./win-processes.ts";

/**
 * 测试被中断（Ctrl-C、超时强杀）时的收尾：夹具起的后台服务、它的子进程
 * （pi-atrium 等）、夹具自己 spawn 的等待进程都不该留在世界上。
 * t.after 正常走完时反注册；只有进程中途被信号打断才走这里。
 * 测试进程被 SIGKILL 时由 tests/run-tests.ts 在父进程里扫本轮标记。
 */

export type OpenFixture = {
  data: string;
  root: string;
  children: Set<ChildProcess>;
  pids: Set<number>;
};

const openFixtures = new Set<OpenFixture>();
const allFixtures = new Set<OpenFixture>();
const runMarker = ".atrium-test-run";
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

/** 启动还未写 service.sqlite 时，从独占的夹具目录找服务进程。 */
function fixtureProcesses(root: string): number[] {
  if (process.platform === "win32" || !existsSync(root)) return [];
  const realRoot = realpathSync(root);
  if (process.platform === "linux") {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .filter((name) => {
        try {
          const cwd = readlinkSync(join("/proc", name, "cwd"));
          return cwd === realRoot || cwd.startsWith(realRoot + sep);
        } catch {
          return false;
        }
      })
      .map(Number)
      .filter((pid) => pid !== process.pid);
  }
  try {
    const output = execFileSync("lsof", ["-Fn", "-d", "cwd"], {
      encoding: "utf8",
      timeout: 3000,
    });
    let pid = 0;
    const found: number[] = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (
        line.startsWith("n") &&
        pid > 0 &&
        pid !== process.pid &&
        (line.slice(1) === realRoot || line.slice(1).startsWith(realRoot + sep))
      )
        found.push(pid);
    }
    return found;
  } catch {
    return [];
  }
}

function stopFixture(fixture: OpenFixture): void {
  const roots = new Set(fixtureProcesses(fixture.root));
  for (const child of fixture.children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  for (const rootPid of roots) {
    fixture.pids.add(rootPid);
    if (!alive(rootPid)) continue;
    for (const pid of descendantsOf(rootPid))
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已死 */
      }
    let ownGroup = false;
    try {
      ownGroup =
        Number(
          execFileSync("ps", ["-o", "pgid=", "-p", String(rootPid)], {
            encoding: "utf8",
          }).trim(),
        ) === rootPid;
    } catch {
      /* ps 不可用时只杀已确认的 PID */
    }
    if (ownGroup)
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    try {
      process.kill(rootPid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  // Windows 读不到进程的工作目录：按服务登记的 pid 与命令行结束目录下的进程；
  // 刚退出的进程还占着目录时带重试。
  if (process.platform === "win32") {
    let pid: number | undefined;
    try {
      pid = readService(fixture.data)?.pid;
    } catch {
      /* 没有登记 */
    }
    if (pid && pid !== process.pid && alive(pid)) {
      fixture.pids.add(pid);
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* 已退出 */
      }
    }
    killProcessesUnder(fixture.root);
  }
  rmSync(fixture.root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 20 : 0,
    retryDelay: 100,
  });
}

/** 夹具创建时登记：进程被打断时由信号处理器统一收尾。 */
export function trackFixture(data: string, root: string): OpenFixture {
  const fixture = {
    data,
    root,
    children: new Set<ChildProcess>(),
    pids: new Set<number>(),
  };
  openFixtures.add(fixture);
  allFixtures.add(fixture);
  if (process.env.ATRIUM_TEST_RUN_ID)
    writeFileSync(join(root, runMarker), process.env.ATRIUM_TEST_RUN_ID, {
      flag: "wx",
    });
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

/** 正常和断言失败都先优雅停止，最终强制收走本夹具的进程与目录。 */
export async function finishFixture(fixture: OpenFixture): Promise<void> {
  try {
    await stopService(fixture.data);
  } catch {
    // 服务可能尚未就绪或正处于排空；下面按夹具目录兜底。
  } finally {
    stopFixture(fixture);
    untrackFixture(fixture);
  }
}

/** 在测试文件结束时检查本轮所有临时服务，连已反注册的夹具也检查。 */
export async function assertNoFixtureLeaks(): Promise<void> {
  // SIGKILL 已送出，但内核可能稍后才完成进程退出。
  for (let i = 0; i < 20; i++) {
    if (
      [...allFixtures].every((fixture) =>
        [...fixture.pids].every((pid) => !alive(pid)),
      )
    )
      break;
    await delay(50);
  }
  const leaks = [...allFixtures].flatMap((fixture) => [
    ...(existsSync(fixture.root) ? [`目录 ${fixture.root}`] : []),
    ...[...fixture.pids]
      .filter((pid) => alive(pid))
      .map((pid) => `进程 ${pid} (${fixture.root})`),
    ...(openFixtures.has(fixture) ? [`未收尾 ${fixture.root}`] : []),
  ]);
  if (leaks.length) throw new Error(`测试留下临时服务：${leaks.join("，")}`);
}

/** 测试子进程被 SIGKILL 时，父启动器按本轮标记清理并报告遗留。 */
export function sweepTestRun(runId: string): string[] {
  const leaked: string[] = [];
  for (const name of readdirSync(tmpdir())) {
    const root = join(tmpdir(), name);
    const marker = join(root, runMarker);
    try {
      if (readFileSync(marker, "utf8") !== runId) continue;
    } catch {
      continue;
    }
    leaked.push(root);
    stopFixture({
      root,
      data: join(root, "data"),
      children: new Set(),
      pids: new Set(),
    });
  }
  return leaked;
}

/** 夹具 spawn 的子进程（如 wait）一并纳入中断收尾。 */
export function trackChild(fixture: OpenFixture, child: ChildProcess): void {
  fixture.children.add(child);
  child.on("exit", () => fixture.children.delete(child));
}
