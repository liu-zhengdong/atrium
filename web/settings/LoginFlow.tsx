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
  const { events, status, error, answer } = useLogin(id, finished);
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
    <section className="space-y-4" aria-label="OAuth 登录">
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
              className="button !border-0 !bg-[#f1f5f2] !text-[#3c5344] hover:!bg-[#e7eee9]"
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
      {status === "ready" && (
        <p className="text-xs text-accent-strong">登录成功</p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="button !border-0 !bg-transparent !text-[#3c5344] hover:!bg-[#f1f5f2]"
          onClick={close}
        >
          {status === "pending" ? "取消登录" : "关闭"}
        </button>
      </div>
    </section>
  );
}
