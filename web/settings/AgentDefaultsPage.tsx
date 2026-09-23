import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { matches } from "./types.ts";

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

export function AgentDefaultsPage({ query }: { query: string }) {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [template, setTemplate] = useState<Defaults | null>(null);
  const [newPackage, setNewPackage] = useState("");
  const [newSkill, setNewSkill] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
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
  function update(value: Defaults) {
    setDefaults(value);
    setSaved(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!defaults) return;
    const split = model.indexOf("/");
    if (model && (split < 1 || split === model.length - 1)) {
      setError("模型格式：provider/model");
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
            <p className="mb-3 text-xs text-muted">
              从个人 Pi 复制已安装包；额外添加的包会在创建时安装。
            </p>
            <div className="max-h-[270px] space-y-1 overflow-y-auto">
              {packageChoices
                .filter((item) => matches(query, source(item)))
                .map((entry) => (
                  <label
                    key={source(entry)}
                    className="flex items-start gap-2 rounded-lg px-2 py-2 text-xs hover:bg-soft"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent"
                      checked={defaults.packages.some(
                        (item) => source(item) === source(entry),
                      )}
                      onChange={(event) =>
                        update({
                          ...defaults,
                          packages: event.target.checked
                            ? [...defaults.packages, entry]
                            : defaults.packages.filter(
                                (item) => source(item) !== source(entry),
                              ),
                        })
                      }
                    />
                    <span className="min-w-0 break-all">{source(entry)}</span>
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
            <p className="mb-3 text-xs text-muted">
              选择要从个人 Pi 复制的技能目录。
            </p>
            <div className="max-h-[220px] space-y-1 overflow-y-auto">
              {skillChoices
                .filter((skill) => matches(query, skill))
                .map((skill) => (
                  <label
                    key={skill}
                    className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs hover:bg-soft"
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={defaults.skills.includes(skill)}
                      onChange={(event) =>
                        update({
                          ...defaults,
                          skills: event.target.checked
                            ? [...defaults.skills, skill]
                            : defaults.skills.filter((item) => item !== skill),
                        })
                      }
                    />
                    {skill}
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
              <input
                className="field mt-2"
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setSaved(false);
                }}
                placeholder="provider/model；留空由 Pi 决定"
              />
            </label>
          </section>
          <button className="button" disabled={busy}>
            {busy ? "保存中…" : saved ? "已保存" : "保存默认配置"}
          </button>
        </form>
      )}
    </div>
  );
}
