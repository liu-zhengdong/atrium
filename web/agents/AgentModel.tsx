import { useEffect, useState } from "react";
import {
  modelBase,
  splitModelSpec,
  THINKING_LEVELS,
  type ModelChange,
  type ModelState,
} from "../../shared/model.ts";
import { api } from "../api.ts";

const levels: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};
export const modelLabel = (value: string) => {
  const spec = splitModelSpec(value);
  if (!spec) return value;
  const readable = spec.model
    .replace(/^claude-/, "Claude ")
    .replace(/^gpt-/, "GPT ")
    .replace(/-/g, " ");
  return `${readable} · ${spec.provider}`;
};

export function AgentModel({
  agentId,
  compact = false,
}: {
  agentId: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<ModelState | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  function adopt(next: ModelState) {
    setState(next);
    const spec = next.configured ? splitModelSpec(next.configured) : null;
    setModel(spec ? `${spec.provider}/${spec.model}` : "");
    setThinking(spec?.thinking ?? "");
  }
  useEffect(() => {
    let active = true;
    setState(null);
    void api<ModelState>(`/agents/${agentId}/model`)
      .then((next) => {
        if (active) adopt(next);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [agentId]);
  async function change(nextModel: string, nextThinking: string) {
    const previous = state;
    setModel(nextModel);
    setThinking(nextThinking);
    setError("");
    setNotes([]);
    if (!nextModel) return;
    setBusy(true);
    try {
      const { notes: reported, ...next } = await api<ModelChange>(
        `/agents/${agentId}/model`,
        "PUT",
        { model: `${nextModel}${nextThinking ? `:${nextThinking}` : ""}` },
      );
      adopt(next);
      setNotes(reported);
    } catch (e) {
      if (previous) adopt(previous);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const choices = state
    ? state.configured && !state.options.includes(modelBase(state.configured))
      ? [modelBase(state.configured), ...state.options]
      : state.options
    : [];
  return (
    <section className={compact ? "space-y-2" : "settings-section"}>
      {!state ? (
        <p className="text-xs text-muted">{error || "读取中…"}</p>
      ) : (
        <>
          <label className="form-label">
            {compact ? "模型 · 账号" : "模型"}
            {state.options.length ? (
              <select
                className="field"
                aria-label="选择模型"
                disabled={busy}
                value={model}
                onChange={(e) => void change(e.target.value, thinking)}
              >
                <option value="" disabled>
                  选择模型
                </option>
                {choices.map((choice) => (
                  <option value={choice} key={choice}>
                    {modelLabel(choice)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="field"
                aria-label="模型"
                placeholder="provider/id"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => {
                  if (model && model !== modelBase(state.configured ?? ""))
                    void change(model, thinking);
                }}
              />
            )}
          </label>
          {!compact && (
            <label className="form-label">
              思考强度
              <select
                className="field"
                disabled={busy || !model}
                value={thinking}
                onChange={(e) => void change(model, e.target.value)}
              >
                <option value="">跟随模型默认</option>
                {THINKING_LEVELS.map((level) => (
                  <option value={level} key={level}>
                    {levels[level]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!state.options.length && (
            <p className="text-xs text-muted">
              没取到可选模型清单；可以手动填写 provider/id，切换失败会恢复原值。
            </p>
          )}
          {state.running &&
            state.running !== "unknown/unknown" &&
            state.running !== modelBase(state.configured ?? "") && (
              <p className="text-xs text-muted">
                运行中：{modelLabel(state.running)}
              </p>
            )}
        </>
      )}
      {error && state && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="text-xs text-muted">
          {note}
        </p>
      ))}
    </section>
  );
}
