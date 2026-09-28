import {
  Problem
} from "./chunk-DNL7I37E.js";
import {
  WINDOWS_SYSTEM_ENV,
  envKey
} from "./chunk-JQF35LTD.js";

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
var ARG_PROMPT_MAX_BYTES = 256 * 1024;
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
  if (input.endpoint) checkEndpoint(adapter, input.endpoint.api);
}
function endpointProblem(adapter, api) {
  const apis = adapter.endpoints?.apis ?? [];
  if (apis.includes(api)) return null;
  if (!apis.length)
    return `${adapter.tool} \u4E0D\u652F\u6301\u81EA\u5B9A\u4E49\u6A21\u578B\u7AEF\u70B9\uFF1B\u80FD\u63A5\u7684\u5185\u7F6E\u5DE5\u5177\uFF1Aopencode\uFF08openai\u3001anthropic\uFF09\u3001codex\uFF08responses\uFF09\u3001claude\uFF08anthropic\uFF09\uFF0C\u5176\u4ED6\u5DE5\u5177\u7528\u901A\u7528\u547D\u4EE4\u884C\u6267\u884C\u8005\uFF08protocol: cli\uFF09\u63A5`;
  return `${adapter.tool} \u53EA\u80FD\u63A5 ${apis.join("\u3001")} \u63A5\u53E3\u7684\u7AEF\u70B9\uFF0C\u8FD9\u4E2A\u7AEF\u70B9\u662F ${api}${adapter.tool === "codex" && api === "openai" ? "\uFF08codex \u5DF2\u4E0D\u652F\u6301 Chat Completions\uFF0COpenAI \u517C\u5BB9\u7AEF\u70B9\u8BF7\u7528 opencode \u6216\u901A\u7528\u547D\u4EE4\u884C\u6267\u884C\u8005\uFF09" : ""}`;
}
function checkEndpoint(adapter, api) {
  const problem = endpointProblem(adapter, api);
  if (problem) throw invalid(problem);
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
var endpointEnv = (input) => input.endpoint ? { env: { ANTHROPIC_BASE_URL: input.endpoint.base_url } } : {};
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
  progressSignals: ["json_events", "worktree_change"],
  notes: ["\u5DE5\u4F5C\u76EE\u5F55\u7531\u8FDB\u7A0B cwd \u51B3\u5B9A\uFF0C\u6CA1\u6709 --cwd \u53C2\u6570"],
  tell: "stdin",
  // Anthropic 兼容网关（t271）：地址走 ANTHROPIC_BASE_URL，密钥由运行时注入成 ANTHROPIC_AUTH_TOKEN。
  endpoints: { apis: ["anthropic"], keyEnv: "ANTHROPIC_AUTH_TOKEN" },
  build(input) {
    checkCommon(claude, input);
    return {
      command: claude.executable,
      args: args2(input),
      cwd: input.cwd,
      stdin: input.promptFile,
      ...input.live ? { input: "stream-json" } : {},
      ...endpointEnv(input)
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
      ...input.live ? { input: "stream-json" } : {},
      ...endpointEnv(input)
    };
  },
  sessionOf: (log) => SESSION_RE2.exec(log)?.[1]
};

// server/tasks/adapters/codex.ts
import { dirname, join } from "node:path";
function codexEndpoint(endpoint) {
  const set = (key, value) => [
    "-c",
    `model_providers.atrium.${key}=${JSON.stringify(value)}`
  ];
  return [
    "-c",
    'model_provider="atrium"',
    ...set("name", "Atrium \u81EA\u5B9A\u4E49\u7AEF\u70B9"),
    ...set("base_url", endpoint.base_url),
    ...set("wire_api", "responses"),
    ...endpoint.keyEnv ? set("env_key", endpoint.keyEnv) : []
  ];
}
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
  progressSignals: ["log_growth", "worktree_change"],
  notes: ["\u63D0\u793A\u8BCD\u8D70 stdin\uFF08PROMPT \u5199 -\uFF09\uFF0C\u907F\u514D\u53C2\u6570\u957F\u5EA6\u4E0A\u9650"],
  tell: "resume",
  endpoints: { apis: ["responses"] },
  build(input) {
    checkCommon(codex, input);
    const resultFile = input.resultFile ?? join(dirname(input.promptFile), "last-message.md");
    const args4 = ["exec", "-C", input.cwd, "-s", "danger-full-access"];
    if (input.model) args4.push("-m", input.model);
    if (input.effort)
      args4.push("-c", `model_reasoning_effort="${input.effort}"`);
    if (input.endpoint) args4.push(...codexEndpoint(input.endpoint));
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
    if (input.endpoint) args4.push(...codexEndpoint(input.endpoint));
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
var ENDPOINT_PROVIDER = "atrium";
function opencodeEndpoint(endpoint, model) {
  const options = { baseURL: endpoint.base_url };
  if (endpoint.keyEnv) options.apiKey = `{env:${endpoint.keyEnv}}`;
  const config = {
    provider: {
      [ENDPOINT_PROVIDER]: {
        npm: endpoint.api === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
        name: "Atrium \u81EA\u5B9A\u4E49\u7AEF\u70B9",
        options,
        models: { [model]: { name: model } }
      }
    }
  };
  return {
    model: `${ENDPOINT_PROVIDER}/${model}`,
    env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
  };
}
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
  progressSignals: ["json_events", "worktree_change"],
  notes: [
    "cwd \u5FC5\u987B\u662F\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u76EE\u5F55\u5916\u8BBF\u95EE\u4F1A\u88AB\u62D2",
    "\u540C\u4E00\u65F6\u523B\u53EA\u8DD1\u4E00\u4E2A",
    "\u62C9\u8D77\u73AF\u5883\u53BB\u6389 HERDR_*\uFF0C\u5426\u5219\u5361\u5728 init",
    "\u5E38\u505C\u5728\u63D0\u4EA4\u524D\uFF0C\u9A8C\u6536\u67E5 finished"
  ],
  tell: "restart",
  endpoints: { apis: ["openai", "anthropic"] },
  build(input) {
    checkCommon(opencode, input);
    if (input.endpoint && !input.model)
      throw invalid(
        "opencode \u63A5\u81EA\u5B9A\u4E49\u7AEF\u70B9\u8981\u5199\u6A21\u578B\u540D\uFF08\u6267\u884C\u8005\u6807\u8BC6 opencode+\u6A21\u578B\uFF0C\u6216\u6863\u6848 model\uFF09"
      );
    const custom = input.endpoint && opencodeEndpoint(input.endpoint, input.model);
    const model = custom ? custom.model : input.model;
    const args4 = ["run", "--format", "json", "--auto"];
    if (model) args4.push("-m", model);
    if (input.effort) args4.push("--variant", input.effort);
    args4.push("--", input.prompt);
    return {
      command: opencode.executable,
      args: args4,
      cwd: input.cwd,
      ...custom ? { env: custom.env } : {}
    };
  }
};

// server/tasks/adapters/index.ts
var BUILTIN_ADAPTERS = {
  codex,
  opencode,
  claude,
  grok,
  kimi,
  agy,
  cursor
};
var ADAPTERS = { ...BUILTIN_ADAPTERS };
var isTool = (value) => typeof value === "string" && Object.hasOwn(ADAPTERS, value);

// server/tasks/dispatch/host-load.ts
var CHECK_TIMEOUT_MINUTES = 30;
var OFF = /* @__PURE__ */ new Set(["0", "off", "none", "false"]);
function parseCount(raw, allowOff) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const text = raw.trim().toLowerCase();
  if (allowOff && OFF.has(text)) return null;
  if (!/^[1-9][0-9]{0,5}$/.test(text)) return void 0;
  return Number(text);
}
function parseLoad(raw) {
  if (raw === void 0 || raw.trim() === "") return void 0;
  const text = raw.trim().toLowerCase();
  if (OFF.has(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value < 1e6 ? value : void 0;
}
function hostLimits(env, cores) {
  const n = Math.max(1, Math.floor(cores));
  const testing = !!env.NODE_TEST_CONTEXT;
  const problems = [];
  const pick = (name, parsed, fallback) => {
    if (parsed !== void 0) return parsed;
    if (env[name] !== void 0 && env[name].trim() !== "")
      problems.push(`${name}=${env[name]} \u770B\u4E0D\u61C2\uFF0C\u6309\u7F3A\u7701\u6267\u884C`);
    return fallback;
  };
  return {
    limits: {
      cores: n,
      maxWorkers: pick(
        "ATRIUM_MAX_WORKERS",
        parseCount(env.ATRIUM_MAX_WORKERS, true),
        testing ? null : Math.max(2, Math.floor(n * 3 / 4))
      ),
      testConcurrency: pick(
        "ATRIUM_TEST_CONCURRENCY",
        parseCount(env.ATRIUM_TEST_CONCURRENCY, false) ?? void 0,
        Math.max(1, n - 1)
      ),
      checkTimeoutMs: pick(
        "ATRIUM_CHECK_TIMEOUT_MINUTES",
        parseCount(env.ATRIUM_CHECK_TIMEOUT_MINUTES, false) ?? void 0,
        CHECK_TIMEOUT_MINUTES
      ) * 6e4,
      busyCores: pick(
        "ATRIUM_BUSY_CORES",
        parseLoad(env.ATRIUM_BUSY_CORES),
        testing ? null : n * 3 / 4
      ),
      busyLoad: pick(
        "ATRIUM_BUSY_LOAD",
        parseLoad(env.ATRIUM_BUSY_LOAD),
        testing ? null : 4 * n
      )
    },
    problems
  };
}
var loadText = (load) => load >= 10 ? load.toFixed(0) : load.toFixed(1);
var coreText = (cores) => Number.isInteger(cores) ? String(cores) : cores.toFixed(1);
function hostGate(input) {
  const { running, load, limits } = input;
  const own = input.own ?? null;
  if (input.urgent) return { ok: true };
  if (limits.busyCores !== null && own !== null && own > limits.busyCores)
    return {
      ok: false,
      busy: true,
      by: "own",
      reason: `\u672C\u673A\u592A\u5FD9\uFF08Atrium \u81EA\u5DF1\u5360\u4E86 ${coreText(own)} \u6838\uFF0C\u8D85\u8FC7 ${coreText(limits.busyCores)}\uFF09\uFF0C\u964D\u4E0B\u6765\u540E\u81EA\u52A8\u62C9\u8D77`
    };
  if (limits.busyLoad !== null && load > limits.busyLoad)
    return {
      ok: false,
      busy: true,
      by: "load",
      reason: `\u672C\u673A\u592A\u5FD9\uFF08\u6574\u673A\u8D1F\u8F7D ${loadText(load)}\uFF0C\u8D85\u8FC7 ${loadText(limits.busyLoad)}\uFF09\uFF0C\u964D\u4E0B\u6765\u540E\u81EA\u52A8\u62C9\u8D77`
    };
  if (limits.maxWorkers !== null && running >= limits.maxWorkers)
    return {
      ok: false,
      busy: false,
      by: "full",
      reason: `\u672C\u673A\u540C\u65F6\u6700\u591A\u8DD1 ${limits.maxWorkers} \u4E2A\u6267\u884C\u8005\uFF0C\u6709\u6267\u884C\u8005\u7ED3\u675F\u540E\u81EA\u52A8\u62C9\u8D77`
    };
  return { ok: true };
}

// server/hosts/state.ts
import { posix, win32 } from "node:path";
var JOIN_TTL_MS = 30 * 6e4;
var flavor = (os) => os === "win32" ? win32 : posix;
function insideData(os, dataDir, target) {
  const path = flavor(os);
  if (!path.isAbsolute(target)) return false;
  const rel = path.relative(path.resolve(dataDir), path.resolve(target));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function backoffMs(attempt) {
  return Math.min(15e3, 1e3 * 2 ** Math.max(0, Math.min(attempt, 10)));
}
var isKnownTool = (value) => typeof value === "string" && TOOLS.includes(value);

// server/tasks/dispatch/worker-env.ts
import { availableParallelism } from "node:os";
var SYSTEM = /* @__PURE__ */ new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TZ",
  "TERM"
]);
var NETWORK = /* @__PURE__ */ new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE"
]);
var WINDOWS = new Set(WINDOWS_SYSTEM_ENV);
function workerAllowed(key, platform = process.platform) {
  const name = envKey(platform, key);
  return SYSTEM.has(name) || NETWORK.has(name) || name.startsWith("LC_") || platform === "win32" && WINDOWS.has(name);
}
function workerEnvironment(base = process.env, platform = process.platform) {
  const env = {};
  for (const [key, value] of Object.entries(base))
    if (value !== void 0 && workerAllowed(key, platform))
      env[envKey(platform, key)] = value;
  env.NO_COLOR = "1";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GH_PROMPT_DISABLED = "1";
  env.ATRIUM_WORKER = "1";
  env.ATRIUM_TEST_CONCURRENCY = String(
    hostLimits(base, availableParallelism()).limits.testConcurrency
  );
  return env;
}

// server/secrets/model.ts
var SECRET_NAME_MAX = 64;
var SECRET_VALUE_MAX = 16 * 1024;
var DAY = 24 * 60 * 60 * 1e3;
var STALE_MS = 90 * DAY;
var usage = (message, next) => new Problem(400, message, "usage", void 0, next);
var RESERVED_PREFIXES = [
  "ATRIUM_",
  "CLAUDE_CODE_",
  "PI_",
  "HERDR_",
  "NODE_",
  "GIT_",
  "LD_",
  "DYLD_"
];
var RESERVED_NAMES = /* @__PURE__ */ new Set([
  "CLAUDECODE",
  "NO_COLOR",
  "PAGER",
  "GH_PROMPT_DISABLED",
  "BASH_ENV",
  "ENV"
]);
function secretNameProblem(name) {
  if (!name) return "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A";
  if (name.length > SECRET_NAME_MAX)
    return `\u540D\u79F0\u4E0D\u80FD\u8D85\u8FC7 ${SECRET_NAME_MAX} \u4E2A\u5B57\u7B26`;
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    return `\u540D\u79F0\u5E94\u4E3A\u5927\u5199\u5B57\u6BCD\u5F00\u5934\u3001\u53EA\u542B\u5927\u5199\u5B57\u6BCD\u6570\u5B57\u4E0B\u5212\u7EBF\u7684\u73AF\u5883\u53D8\u91CF\u540D\uFF08\u5982 TELEGRAM_BOT_TOKEN\uFF09\uFF0C${name} \u4E0D\u662F`;
  if (workerAllowed(name, "linux") || workerAllowed(name, "win32") || RESERVED_NAMES.has(name))
    return `\u662F\u6267\u884C\u8005\u73AF\u5883\u672C\u6765\u5C31\u6709\u6216\u8FD0\u884C\u65F6\u81EA\u5DF1\u8BBE\u7684\u53D8\u91CF\uFF08${name}\uFF09\uFF0C\u6362\u4E2A\u540D\u5B57`;
  const prefix = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  if (prefix)
    return `\u524D\u7F00 ${prefix}* \u7559\u7ED9\u8FD0\u884C\u65F6\u6216\u4F1A\u6539\u53D8\u7A0B\u5E8F\u52A0\u8F7D\u65B9\u5F0F\uFF0C\u6362\u4E2A\u540D\u5B57\uFF08${name}\uFF09`;
  return null;
}
function secretValue(value) {
  if (typeof value !== "string") throw usage("\u503C: \u5E94\u4E3A\u6587\u672C");
  const text = value.replace(/\r?\n$/, "");
  if (!text) throw usage("\u503C: \u662F\u7A7A\u7684\uFF1B\u4ECE\u6807\u51C6\u8F93\u5165\u7ED9\u503C");
  if (text.includes("\0")) throw usage("\u503C: \u4E0D\u80FD\u542B\u7A7A\u5B57\u7B26");
  if (Buffer.byteLength(text) > SECRET_VALUE_MAX)
    throw usage(
      `\u503C: \u8D85\u8FC7 ${SECRET_VALUE_MAX / 1024} KB\uFF1B\u66F4\u5927\u7684\u4E1C\u897F\u6302\u6210\u8D44\u6599\uFF08atrium material add\uFF09`
    );
  return text;
}
function withSecrets(env, secrets) {
  if (!secrets) return env;
  const out = { ...env };
  for (const [name, value] of Object.entries(secrets)) {
    const problem = secretNameProblem(name);
    if (problem) throw new Error(`\u51ED\u636E\u540D\u79F0\u4E0D\u5408\u89C4\uFF1A${problem}`);
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error(`\u51ED\u636E ${name} \u7684\u503C\u65E0\u6548`);
    out[name] = value;
  }
  return out;
}

// server/tasks/workers/worker-profiles.ts
var PROFILE_MAX_BYTES = 64 * 1024;

// server/tasks/ledger/priority.ts
var PRIORITIES = ["urgent", "fix", "normal", "idle"];
var PRIORITY_LABEL = {
  urgent: "\u7D27\u6025",
  fix: "\u4FEE\u590D",
  normal: "\u666E\u901A",
  idle: "\u95F2\u65F6"
};
var ALIASES = Object.fromEntries(
  PRIORITIES.flatMap((p) => [
    [p, p],
    [PRIORITY_LABEL[p], p]
  ])
);
function parsePriority(value) {
  const found = typeof value === "string" ? ALIASES[value.trim().toLowerCase()] : void 0;
  if (!found)
    throw new Problem(
      400,
      "priority: \u53EA\u80FD\u662F \u7D27\u6025\u3001\u4FEE\u590D\u3001\u666E\u901A \u6216 \u95F2\u65F6",
      "usage"
    );
  return found;
}
var rank = (priority) => PRIORITIES.indexOf(priority);
var priorityTag = (priority) => priority && priority !== "normal" ? PRIORITY_LABEL[priority] : "";
var titleTag = (tag, title) => tag && !title.trimStart().startsWith(tag) ? tag : "";
var tagTitle = (tag, title) => {
  const shown = titleTag(tag, title);
  return shown ? `${shown} ${title}` : title;
};
function priorityCountsText(counts) {
  if (!counts) return "";
  return PRIORITIES.filter((p) => counts[p] > 0).map((p) => `${PRIORITY_LABEL[p]} ${counts[p]}`).join(" \xB7 ");
}

// server/tasks/ledger/ledger-model.ts
var TREE_MAX = 2e3;
var TREE_ROOTS = 30;
var TREE_RECENT = 10;
var usage2 = (message, next) => new Problem(400, message, "usage", void 0, next);

// server/tasks/ledger/brief.ts
var BRIEF_MAX_BYTES = 64 * 1024;
var briefBytes = (text) => Buffer.byteLength(text, "utf8");
function briefTooLong(bytes, field = "brief") {
  return usage2(
    `${field}: \u4EFB\u52A1\u8BE6\u8FF0 ${Math.ceil(bytes / 1024)} KB\uFF0C\u8D85\u8FC7\u4E0A\u9650 ${BRIEF_MAX_BYTES / 1024} KB\uFF1B\u8BF7\u7CBE\u7B80\uFF0C\u957F\u6750\u6599\u653E\u8FDB\u4ED3\u5E93\u6587\u4EF6\u3001\u8BE6\u8FF0\u91CC\u5199\u8DEF\u5F84`
  );
}

export {
  TOOLS,
  ADAPTERS,
  isTool,
  hostLimits,
  hostGate,
  workerEnvironment,
  SECRET_VALUE_MAX,
  secretNameProblem,
  secretValue,
  withSecrets,
  insideData,
  backoffMs,
  isKnownTool,
  PRIORITY_LABEL,
  parsePriority,
  rank,
  priorityTag,
  titleTag,
  tagTitle,
  priorityCountsText,
  TREE_MAX,
  TREE_ROOTS,
  TREE_RECENT,
  BRIEF_MAX_BYTES,
  briefBytes,
  briefTooLong
};
