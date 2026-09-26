// 探针专用 tmux 封装：会话开在探针目录下的独立 tmux server（-S <folder>/tmux.sock），
// 不碰用户默认的 tmux server。server 由第一次 new-session 拉起，
// 进程环境继承自探针进程（execFileSync 的 env），不从用户 server 的全局环境继承。
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function probeTmux(folder) {
  const socket = join(folder, "tmux.sock");
  const tmux = (args, options) =>
    execFileSync("tmux", ["-S", socket, ...args], options);
  tmux.socket = socket;
  return tmux;
}
