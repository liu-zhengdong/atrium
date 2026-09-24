import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { matches } from "./types.ts";
import type { Agent } from "../components/AgentAvatar.tsx";
import { trackUnsaved } from "./unsaved.ts";
import { modelLabel } from "../agents/AgentModel.tsx";

type Entry =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };
type Defaults = {
  packages: Entry[];
  skills: string[];
  model: { provider: string; model: string } | null;
};
const source = (entry: Entry) =>
  typeof entry === "string" ? entry : entry.source;

export function AgentDefaultsPage({
  query,
  agents,
}: {
  query: string;
  agents: Agent[];
}) {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [template, setTemplate] = useState<Defaults | null>(null);
  const [newPackage, setNewPackage] = useState("");
  const [newSkill, setNewSkill] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [packageQuery, setPackageQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [modelChoices, setModelChoices] = useState<string[]>([]);
  useEffect(() => trackUnsaved(dirty), [dirty]);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<Defaults>("/settings/agent-defaults"),
      api<Defaults>("/settings/agent-defaults/template"),
    ])
      .then(([value, base]) => {
        if (active) {
          setDefaults(value);
          setTemplate(base);
          setModel(
            value.model ? `${value.model.provider}/${value.model.model}` : "",
          );
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    api<string[]>("/settings/agent-defaults/models")
      .then((options) => {
        if (active) setModelChoices(options);
      })
      .catch(() => {
        if (active) setModelChoices([]);
      });
    return () => {
      active = false;
    };
  }, [agents.map((agent) => agent.id).join(",")]);
  function update(value: Defaults) {
    setDefaults(value);
    setSaved(false);
    setDirty(true);
  }
  async function applyInstant(value: Defaults, selectedModel = model) {
    const previous = defaults;
    const oldModel = model;
    const oldDirty = dirty;
    setDefaults(value);
    setModel(selectedModel);
    setBusy(true);
    setError("");
    try {
      const split = selectedModel.indexOf("/");
      const saved = await api<Defaults>("/settings/agent-defaults", "PUT", {
        ...value,
        model: selectedModel
          ? {
              provider: selectedModel.slice(0, split),
              model: selectedModel.slice(split + 1),
            }
          : null,
      });
      setDefaults(saved);
      setDirty(false);
      setSaved(true);
    } catch (reason) {
      setDirty(oldDirty);
      setDefaults(previous);
      setModel(oldModel);
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!defaults) return;
    const split = model.indexOf("/");
    if (model && (split < 1 || split === model.length - 1)) {
      setError("请选择可用模型");
      return;
    }
    if (
      model &&
      !modelChoices.includes(model) &&
      model !==
        (defaults.model
          ? `${defaults.model.provider}/${defaults.model.model}`
          : "")
    ) {
      setError("请选择可用模型");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const value = await api<Defaults>("/settings/agent-defaults", "PUT", {
        ...defaults,
        model: model
          ? { provider: model.slice(0, split), model: model.slice(split + 1) }
          : null,
      });
      setDefaults(value);
      setDirty(false);
      setSaved(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  const packageChoices =
    template && defaults
      ? [
          ...template.packages,
          ...defaults.packages.filter(
            (entry) =>
              !template.packages.some((item) => source(item) === source(entry)),
          ),
        ]
      : [];
  const skillChoices =
    template && defaults
      ? [...new Set([...template.skills, ...defaults.skills])]
      : [];
  return (
    <div className="space-y-6">
      <header>
        <h1 className="m-0 text-xl font-medium">新 Agent 默认配置</h1>
        <p className="mt-2 text-xs text-muted">
          只影响之后新建的身份；从已有 Agent 复制时沿用来源配置。
        </p>
      </header>
      {!defaults && !error && (
        <p className="text-xs text-muted">正在读取默认配置…</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {defaults && (
        <form className="space-y-5" onSubmit={(event) => void save(event)}>
          <section className="rounded-2xl bg-white p-5 shadow-lift">
            <h2 className="text-sm font-medium">插件</h2>
            {packageChoices.length > 8 && (
              <input
                className="field mb-3"
                aria-label="筛选插件"
                placeholder="筛选插件"
                value={packageQuery}
                onChange={(event) => setPackageQuery(event.target.value)}
              />
            )}
            <div className="space-y-1">
              {packageChoices
                .filter(
                  (item) =>
                    matches(query, source(item)) &&
                    matches(packageQuery, source(item)),
                )
                .map((entry) => (
                  <label
                    key={source(entry)}
                    className="switch-row !m-0 !flex !items-center !justify-between !gap-2 rounded-lg !px-2 !py-1 text-xs hover:bg-soft"
                  >
                    <span className="min-w-0 break-all">{source(entry)}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`启用插件 ${source(entry)}`}
                      className="accent-accent"
                      checked={defaults.packages.some(
                        (item) => source(item) === source(entry),
                      )}
                      disabled={busy}
                      onChange={(event) =>
                        void applyInstant({
                          ...defaults,
                          packages: event.target.checked
                            ? [...defaults.packages, entry]
                            : defaults.packages.filter(
                                (item) => source(item) !== source(entry),
                              ),
                        })
                      }
                    />
                  </label>
                ))}
              {!packageChoices.length && (
                <p className="text-xs text-muted">个人 Pi 没有可选插件</p>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="field min-w-[160px] flex-1"
                value={newPackage}
                onChange={(event) => setNewPackage(event.target.value)}
                placeholder="npm:包名、git:地址或绝对路径"
                aria-label="新增默认插件"
              />
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  const value = newPackage.trim();
                  if (
                    value &&
                    !packageChoices.some((entry) => source(entry) === value)
                  )
                    update({
                      ...defaults,
                      packages: [...defaults.packages, value],
                    });
                  setNewPackage("");
                }}
              >
                添加
              </button>
            </div>
          </section>
          <section className="rounded-2xl bg-white p-5 shadow-lift">
            <h2 className="text-sm font-medium">技能</h2>
            {skillChoices.length > 8 && (
              <input
                className="field mb-3"
                aria-label="筛选技能"
                placeholder="筛选技能"
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
              />
            )}
            <div className="space-y-1">
              {skillChoices
                .filter(
                  (skill) =>
                    matches(query, skill) && matches(skillQuery, skill),
                )
                .map((skill) => (
                  <label
                    key={skill}
                    className="switch-row !m-0 !flex !items-center !justify-between !gap-2 rounded-lg !px-2 !py-1 text-xs hover:bg-soft"
                  >
                    <span className="min-w-0 break-all">{skill}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`启用技能 ${skill}`}
                      className="accent-accent"
                      checked={defaults.skills.includes(skill)}
                      disabled={busy}
                      onChange={(event) =>
                        void applyInstant({
                          ...defaults,
                          skills: event.target.checked
                            ? [...defaults.skills, skill]
                            : defaults.skills.filter((item) => item !== skill),
                        })
                      }
                    />
                  </label>
                ))}
              {!skillChoices.length && (
                <p className="text-xs text-muted">个人 Pi 没有可选技能</p>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="field min-w-[160px] flex-1"
                value={newSkill}
                onChange={(event) => setNewSkill(event.target.value)}
                placeholder="技能目录名称"
                aria-label="新增默认技能"
              />
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  const value = newSkill.trim();
                  if (value && !defaults.skills.includes(value))
                    update({
                      ...defaults,
                      skills: [...defaults.skills, value],
                    });
                  setNewSkill("");
                }}
              >
                添加
              </button>
            </div>
          </section>
          <section className="rounded-2xl bg-white p-5 shadow-lift">
            <label className="form-label">
              默认模型
              <select
                className="field mt-2"
                value={model}
                disabled={busy}
                onChange={(event) =>
                  void applyInstant(defaults, event.target.value)
                }
              >
                <option value="">由 Pi 决定</option>
                {model && !modelChoices.includes(model) && (
                  <option value={model}>{modelLabel(model)}（已有配置）</option>
                )}
                {modelChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {modelLabel(choice)}
                  </option>
                ))}
              </select>
              {!modelChoices.length && (
                <span className="text-xs text-muted">
                  {agents.some((agent) => agent.runtime)
                    ? "运行中的 Pi 未返回模型清单，请检查模型配置"
                    : agents.some((agent) => agent.agent_directory)
                      ? "尚无可选模型；启动身份取得清单后再选择"
                      : "创建并启动身份后可选择模型"}
                </span>
              )}
            </label>
          </section>
          <button className="button" disabled={busy || !dirty}>
            {busy ? "保存中…" : saved ? "已保存" : "保存默认配置"}
          </button>
        </form>
      )}
    </div>
  );
}
