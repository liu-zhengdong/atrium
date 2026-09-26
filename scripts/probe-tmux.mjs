// 探针专用 tmux 封装：会话开在探针目录下的独立 tmux server（-S <folder>/<name>），
// 不碰用户默认的 tmux server。server 由第一次 new-session 拉起，全局环境取自拉起它的
// 探针进程（execFileSync 继承 process.env），不从用户 server 的全局环境继承。
// 每个阶段用自己的 socket：各自 kill-server 收尾，不会误关另一阶段还要抓现场的会话。
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

// 探针被 SIGKILL 或 CI 超时杀掉时 finally 不会执行，私有 server 与里面的 atrium run 会一直留着。
// 拉起 server 时同时起一个脱离的看守进程：探针进程一消失就 kill-server。
// 正常收尾时 server 已被 kill-server，看守在探针退出后空跑一次 kill-server 即结束。
const WATCHDOG = `
const [pid, socket] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const timer = setInterval(() => {
  if (alive()) return;
  clearInterval(timer);
  try { require("node:child_process").execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" }); } catch {}
}, 500);
`;

export function probeTmux(folder, name = "tmux.sock") {
  const socket = join(folder, name);
  let watched = false;
  const tmux = (args, options) => {
    if (!watched && args[0] === "new-session") {
      watched = true;
      spawn(process.execPath, ["-e", WATCHDOG, String(process.pid), socket], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    return execFileSync("tmux", ["-S", socket, ...args], options);
  };
  tmux.socket = socket;
  return tmux;
}
