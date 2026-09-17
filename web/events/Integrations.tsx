import { useEffect, useState, type FormEvent } from "react";
import { GitPullRequest, X } from "lucide-react";
import type { Overview, Subscription } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { CopyLine } from "../components/CopyLine.tsx";
export function Integrations({
  overview,
  revision,
  refresh,
}: {
  overview: Overview;
  revision: number;
  refresh: () => void;
}) {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]),
    [agentId, setAgentId] = useState(overview.agents[0]?.id ?? "");
  const [repository, setRepository] = useState(""),
    [event, setEvent] = useState("pull_request.opened"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Subscription[]>("/subscriptions")
      .then(setSubscriptions)
      .catch((e) => setError(e.message));
  }, [revision]);
  const events = {
    "pull_request.opened": "新建 PR",
    "pull_request.reopened": "重新打开 PR",
    "pull_request.synchronize": "更新 PR 提交",
    "pull_request.closed": "关闭或合入 PR",
  };
  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/agents/${agentId}/subscriptions`, "POST", {
        repository,
        event,
      });
      setRepository("");
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="main-header">
        <div>
          <h1>事件订阅</h1>
          <p>把外部世界的消息，送到合适的 Agent。</p>
        </div>
      </header>
      <div className="integration-content">
        <div className="integration-title">
          <GitPullRequest size={24} />
          <h2>GitHub</h2>
          <span
            className={`status-pill ${overview.github_enabled ? "ready" : ""}`}
          >
            {overview.github_enabled ? "已配置验签" : "尚未配置"}
          </span>
        </div>
        <details className="setup-help" open={!overview.github_enabled}>
          <summary>Webhook 接入说明</summary>
          <p>
            使用环境变量 <code>ATRIUM_GITHUB_SECRET</code>{" "}
            配置验签密钥，重启后端；GitHub Webhook 使用相同 Secret 和 JSON
            格式。
          </p>
          <CopyLine text={`${location.origin}/webhooks/github`} />
          <p>
            GitHub 需要可达的 HTTPS 回调。当前是本机地址，接入时只对外转发这个
            Webhook 路径，不公开管理接口。
          </p>
        </details>
        <h3 className="section-title">订阅规则</h3>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {subscriptions.length ? (
          <div className="subscription-list">
            {subscriptions.map((s) => (
              <div className="subscription" key={s.id}>
                <div>
                  <strong>{s.repository}</strong>
                  <p>
                    {events[s.event as keyof typeof events] ?? s.event}{" "}
                    <span>→</span>{" "}
                    {overview.agents.find((a) => a.id === s.agent_id)?.name}
                  </p>
                </div>
                <button
                  className="icon-button"
                  aria-label={`删除 ${s.repository} 的订阅`}
                  onClick={() => {
                    void api(
                      `/agents/${s.agent_id}/subscriptions/${s.id}`,
                      "DELETE",
                    )
                      .then(refresh)
                      .catch((e) => setError(e.message));
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            还没有订阅。添加后，匹配的 PR 事件会进入 Agent 收件箱。
          </p>
        )}
        <form className="subscribe-form" onSubmit={add}>
          <label>
            接收 Agent
            <select
              required
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="" disabled>
                选择 Agent
              </option>
              {overview.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            仓库
            <input
              required
              placeholder="owner/repository"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            />
          </label>
          <label>
            事件
            <select value={event} onChange={(e) => setEvent(e.target.value)}>
              {Object.entries(events).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="button" disabled={!agentId || busy}>
            {busy ? "添加中…" : "添加订阅"}
          </button>
        </form>
      </div>
    </>
  );
}
