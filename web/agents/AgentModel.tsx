import { useEffect, useState, type FormEvent } from "react";
import {
  modelBase,
  splitModelSpec,
  THINKING_LEVELS,
  type ModelChange,
  type ModelState,
} from "../../shared/model.ts";
import { api } from "../api.ts";

/**
 * 身份用哪个模型。这是运行底座，由用户设定，Agent 的工具面没有这一项。
 * 自己取数、自己管加载与错误；只在打开和保存后各取一次，不随抽屉刷新反复问 Pi。
 */
export function AgentModel({ agentId }: { agentId: string }) {
  const [state, setState] = useState<ModelState | null>(null);
  const [error, setError] = useState(""),
    [notes, setNotes] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const [model, setModel] = useState(""),
    [thinking, setThinking] = useState("");
  function adopt(next: ModelState) {
    setState(next);
    setError("");
    const spec = next.configured ? splitModelSpec(next.configured) : null;
    setModel(spec ? `${spec.provider}/${spec.model}` : "");
    setThinking(spec?.thinking ?? "");
  }
  useEffect(() => {
    let alive = true;
    setState(null);
    setNotes([]);
    api<ModelState>(`/agents/${agentId}/model`)
      .then((next) => {
        if (alive) adopt(next);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [agentId]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotes([]);
    try {
      const { notes: reported, ...next } = await api<ModelChange>(
        `/agents/${agentId}/model`,
        "PUT",
        { model: `${model.trim()}${thinking ? `:${thinking}` : ""}` },
      );
      adopt(next);
      setNotes(reported);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!state)
    return (
      <section className="settings-section">
        <h3>模型</h3>
        {error ? (
          <p className="error">{error}</p>
        ) : (
          <p className="muted small-text">读取中…</p>
        )}
      </section>
    );
  // 配置里写的模型可能不在这份清单里（清单是上次取到的），把它补进去才选得中。
  const choices =
    state.configured && !state.options.includes(modelBase(state.configured))
      ? [modelBase(state.configured), ...state.options]
      : state.options;
  return (
    <form onSubmit={save} className="settings-section">
      <h3>模型</h3>
      <p className="muted">
        用哪个模型由你定，Agent 自己改不了。
        {state.live ? "它正在运行，保存后当场生效。" : "保存后下次启动时生效。"}
      </p>
      {state.running && state.running !== modelBase(state.configured ?? "") && (
        <p className="muted small-text">
          运行中实际在用：<code className="path">{state.running}</code>
        </p>
      )}
      <label className="form-label">
        模型
        {choices.length ? (
          <select
            className="field"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="" disabled>
              选择模型
            </option>
            {choices.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="field"
            required
            placeholder="provider/id"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
      </label>
      <label className="form-label">
        思考强度
        <select
          className="field"
          value={thinking}
          onChange={(e) => setThinking(e.target.value)}
        >
          <option value="">跟随模型默认</option>
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      {!choices.length && (
        <p className="muted small-text">
          还没取到过这个身份的可选模型，启动它之后这里会变成下拉选择。
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {notes.map((note) => (
        <p key={note} className="muted small-text">
          {note}
        </p>
      ))}
      <button className="button" disabled={busy || !model.trim()}>
        {busy ? "保存中…" : "保存模型"}
      </button>
    </form>
  );
}
