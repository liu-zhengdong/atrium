import { type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  AccountFiles,
  authFile,
  credential,
  privateWrite,
  readAuth,
  providerName,
  type Row,
} from "./account-files.ts";
import { AccountWorker } from "./account-worker-client.ts";
import { defaultTemplate } from "./profile.ts";
import { Problem, type Store } from "./store.ts";

const require = createRequire(import.meta.url);
type Job = {
  child: ChildProcess | null;
  cancelled: boolean;
  events: unknown[];
  prompt?: { id: string; type: string };
  done: boolean;
};
export class AccountLogin {
  private jobs = new Map<number, Job>();
  constructor(
    private store: Store,
    private files: AccountFiles,
    private worker: Pick<AccountWorker, "run">,
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
    this.start(row, directory, () => {
      const value = this.files.load(row);
      this.store.run(
        "UPDATE accounts SET status='ready',expires=?,last_error=NULL WHERE number=?",
        value.type === "oauth" ? value.expires : null,
        number,
      );
    });
    return { id: `k${number}` };
  }
  relogin(number: number, distribute: () => void) {
    const row = this.row(number);
    if (row.type !== "oauth") throw new Problem(400, "此账号不是 OAuth 登录");
    if (this.jobs.get(number)?.done === false)
      throw new Problem(409, "此账号正在登录");
    const directory = this.files.dir(number);
    const staged = join(directory, `login-${randomUUID()}`);
    mkdirSync(staged, { mode: 0o700 });
    if (row.provider === "antigravity")
      copyFileSync(
        join(directory, "settings.json"),
        join(staged, "settings.json"),
      );
    privateWrite(authFile(staged), {});
    this.store.run(
      "UPDATE accounts SET status='pending',last_error=NULL WHERE number=?",
      number,
    );
    this.start(
      row,
      staged,
      () => {
        const value = credential.parse(
          readAuth(authFile(staged))[row.provider],
        );
        this.files.save(row, value);
        if (row.provider === "antigravity")
          copyFileSync(
            join(staged, "antigravity-accounts.json"),
            join(directory, "antigravity-accounts.json"),
          );
        distribute();
      },
      () => rmSync(staged, { recursive: true, force: true }),
    );
    return { id: `k${number}` };
  }
  private start(
    row: Row,
    directory: string,
    success: () => void,
    cleanup?: () => void,
  ) {
    const number = row.number;
    const job: Job = {
      child: null,
      cancelled: false,
      events: [],
      done: false,
    };
    this.jobs.set(number, job);
    void this.worker
      .run(
        row,
        "login",
        (message) => {
          if (message.kind === "child") {
            job.child = message.child;
            if (job.cancelled) message.child.kill();
          } else if (message.kind === "notify") job.events.push(message.event);
          else if (message.kind === "prompt") {
            job.prompt = { id: message.id, type: message.prompt.type };
            job.events.push({ prompt: message.prompt });
          }
        },
        directory,
      )
      .then(() => {
        if (!job.cancelled) success();
        job.done = true;
      })
      .catch(() => {
        this.store.run(
          "UPDATE accounts SET status='error',last_error=? WHERE number=?",
          "登录未完成",
          number,
        );
        job.done = true;
      })
      .finally(cleanup);
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
    if (!job || !job.prompt || job.done || job.cancelled || !job.child)
      throw new Problem(409, "没有待回答的登录请求");
    job.child.send({ id: job.prompt.id, value });
    job.prompt = undefined;
    return { accepted: true };
  }
  cancel(number: number) {
    const job = this.jobs.get(number);
    if (job && !job.done) {
      job.cancelled = true;
      job.child?.kill();
      this.store.run(
        "UPDATE accounts SET status='error',last_error='登录未完成' WHERE number=?",
        number,
      );
    }
    return { cancelled: true };
  }
}
