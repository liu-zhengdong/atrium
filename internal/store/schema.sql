-- Atrium v2 全部表。开发期不做迁移：改表就改这里，删掉开发库重建。
-- 时间一律 Unix 毫秒；短号（t1、o1……）由 ids 表发，全局持久、不复用。

CREATE TABLE IF NOT EXISTS ids (
  prefix TEXT PRIMARY KEY,
  last   INTEGER NOT NULL
);

-- 暂停范围：all、部门 oN、机器 hN。
CREATE TABLE IF NOT EXISTS pauses (
  scope TEXT PRIMARY KEY,
  by    TEXT NOT NULL,
  at    INTEGER NOT NULL
);

-- 身份：用户 u1、秘书 secretary、负责人 aN。workers 是负责人的执行者组合（逗号分隔档案名）。
CREATE TABLE IF NOT EXISTS identities (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('user', 'secretary', 'leader')),
  name       TEXT NOT NULL,
  workers    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO identities (id, kind, name, created_at) VALUES ('u1', 'user', '用户', 0);
INSERT OR IGNORE INTO identities (id, kind, name, created_at) VALUES ('secretary', 'secretary', '秘书', 0);

-- 备忘：每个身份一份，覆盖写。
CREATE TABLE IF NOT EXISTS memos (
  identity   TEXT PRIMARY KEY REFERENCES identities (id),
  body       TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 部门：树；what/uses/now/next 是给人看的介绍（是什么、怎么用、现状、下一步）。
CREATE TABLE IF NOT EXISTS departments (
  id         TEXT PRIMARY KEY,
  parent     TEXT REFERENCES departments (id),
  name       TEXT NOT NULL,
  what       TEXT NOT NULL DEFAULT '',
  uses       TEXT NOT NULL DEFAULT '',
  now        TEXT NOT NULL DEFAULT '',
  next       TEXT NOT NULL DEFAULT '',
  leader     TEXT REFERENCES identities (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS departments_parent ON departments (parent);

CREATE TABLE IF NOT EXISTS department_repos (
  department TEXT NOT NULL REFERENCES departments (id),
  repo       TEXT NOT NULL,
  PRIMARY KEY (department, repo)
);

-- 验收人：部门级设置，沿树继承；没有这一行就继承上级，都没设为 auto（运行时）。
-- 单独一张表而不是 departments 的一列：建表语句对旧库也生效，加列不会。
CREATE TABLE IF NOT EXISTS acceptors (
  department TEXT PRIMARY KEY REFERENCES departments (id),
  who        TEXT NOT NULL CHECK (who IN ('auto', 'leader', 'user'))
);

-- 要点：一句规矩；同部门按 pos（1 起）排序，靠前的优先。
CREATE TABLE IF NOT EXISTS points (
  id         TEXT PRIMARY KEY,
  department TEXT NOT NULL REFERENCES departments (id),
  pos        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  why        TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL,
  check_ref  TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS points_department ON points (department, pos);

-- 技能：按名字，每次修改追加一版（rev 递增），读取取最大 rev；文件在数据目录 skills/<名字>/r<rev>/。
-- workers：优先执行者（逗号分隔档案名）；checks：交付要查什么（逗号分隔）；secrets：这类活要的凭据名（逗号分隔）。
CREATE TABLE IF NOT EXISTS skills (
  name       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  files      INTEGER NOT NULL,
  workers    TEXT NOT NULL DEFAULT '',
  checks     TEXT NOT NULL DEFAULT '',
  secrets    TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (name, rev)
);

-- 任务：只留必要列；其余事实查 task_events。
-- status：todo queued running done failed blocked cancelled
-- stage：'' gate review merge_queue merged released（交付阶段）
-- priority：urgent fix normal idle
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  parent      TEXT REFERENCES tasks (id),
  department  TEXT REFERENCES departments (id),
  skill       TEXT,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT '',
  priority    TEXT NOT NULL DEFAULT 'normal',
  repo        TEXT NOT NULL DEFAULT '',
  worker      TEXT NOT NULL DEFAULT '',
  host        TEXT NOT NULL DEFAULT '',
  pr          TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_department ON tasks (department);

-- 任务的工作地点：本机文件夹的绝对路径，执行者直接在里面干（不建工作树、不复制）。没有这一行就是没有工作地点。
-- 单独一张表而不是 tasks 的一列：建表语句对旧库也生效，加列不会。
CREATE TABLE IF NOT EXISTS task_dirs (
  task TEXT PRIMARY KEY REFERENCES tasks (id),
  dir  TEXT NOT NULL
);

-- 草稿记的发现：来源（user 用户纠正／org 组织发现）与类（按原因归的类名，如「执行者可用性」）；转待派、完成后也还带着。
-- 三个目标的数（纠正、复发）从这里算。没有这一行就是没记。单独一张表的理由同 task_dirs。
CREATE TABLE IF NOT EXISTS task_findings (
  task   TEXT PRIMARY KEY REFERENCES tasks (id),
  source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'user', 'org')),
  class  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS task_findings_class ON task_findings (class);

-- 负责人在问用户的话（leader escalate --kind ask）：一件任务最多一条，只在待派时有；等回话期间不计时。
-- 用户回话（task tell）或负责人自己 task tell 撤回时删掉；任务离开待派（派出、结束等）时一并删掉。单独一张表的理由同 task_dirs。
CREATE TABLE IF NOT EXISTS task_asks (
  task TEXT PRIMARY KEY REFERENCES tasks (id),
  text TEXT NOT NULL,
  at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_deps (
  task       TEXT NOT NULL REFERENCES tasks (id),
  depends_on TEXT NOT NULL REFERENCES tasks (id),
  PRIMARY KEY (task, depends_on)
);
CREATE INDEX IF NOT EXISTS task_deps_on ON task_deps (depends_on);

-- 任务的全部经历：状态变化、备注、交付检查结论、交回……body 是 JSON 或纯文本。
CREATE TABLE IF NOT EXISTS task_events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  task  TEXT NOT NULL REFERENCES tasks (id),
  at    INTEGER NOT NULL,
  kind  TEXT NOT NULL,
  actor TEXT NOT NULL,
  body  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task, id);
CREATE INDEX IF NOT EXISTS task_worktrees ON task_events (id) WHERE kind = 'worktree';
CREATE INDEX IF NOT EXISTS task_worktrees_reclaimed ON task_events (task, body) WHERE kind = 'worktree_reclaimed';
CREATE INDEX IF NOT EXISTS task_worker_lifecycle ON task_events (task, kind, id) WHERE kind = 'launch' OR kind = 'exit';

-- 分派任务队列：task run 的入队选项（opts：执行者、风险、机器、凭据名，JSON）。队列本身是状态 queued 的任务，
-- 按任务优先级（tasks.priority）、入队先后取；没有这一行（交回）时沿用上次拉起的执行者。
CREATE TABLE IF NOT EXISTS queue (
  task        TEXT PRIMARY KEY REFERENCES tasks (id),
  enqueued_at INTEGER NOT NULL,
  opts        TEXT NOT NULL DEFAULT '',
  by          TEXT NOT NULL DEFAULT ''
);

-- 定时任务：到点在部门下生成一件普通任务（kind：task patrol research）。
-- every_ms 周期，0 是一次性的（next_at 触发一次，生成任务后删掉这条）；at_minute 本机钟点（当天第几分钟，只给整天的周期）；skips 累计跳过轮数，last_note 最近一笔。
CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY,
  department  TEXT NOT NULL REFERENCES departments (id),
  kind        TEXT NOT NULL CHECK (kind IN ('task', 'patrol', 'research')),
  every_ms    INTEGER NOT NULL,
  at_minute   INTEGER,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  skill       TEXT NOT NULL DEFAULT '',
  next_at     INTEGER NOT NULL,
  last_run_at INTEGER,
  last_task   TEXT REFERENCES tasks (id),
  skips       INTEGER NOT NULL DEFAULT 0,
  last_note   TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (next_at);

-- 选项单：调研后提给用户的 3–5 个方向；recommend 是推荐的项（逗号分隔 pos）。
CREATE TABLE IF NOT EXISTS choices (
  id         TEXT PRIMARY KEY,
  department TEXT NOT NULL REFERENCES departments (id),
  task       TEXT UNIQUE REFERENCES tasks (id),
  title      TEXT NOT NULL,
  recommend  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('open', 'picked', 'passed', 'void')),
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS choices_department ON choices (department, status);

-- 选项：能多做到什么（gain）、为什么现在（why_now）、代价（cost）、不做会怎样（if_not）、依据（evidence）。
CREATE TABLE IF NOT EXISTS choice_options (
  choice   TEXT NOT NULL REFERENCES choices (id),
  pos      INTEGER NOT NULL,
  title    TEXT NOT NULL,
  gain     TEXT NOT NULL,
  why_now  TEXT NOT NULL,
  cost     TEXT NOT NULL,
  if_not   TEXT NOT NULL,
  evidence TEXT NOT NULL,
  task     TEXT REFERENCES tasks (id),
  PRIMARY KEY (choice, pos)
);

-- 选项归哪个部门：选中后建的任务落到这里、交给这里往上最近的负责人；没有这一行落到出选项单的部门。
-- 单独一张表而不是 choice_options 的一列：建表语句对旧库也生效，加列不会。
CREATE TABLE IF NOT EXISTS choice_option_orgs (
  choice     TEXT NOT NULL REFERENCES choices (id),
  pos        INTEGER NOT NULL,
  department TEXT NOT NULL REFERENCES departments (id),
  PRIMARY KEY (choice, pos)
);

-- 资料：一个文件或一个目录是一条资料。内容存数据目录 materials/<mN>/r<rev>/<相对路径>，这里记元数据；每改一次追加一版，读取取最大 rev。
-- file 是正文文件的相对路径（空表示没有正文，如图片集）；size 是这一版全部文件的字节数，units 是其中文本文件的字数，binary 是正文是否二进制。
-- 归档只标 archived_at（整条资料，记在最新版上）。
CREATE TABLE IF NOT EXISTS materials (
  id          TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  department  TEXT NOT NULL REFERENCES departments (id),
  kind        TEXT NOT NULL CHECK (kind IN ('overview', 'detail')),
  title       TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  file        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  units       INTEGER NOT NULL,
  binary      INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (id, rev)
);
CREATE INDEX IF NOT EXISTS materials_department ON materials (department, title);

-- 资料每一版的全部文件（含正文）的元数据。
CREATE TABLE IF NOT EXISTS material_files (
  id     TEXT NOT NULL,
  rev    INTEGER NOT NULL,
  path   TEXT NOT NULL,
  size   INTEGER NOT NULL,
  units  INTEGER NOT NULL,
  binary INTEGER NOT NULL,
  PRIMARY KEY (id, rev, path),
  FOREIGN KEY (id, rev) REFERENCES materials (id, rev)
);

-- 资料正文计量一次性重算的完成标记；与计量更新同事务写入。
CREATE TABLE IF NOT EXISTS material_metering (
  version INTEGER PRIMARY KEY CHECK (version = 1)
);

-- 机器：本机 h1，远程 hN。接入码与机器令牌只存哈希；info、load 是代理上报的 JSON；repos 是自动分派任务能接的仓库（JSON 数组，"*" 为全部）。
CREATE TABLE IF NOT EXISTS hosts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
  repos           TEXT NOT NULL DEFAULT '[]',
  max_running     INTEGER,
  join_hash       TEXT NOT NULL DEFAULT '',
  join_expires_at INTEGER,
  token_hash      TEXT NOT NULL DEFAULT '',
  info            TEXT NOT NULL DEFAULT '',
  load            TEXT NOT NULL DEFAULT '',
  ssh_target      TEXT NOT NULL DEFAULT '',
  ssh_key         TEXT NOT NULL DEFAULT '',
  tunnel_local    INTEGER,
  tunnel_remote   INTEGER,
  last_seen_at    INTEGER,
  created_at      INTEGER NOT NULL
);

-- 远程运行：每个任务在远程的当前这一轮（第几轮、哪台、pid、日志收到哪个字节、退出）。
CREATE TABLE IF NOT EXISTS host_runs (
  task       TEXT PRIMARY KEY REFERENCES tasks (id),
  host       TEXT NOT NULL,
  run        INTEGER NOT NULL,
  pid        INTEGER NOT NULL DEFAULT 0,
  log_file   TEXT NOT NULL,
  log_offset INTEGER NOT NULL DEFAULT 0,
  exit_code  INTEGER,
  exit_lost  INTEGER NOT NULL DEFAULT 0,
  exited_at  INTEGER,
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS host_runs_host ON host_runs (host, exited_at);

-- 凭据：只存名称，值在数据目录凭据区文件里。
CREATE TABLE IF NOT EXISTS secrets (
  department   TEXT NOT NULL REFERENCES departments (id),
  name         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (department, name)
);

-- 上限已提醒：某部门（或全局，scope 空串）某项刚到或超限时发过要处理事件。
-- 回到上限以内才删这一行，再超再发。watch 巡检读写；不靠事件表去重（ack 与重启之后仍要记住）。
CREATE TABLE IF NOT EXISTS limit_notices (
  scope TEXT NOT NULL,
  key   TEXT NOT NULL,
  used  INTEGER NOT NULL,
  at    INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

-- 执行者档案：spec 是 YAML（工具、模型、强度、能接什么活、checks、trust……），由 workers 包解析。
CREATE TABLE IF NOT EXISTS worker_profiles (
  name       TEXT PRIMARY KEY,
  spec       TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 执行者不可用标记：「工具+模型@机器」此刻接不了活（额度用尽、没登录、缺运行环境、模型名无效），挑执行者与机器时跳过。
-- model 为空表示这台上这个工具的全部模型；until 为 0 等人处理（workers edit --clear），否则到点自动恢复。
CREATE TABLE IF NOT EXISTS worker_marks (
  tool     TEXT NOT NULL,
  model    TEXT NOT NULL,
  host     TEXT NOT NULL,
  kind     TEXT NOT NULL,
  reason   TEXT NOT NULL,
  evidence TEXT NOT NULL,
  until    INTEGER NOT NULL,
  since    INTEGER NOT NULL,
  PRIMARY KEY (tool, model, host)
);

-- 负责人唤醒记录：一次唤醒拉起一条，保留 30 天（leaders.WakeRetention，唤醒循环每小时删过期的；每天几十条，保留期内几千条），
-- workers --quality 只算保留期内的，与任务拉起一起统计。
-- profile 是这次用的执行者组合；n 是第几次连续尝试（上次没处理完再唤醒为 2）；outcome 取值同任务拉起（ok、fail、setup）；
-- usage 是 workers.Usage 的 JSON。leader 不设外键：身份删掉后这个组合的记录照样计入质量统计。
CREATE TABLE IF NOT EXISTS leader_wakes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  leader      TEXT NOT NULL,
  profile     TEXT NOT NULL,
  n           INTEGER NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'fail', 'setup')),
  reason      TEXT NOT NULL DEFAULT '',
  usage       TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  at          INTEGER NOT NULL
);

-- 待投递事件：订阅者 wait 取、ack 确认；租约内不重投。target 是投递对象（aN 或 secretary）。
-- level：act 要处理、info 知会。key 是去重键：同一 target 同一 key 还没取走、没确认的合并成一条（count 加一）。
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('act', 'info')),
  key          TEXT NOT NULL DEFAULT '',
  count        INTEGER NOT NULL DEFAULT 1,
  task         TEXT REFERENCES tasks (id),
  department   TEXT REFERENCES departments (id),
  target       TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  leased_until INTEGER,
  acked_at     INTEGER,
  acked_by     TEXT
);
CREATE INDEX IF NOT EXISTS events_pending ON events (target, acked_at, id);
CREATE INDEX IF NOT EXISTS events_key ON events (key, target);

-- 额度来源：account 是 hN:provider（失败加 :fail；openquota 为既有展示摘要）；body 保留机器、来源指纹、套餐标签、窗口和原成功时刻，不证明账号/共享池。
CREATE TABLE IF NOT EXISTS quota_cache (
  account TEXT PRIMARY KEY,
  tool    TEXT NOT NULL,
  body    TEXT NOT NULL,
  read_at INTEGER NOT NULL
);

-- 额度设置：reserve_percent 是给用户留的份额（缺省 20）。
CREATE TABLE IF NOT EXISTS quota_settings (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
