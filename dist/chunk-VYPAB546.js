import {
  Problem
} from "./chunk-QCD2PKZ3.js";

// server/tasks/adapters/types.ts
import { isAbsolute } from "node:path";
var TOOLS = [
  "codex",
  "opencode",
  "claude",
  "grok",
  "kimi",
  "agy",
  "cursor"
];
var isTool = (value) => typeof value === "string" && TOOLS.includes(value);
var ARG_PROMPT_MAX_BYTES = 256 * 1024;
var DEFAULT_WATCHDOG = { startupMinutes: 3, idleMinutes: 20 };
var invalid = (message) => new Problem(400, message);
function checkArgPrompt(adapter, prompt) {
  if (!prompt.trim()) throw invalid("\u63D0\u793A\u8BCD\u4E3A\u7A7A");
  const limit = adapter.maxPromptBytes ?? ARG_PROMPT_MAX_BYTES;
  const size = Buffer.byteLength(prompt, "utf8");
  if (size > limit)
    throw invalid(
      `${adapter.tool} \u7684\u63D0\u793A\u8BCD\u8D70\u547D\u4EE4\u884C\u53C2\u6570\uFF0C${size} \u5B57\u8282\u8D85\u8FC7\u4E0A\u9650 ${limit}`
    );
}
function checkEffort(adapter, effort) {
  if (effort === void 0) return;
  if (!adapter.efforts) throw invalid(`${adapter.tool} \u4E0D\u652F\u6301\u6307\u5B9A\u601D\u8003\u5F3A\u5EA6`);
  if (!adapter.efforts.includes(effort))
    throw invalid(
      `${adapter.tool} \u7684\u601D\u8003\u5F3A\u5EA6\u53EA\u80FD\u662F ${adapter.efforts.join("\u3001")}`
    );
}
function checkCommon(adapter, input) {
  if (!isAbsolute(input.cwd)) throw invalid("\u5DE5\u4F5C\u76EE\u5F55\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
  if (!isAbsolute(input.promptFile)) throw invalid("\u63D0\u793A\u8BCD\u6587\u4EF6\u987B\u4E3A\u7EDD\u5BF9\u8DEF\u5F84");
  if (input.model !== void 0 && !/^[\w.:/@+-]+$/.test(input.model))
    throw invalid(`\u6A21\u578B id \u4E0D\u5408\u6CD5\uFF1A${input.model}`);
  checkEffort(adapter, input.effort);
  if (adapter.promptVia === "arg") checkArgPrompt(adapter, input.prompt);
}

// server/tasks/adapters/agy.ts
var SESSION_RE = /"event":"init","conversation_id":"([0-9a-f-]{36})"/;
var BUILT_IN_EFFORT = /-(low|medium|high)$/;
var NO_EFFORT = /^(?:claude-|gpt-oss-)/;
function agyModelArgs(model, effort) {
  if (!model) {
    if (effort)
      throw invalid(
        "agy \u5199\u601D\u8003\u5F3A\u5EA6\u65F6\u987B\u540C\u65F6\u5199\u6A21\u578B\uFF0C\u5982 agy+gemini-3.8-flash:high"
      );
    return [];
  }
  if (!effort) return ["--model", model];
  const built = BUILT_IN_EFFORT.exec(model)?.[1];
  if (built) {
    if (built === effort) return ["--model", model];
    throw invalid(
      `agy \u7684\u6A21\u578B ${model} \u5DF2\u5E26\u5F3A\u5EA6 ${built}\uFF0C\u4E0E :${effort} \u51B2\u7A81\uFF1B\u6362\u5F3A\u5EA6\u8BF7\u6539\u6A21\u578B\u540D\uFF08\u5982 ${model.replace(BUILT_IN_EFFORT, `-${effort}`)}\uFF09\u6216\u5199\u57FA\u540D\u52A0\u5F3A\u5EA6`
    );
  }
  if (NO_EFFORT.test(model))
    throw invalid(
      `agy \u7684 ${model} \u4E0D\u63A5\u53D7\u601D\u8003\u5F3A\u5EA6\uFF08\u5F3A\u5EA6\u542B\u5728\u6A21\u578B\u91CC\uFF09\uFF0C\u53BB\u6389 :${effort}`
    );
  return ["--model", model, "--effort", effort];
}
function args(input, session) {
  const list = input.live ? ["-p", "", "--input-format", "stream-json"] : [`--print=${input.prompt}`];
  list.push(
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--disable-slash-commands"
  );
  if (session) list.push("--conversation", session);
  list.push(...agyModelArgs(input.model, input.effort));
  return list;
}
var agy = {
  tool: "agy",
  executable: "agy",
  promptVia: "arg",
  defaultModel: "claude-opus-4-6-thinking",
  exclusive: false,
  efforts: ["low", "medium", "high", "max"],
  quotaProvider: "antigravity",
  resumeArgs: ["--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "claude-* \u4E0E gpt-oss-* \u6A21\u578B\u4E0D\u63A5\u53D7\u601D\u8003\u5F3A\u5EA6\uFF1Bgemini \u7528\u5E26\u5F3A\u5EA6\u7684\u6A21\u578B\u540D\u6216\u57FA\u540D\u52A0 :\u5F3A\u5EA6",
    "\u989D\u5EA6\u6309\u6A21\u578B\u5206\u6876\uFF08Gemini\u3001Claude \u5404\u4E00\u4EFD\uFF09\uFF0C\u7528\u5C3D\u6807\u8BB0\u6309\u6574\u4E2A antigravity \u8D26\u53F7\u8BB0"
  ],
  tell: "stdin",
  checkModel(model, effort) {
    agyModelArgs(model, effort);
  },
  build(input) {
    checkCommon(agy, input);
    return launch(input);
  },
  resume(input) {
    checkCommon(agy, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`\u4F1A\u8BDD id \u4E0D\u5408\u6CD5\uFF1A${input.session}`);
    return launch(input, input.session);
  },
  sessionOf: (log) => SESSION_RE.exec(log)?.[1]
};
function launch(input, session) {
  return {
    command: agy.executable,
    args: args(input, session),
    cwd: input.cwd,
    ...input.live ? {
      stdin: input.promptFile,
      input: "stream-json",
      inputDialect: "agy"
    } : {}
  };
}

// server/tasks/adapters/claude.ts
var SESSION_RE2 = /"type":"system","subtype":"init"[^\n]*?"session_id":"([0-9a-f-]{36})"/;
function args2(input) {
  const list = ["-p", "--output-format", "stream-json", "--verbose"];
  if (input.live)
    list.push("--input-format", "stream-json", "--replay-user-messages");
  list.push("--permission-mode", "bypassPermissions");
  if (input.model) list.push("--model", input.model);
  if (input.effort) list.push("--effort", input.effort);
  return list;
}
var claude = {
  tool: "claude",
  executable: "claude",
  promptVia: "stdin",
  defaultModel: "opus",
  exclusive: false,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  quotaProvider: "claude",
  skillMount: "claude-plugin",
  resumeArgs: ["-p", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: ["\u5DE5\u4F5C\u76EE\u5F55\u7531\u8FDB\u7A0B cwd \u51B3\u5B9A\uFF0C\u6CA1\u6709 --cwd \u53C2\u6570"],
  tell: "stdin",
  build(input) {
    checkCommon(claude, input);
    return {
      command: claude.executable,
      args: args2(input),
      cwd: input.cwd,
      stdin: input.promptFile,
      ...input.live ? { input: "stream-json" } : {}
    };
  },
  resume(input) {
    checkCommon(claude, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`\u4F1A\u8BDD id \u4E0D\u5408\u6CD5\uFF1A${input.session}`);
    const list = args2(input);
    list.splice(1, 0, "--resume", input.session);
    return {
      command: claude.executable,
      args: list,
      cwd: input.cwd,
      stdin: input.promptFile,
      ...input.live ? { input: "stream-json" } : {}
    };
  },
  sessionOf: (log) => SESSION_RE2.exec(log)?.[1]
};

// server/tasks/adapters/codex.ts
import { dirname, join } from "node:path";
var codex = {
  tool: "codex",
  executable: "codex",
  promptVia: "stdin",
  defaultModel: "gpt-6-sol",
  exclusive: false,
  efforts: ["minimal", "low", "medium", "high", "xhigh"],
  quotaProvider: "codex",
  skillMount: "codex-home",
  resumeArgs: ["exec", "resume", "--last"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["\u63D0\u793A\u8BCD\u8D70 stdin\uFF08PROMPT \u5199 -\uFF09\uFF0C\u907F\u514D\u53C2\u6570\u957F\u5EA6\u4E0A\u9650"],
  tell: "resume",
  build(input) {
    checkCommon(codex, input);
    const resultFile = input.resultFile ?? join(dirname(input.promptFile), "last-message.md");
    const args4 = ["exec", "-C", input.cwd, "-s", "danger-full-access"];
    if (input.model) args4.push("-m", input.model);
    if (input.effort)
      args4.push("-c", `model_reasoning_effort="${input.effort}"`);
    args4.push("-o", resultFile, "-");
    return {
      command: codex.executable,
      args: args4,
      cwd: input.cwd,
      stdin: input.promptFile,
      resultFile
    };
  },
  resume(input) {
    checkCommon(codex, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`\u4F1A\u8BDD id \u4E0D\u5408\u6CD5\uFF1A${input.session}`);
    const resultFile = input.resultFile ?? join(dirname(input.promptFile), "last-message.md");
    const args4 = ["exec", "resume", "-c", 'sandbox_mode="danger-full-access"'];
    if (input.model) args4.push("-m", input.model);
    if (input.effort)
      args4.push("-c", `model_reasoning_effort="${input.effort}"`);
    args4.push("-o", resultFile, input.session, "-");
    return {
      command: codex.executable,
      args: args4,
      cwd: input.cwd,
      stdin: input.promptFile,
      resultFile
    };
  },
  sessionOf: (log) => /^session id: ([0-9a-f-]{36})$/m.exec(log)?.[1]
};

// server/tasks/adapters/cursor.ts
var EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
var SESSION_RE3 = /"type":"system","subtype":"init"[^\n]*?"session_id":"([0-9a-f-]{36})"/;
function cursorModel(model, effort) {
  if (effort === void 0) return model;
  if (model === "auto")
    throw invalid(
      "cursor \u7684 auto \u7531 Cursor \u81EA\u5DF1\u6311\u6A21\u578B\uFF0C\u4E0D\u80FD\u6307\u5B9A\u601D\u8003\u5F3A\u5EA6\uFF1B\u8981\u6307\u5B9A\u5F3A\u5EA6\u8BF7\u5199\u5177\u4F53\u6A21\u578B\uFF0C\u5982 cursor+gpt-5.3-codex:high"
    );
  const fast = model.endsWith("-fast");
  const base = fast ? model.slice(0, -"-fast".length) : model;
  const has = EFFORTS.find((e) => base.endsWith(`-${e}`));
  if (has)
    throw invalid(
      `cursor \u7684\u6A21\u578B\u540D ${model} \u5DF2\u5E26\u5F3A\u5EA6 ${has}\uFF0C\u4E0D\u8981\u518D\u5199 :${effort}`
    );
  return `${base}-${effort}${fast ? "-fast" : ""}`;
}
function args3(input) {
  const list = [
    "-p",
    "--output-format",
    "stream-json",
    "--force",
    "--trust",
    "--sandbox",
    "disabled",
    "--workspace",
    input.cwd
  ];
  const model = input.model ?? cursor.defaultModel;
  list.push("--model", cursorModel(model, input.effort));
  return list;
}
var cursor = {
  tool: "cursor",
  executable: "cursor-agent",
  promptVia: "stdin",
  defaultModel: "auto",
  exclusive: false,
  efforts: EFFORTS,
  quotaProvider: "cursor",
  resumeArgs: ["-p", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "\u5F3A\u5EA6\u5199\u8FDB\u6A21\u578B\u540D\u540E\u7F00\uFF08gpt-5.3-codex:high \u2192 gpt-5.3-codex-high\uFF09\uFF0Cauto \u4E0D\u80FD\u6307\u5B9A\u5F3A\u5EA6",
    "\u634E\u8BDD\u6CA1\u6709\u8F93\u5165\u6D41\uFF0C\u672C\u8F6E\u7ED3\u675F\u540E\u6309\u4F1A\u8BDD\u7EED\u4E0A"
  ],
  tell: "resume",
  defaultRules: { trust: "unknown", max_risk: "low" },
  checkModel(model, effort) {
    cursorModel(model ?? cursor.defaultModel, effort);
  },
  build(input) {
    checkCommon(cursor, input);
    return {
      command: cursor.executable,
      args: args3(input),
      cwd: input.cwd,
      stdin: input.promptFile
    };
  },
  resume(input) {
    checkCommon(cursor, input);
    if (!/^[0-9a-f-]{36}$/.test(input.session))
      throw invalid(`\u4F1A\u8BDD id \u4E0D\u5408\u6CD5\uFF1A${input.session}`);
    const list = args3(input);
    list.splice(1, 0, "--resume", input.session);
    return {
      command: cursor.executable,
      args: list,
      cwd: input.cwd,
      stdin: input.promptFile
    };
  },
  sessionOf: (log) => SESSION_RE3.exec(log)?.[1]
};

// server/tasks/adapters/grok.ts
var grok = {
  tool: "grok",
  executable: "grok",
  promptVia: "arg",
  defaultModel: "grok-4.6",
  exclusive: false,
  efforts: ["low", "medium", "high"],
  quotaProvider: "grok",
  resumeArgs: ["--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["grok-4.6 \u6613\u628A\u903B\u8F91\u5806\u8FDB\u4E00\u4E2A\u6587\u4EF6\uFF0C\u9A8C\u6536\u67E5 file_growth"],
  tell: "restart",
  build(input) {
    checkCommon(grok, input);
    const args4 = ["-p", input.prompt];
    if (input.model) args4.push("-m", input.model);
    if (input.effort) args4.push("--reasoning-effort", input.effort);
    args4.push("--always-approve", "--cwd", input.cwd);
    return { command: grok.executable, args: args4, cwd: input.cwd };
  }
};

// server/tasks/adapters/kimi.ts
var kimi = {
  tool: "kimi",
  executable: "kimi",
  promptVia: "arg",
  defaultModel: void 0,
  exclusive: false,
  efforts: void 0,
  quotaProvider: "kimi",
  resumeArgs: ["--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["log_growth", "worktree_change"],
  notes: [
    "\u53EA\u7528 -p\uFF0C\u4E0D\u52A0 -y/--auto",
    "\u9000\u51FA\u65F6\u53EF\u80FD\u6709\u5185\u90E8\u62A5\u9519\u4F46\u6D3B\u5DF2\u5E72\u5B8C\uFF0C\u4EE5\u5B9E\u9645\u4EA7\u7269\u4E3A\u51C6"
  ],
  tell: "restart",
  build(input) {
    checkCommon(kimi, input);
    const args4 = ["-p", input.prompt];
    if (input.model) args4.push("-m", input.model);
    return { command: kimi.executable, args: args4, cwd: input.cwd };
  }
};

// server/tasks/adapters/opencode.ts
var opencode = {
  tool: "opencode",
  executable: "opencode",
  promptVia: "arg",
  defaultModel: "opencode-go/mimo-v2.6-flash",
  // 同一数据目录并发会死锁或 SQLITE_BUSY（上游 anomalyco/opencode#29395、#21215）。
  exclusive: true,
  efforts: ["minimal", "low", "medium", "high", "max"],
  quotaProvider: "opencode",
  skillMount: "opencode-config",
  resumeArgs: ["run", "--continue"],
  watchdog: DEFAULT_WATCHDOG,
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "cwd \u5FC5\u987B\u662F\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u76EE\u5F55\u5916\u8BBF\u95EE\u4F1A\u88AB\u62D2",
    "\u540C\u4E00\u65F6\u523B\u53EA\u8DD1\u4E00\u4E2A",
    "\u62C9\u8D77\u73AF\u5883\u53BB\u6389 HERDR_*\uFF0C\u5426\u5219\u5361\u5728 init",
    "\u5E38\u505C\u5728\u63D0\u4EA4\u524D\uFF0C\u9A8C\u6536\u67E5 finished"
  ],
  tell: "restart",
  build(input) {
    checkCommon(opencode, input);
    const args4 = ["run", "--format", "json", "--auto"];
    if (input.model) args4.push("-m", input.model);
    if (input.effort) args4.push("--variant", input.effort);
    args4.push("--", input.prompt);
    return { command: opencode.executable, args: args4, cwd: input.cwd };
  }
};

// server/tasks/adapters/index.ts
var ADAPTERS = {
  codex,
  opencode,
  claude,
  grok,
  kimi,
  agy,
  cursor
};

// server/tasks/worker-profiles.ts
var PROFILE_MAX_BYTES = 64 * 1024;

// shared/user.ts
var SECRETARY = "secretary";

// server/tasks/ledger-model.ts
var TREE_MAX = 2e3;
var TREE_ROOTS = 30;
var TREE_RECENT = 10;
var usage = (message, next) => new Problem(400, message, "usage", void 0, next);

// server/tasks/brief.ts
var BRIEF_MAX_BYTES = 64 * 1024;
var briefBytes = (text) => Buffer.byteLength(text, "utf8");
function briefTooLong(bytes, field = "brief") {
  return usage(
    `${field}: \u4EFB\u52A1\u8BE6\u8FF0 ${Math.ceil(bytes / 1024)} KB\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${BRIEF_MAX_BYTES / 1024} KB\uFF1B\u8BF7\u7CBE\u7B80\uFF0C\u957F\u6750\u6599\u653E\u8FDB\u4ED3\u5E93\u6587\u4EF6\u3001\u8BE6\u8FF0\u91CC\u5199\u8DEF\u5F84`
  );
}

export {
  TOOLS,
  isTool,
  ADAPTERS,
  SECRETARY,
  TREE_MAX,
  TREE_ROOTS,
  TREE_RECENT,
  BRIEF_MAX_BYTES,
  briefBytes,
  briefTooLong
};
