import { useState } from "react";
import { Check, Copy } from "lucide-react";
export function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button
        className="icon-button"
        aria-label="复制命令"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              setFailed(false);
              setTimeout(() => setCopied(false), 1500);
            },
            () => setFailed(true),
          );
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {failed && <span>请手动复制</span>}
    </div>
  );
}
