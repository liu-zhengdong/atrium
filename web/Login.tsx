import { useEffect, useState } from "react";
import { Copy, Check, LockKeyhole } from "lucide-react";
import { api } from "./api.ts";

/** No password form: the local CLI proves ownership of the user token. */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (window.location.hostname !== "atrium.localhost") return;
    const timer = setInterval(() => {
      void api<{ authenticated: boolean }>("/auth/session")
        .then((result) => {
          if (result.authenticated) onLogin();
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [onLogin]);
  const copy = async () => {
    await navigator.clipboard.writeText("atrium open");
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <main className="min-h-screen flex items-center justify-center bg-stone-50 px-6 text-stone-900">
      <section className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <LockKeyhole
          size={25}
          strokeWidth={1.7}
          className="text-stone-600"
          aria-hidden="true"
        />
        <h1 className="mt-6 text-2xl font-semibold">登录 Atrium</h1>
        <p className="mt-3 leading-7 text-stone-600">
          在终端运行 <strong className="text-stone-900">atrium open</strong>{" "}
          登录。命令会打开已登录的页面。
        </p>
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-6 flex items-center gap-2 rounded-lg border border-stone-300 px-4 py-2 text-sm hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-700"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? "已复制" : "复制命令"}
        </button>
      </section>
    </main>
  );
}

export function AuthGate() {
  const [status, setStatus] = useState<"checking" | "logged-out" | "logged-in">(
    "checking",
  );
  useEffect(() => {
    void api<{ authenticated: boolean }>("/auth/session")
      .then((result) =>
        setStatus(result.authenticated ? "logged-in" : "logged-out"),
      )
      .catch(() => setStatus("logged-out"));
    const unauthenticated = () => setStatus("logged-out");
    window.addEventListener("atrium:auth-required", unauthenticated);
    return () =>
      window.removeEventListener("atrium:auth-required", unauthenticated);
  }, []);
  if (status === "checking")
    return (
      <main className="min-h-screen grid place-items-center text-stone-600">
        正在连接 Atrium…
      </main>
    );
  if (status === "logged-out")
    return <Login onLogin={() => setStatus("logged-in")} />;
  // Do not mount subscriptions and history before authentication.
  return <AuthenticatedApp />;
}

import { App as AuthenticatedApp } from "./App.tsx";
