import { type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  AccountFiles,
  authFile,
  privateWrite,
  providerName,
  type Row,
} from "./account-files.ts";
import { AccountWorker } from "./account-worker-client.ts";
import { defaultTemplate } from "./profile.ts";
import { Problem, type Store } from "./store.ts";

const require = createRequire(import.meta.url);
type Job = {
  child: ChildProcess;
  events: unknown[];
  prompt?: { id: string; type: string };
  done: boolean;
};
export class AccountLogin {
  private jobs = new Map<number, Job>();
  constructor(
    private store: Store,
    private files: AccountFiles,
    private worker: AccountWorker,
  ) {}
  private row(number: number) {
    return this.store.one<Row>(
      "SELECT * FROM accounts WHERE number=?",
      number,
    )!;
  }
  login(provider: string, name: string) {
    provider = providerName.parse(provider);
    if (!["openai-codex", "antigravity"].includes(provider))
      throw new Problem(400, "此 provider 暂不支持账号库 OAuth 登录");
    const number = Number(
      this.store.run(
        "INSERT INTO accounts(provider,name,type,status) VALUES(?,?,'oauth','pending')",
        provider,
        name,
      ).lastInsertRowid,
    );
    const row = this.row(number),
      directory = this.files.dir(number);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateWrite(authFile(directory), {});
    if (provider === "antigravity") {
      let path: string;
      try {
        path = require.resolve("pi-antigravity/package.json", {
          paths: [join(defaultTemplate(), "npm")],
        });
      } catch {
        this.store.run("DELETE FROM accounts WHERE number=?", number);
        throw new Problem(400, "未安装 pi-antigravity，暂不支持分配");
      }
      privateWrite(join(directory, "settings.json"), {
        packages: [path.replace(/\/package\.json$/, "")],
      });
    }
    const job: Job = {
      child: null as unknown as ChildProcess,
      events: [],
      done: false,
    };
    this.jobs.set(number, job);
    void this.worker
      .run(row, "login", (message) => {
        if (message.kind === "child") job.child = message.child;
        else if (message.kind === "notify") job.events.push(message.event);
        else if (message.kind === "prompt") {
          job.prompt = { id: message.id, type: message.prompt.type };
          job.events.push({ prompt: message.prompt });
        }
      })
      .then(() => {
        const value = this.files.load(row);
        this.store.run(
          "UPDATE accounts SET status='ready',expires=? WHERE number=?",
          value.type === "oauth" ? value.expires : null,
          number,
        );
        job.done = true;
      })
      .catch(() => {
        this.store.run(
          "UPDATE accounts SET status='error',last_error=? WHERE number=?",
          "登录未完成",
          number,
        );
        job.done = true;
      });
    return { id: `k${number}` };
  }
  loginEvents(number: number, after: number) {
    const job = this.jobs.get(number);
    if (!job)
      return {
        events: [],
        next: after,
        done: true,
        status: this.row(number).status,
      };
    return {
      events: job.events.slice(after),
      next: job.events.length,
      done: job.done,
      status: this.row(number).status,
    };
  }
  answer(number: number, value: string | null) {
    const job = this.jobs.get(number);
    if (!job || !job.prompt || job.done)
      throw new Problem(409, "没有待回答的登录请求");
    job.child.send({ id: job.prompt.id, value });
    job.prompt = undefined;
    return { accepted: true };
  }
  cancel(number: number) {
    this.jobs.get(number)?.child.kill();
    return { cancelled: true };
  }
}
