import { useState } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { useLogin } from "./useAccounts.ts";

export function LoginFlow({
  id,
  finished,
  close,
}: {
  id: string;
  finished: () => void;
  close: () => void;
}) {
  const { events, status, error, answer, cancel } = useLogin(id, finished);
  const [value, setValue] = useState("");
  const [answered, setAnswered] = useState(-1);
  const promptIndex = events.findLastIndex((event) => !!event.prompt);
  const prompt =
    promptIndex > answered ? events[promptIndex]?.prompt : undefined;
  function respond(response: string) {
    void answer(response);
    setAnswered(promptIndex);
    setValue("");
  }
  return (
    <section
      className="space-y-4 rounded-xl bg-[#f5f8f5] p-4 shadow-lift"
      aria-label="OAuth 登录"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[13px] font-medium">登录 · {id}</h3>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            void cancel();
            close();
          }}
        >
          取消登录
        </button>
      </div>
      {events.map((event, index) =>
        event.type === "auth_url" && event.url ? (
          <a
            key={index}
            className="flex items-center gap-1 break-all text-xs text-accent-strong underline"
            href={event.url}
            target="_blank"
            rel="noreferrer"
          >
            打开登录链接 <ExternalLink size={13} />
          </a>
        ) : event.type === "device_code" ? (
          <p key={index} className="text-xs">
            设备码{" "}
            <strong className="select-all font-mono text-sm">
              {event.userCode}
            </strong>{" "}
            ·{" "}
            <a
              className="text-accent-strong underline"
              href={event.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              验证地址
            </a>
          </p>
        ) : event.type === "info" ? (
          <p key={index} className="text-xs text-muted">
            {event.message}
          </p>
        ) : null,
      )}
      {prompt?.options ? (
        <div className="flex flex-wrap gap-2">
          {prompt.options.map((option) => (
            <button
              className="button secondary"
              type="button"
              key={option.id}
              onClick={() => respond(option.id)}
            >
              {option.id === "browser"
                ? "浏览器登录"
                : option.id === "device_code"
                  ? "设备码登录"
                  : option.label}
            </button>
          ))}
        </div>
      ) : prompt ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            respond(value.trim());
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="min-w-[180px] flex-1 text-xs text-muted">
            {prompt.message.startsWith("Complete login in your browser")
              ? "在浏览器完成登录，或粘贴回调 code／链接"
              : prompt.message}
            <input
              className="field mt-2"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="粘贴回调 code"
              required
            />
          </label>
          <button className="button" type="submit">
            继续
          </button>
        </form>
      ) : status === "pending" ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <LoaderCircle size={14} className="spin" />
          等待登录…
        </p>
      ) : null}
      {(error || status === "error") && (
        <p role="alert" className="text-xs text-[#9a5b4b]">
          {error || "登录未完成，可重新发起登录"}
        </p>
      )}
    </section>
  );
}
