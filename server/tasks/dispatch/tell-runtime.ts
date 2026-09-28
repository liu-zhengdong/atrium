import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { Problem } from "../../problem.ts";
import type { Active } from "./active.ts";
import { ADAPTERS } from "../adapters/index.ts";
import type { Executors } from "./executors.ts";
import type { Exit } from "../gates/outcome.ts";
import { getTask, noteTask, parseTaskRef } from "../ledger/ledger.ts";
import {
  addTell,
  listTells,
  markWritten,
  tellInput,
  unsent,
} from "./tell-ledger.ts";
import {
  afterExit,
  resumeMessage,
  routeTell,
  tellMessage,
  tellModeOf,
} from "./tell.ts";

/**
 * 捎话的运行时（#307）：登记后按 tell.ts 的判定即时写入、停掉重派或留到本轮结束；
 * 执行者退出时先看有没有没送到的，决定续上会话、重派还是照常收尾。
 */

/** 会话 id 在日志开头（claude 的 init 事件、codex 的抬头）；只读前 1 MiB。 */
const HEAD_BYTES = 1024 * 1024;

export async function readHead(file: string) {
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

const NEXT = {
  stdin: "已写进执行者的输入，在下一个工具调用边界读入",
  /** agy 的消息流每行一轮：运行中写入的排在本轮之后另起一轮。 */
  stdin_turn: "已写进执行者的输入，本轮做完后接着作为下一轮读入",
  after_turn: "执行者这一轮结束后带着补充续上原会话",
  restart: "执行者不支持运行中追加，正在停下并带着补充重派（工作树保留）",
  next_run: "下次拉起执行者时写进提示词",
} as const;

/** 登记一条捎话并按判定送出；HTTP 作者以认证身份为准。 */
export function tellTask(
  x: Executors,
  db: DatabaseSync,
  reference: unknown,
  body: unknown,
  actor?: string,
) {
  const id = parseTaskRef(reference);
  const { text, by } = tellInput(body, actor);
  const task = getTask(db, id);
  const active = x.active.get(id);
  const running = !!active && !active.exited && !active.stop;
  const route = routeTell({
    status: task.status,
    running,
    mode: active
      ? tellModeOf(ADAPTERS[active.tool], active.worker.profile.rules.tell)
      : undefined,
    live: !!active?.live?.open,
  });
  if (route.kind === "reject")
    throw new Problem(
      409,
      `${task.ref}：${route.reason}`,
      "conflict",
      undefined,
      `atrium task show ${task.ref}`,
    );
  let kind = route.kind;
  const tell = addTell(db, id, { text, by, uuid: randomUUID(), route: kind });
  if (kind === "stdin") {
    if (active!.live!.send(tellMessage(tell), tell.uuid)) markWritten(db, tell);
    else kind = "after_turn";
  } else if (kind === "restart") {
    active!.stop = { kind: "tell" };
    noteTask(db, id, "stop_requested", {
      pid: active!.pid,
      by,
      reason: "送捎话：停下后带着补充重派",
    });
    x.kill(active!);
  }
  const saved = listTells(db, id).find((item) => item.id === tell.id) ?? tell;
  return {
    task: getTask(db, id),
    tell: { ...saved, route: kind },
    how: NEXT[
      kind === "stdin" && active?.prepared?.launch.inputDialect === "agy"
        ? "stdin_turn"
        : kind
    ],
  };
}

/**
 * 执行者退出后、收尾前：有没送到的捎话（或为送捎话停下的）就续上会话或重派，返回 true 表示已接手，
 * 调用方不再收尾；续上失败记一条 tell_failed，照常收尾。
 */
export async function followUpTells(
  x: Executors,
  db: DatabaseSync,
  active: Active,
  exit: Exit,
): Promise<boolean> {
  await active.live?.finish();
  if (x.isClosed()) return false;
  const pending = unsent(listTells(db, active.id));
  if (!pending.length && active.stop?.kind !== "tell") return false;
  const adapter = ADAPTERS[active.tool];
  const session =
    adapter.resume && adapter.sessionOf
      ? adapter.sessionOf(await readHead(active.logFile))
      : undefined;
  const next = afterExit({
    stop: active.stop,
    exit,
    pending: pending.length,
    session,
    mode: tellModeOf(adapter, active.worker.profile.rules.tell),
  });
  if (next === "settle" || getTask(db, active.id).status !== "running")
    return false;
  try {
    await x.relaunch(
      active,
      next === "resume"
        ? {
            session: session!,
            text: resumeMessage(pending),
            ids: pending.map((tell) => tell.id),
          }
        : undefined,
    );
    return true;
  } catch (error) {
    if (x.isClosed()) return false;
    noteTask(db, active.id, "tell_failed", {
      reason: `${next === "resume" ? "续上会话" : "重派"}失败：${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  }
}
