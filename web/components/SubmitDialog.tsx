import { useState, type FormEvent, type ReactNode } from "react";
import { Modal } from "./Modal.tsx";

export function SubmitDialog({
  title,
  close,
  submit,
  children,
  submitLabel = "创建",
  pendingLabel = "创建中…",
}: {
  title: string;
  close: () => void;
  submit: (data: FormData) => Promise<void>;
  children: ReactNode;
  submitLabel?: string;
  pendingLabel?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await submit(data);
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={title}
      close={() => {
        if (!busy) close();
      }}
    >
      <form className="px-6 py-[22px] [&>p]:mb-5 [&>p]:text-xs [&>p]:leading-[1.8] [&_details]:mb-[18px] [&_details>summary]:mb-3.5 [&_details>summary]:cursor-pointer [&_details>summary]:text-xs [&_details>summary]:text-[#6c6456]" onSubmit={save}>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {children}
        <div className="mt-[25px] flex justify-end gap-[9px]">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={close}
          >
            取消
          </button>
          <button className="button" disabled={busy}>
            {busy ? pendingLabel : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
