import { useState } from "react";
import type { Attachment } from "../../shared/schema.ts";
import { api } from "../api.ts";
import { uploadAttachment } from "./Attachments.tsx";

const MAX_PER_MESSAGE = 10;

/** 每个会话各自的待发附件，切换会话不互相干扰。 */
export function useStagedAttachments({
  chatId,
  onError,
}: {
  chatId: string | null;
  onError: (message: string) => void;
}) {
  const [staged, setStaged] = useState<Record<string, Attachment[]>>({});
  const [uploading, setUploading] = useState(false);
  const attached = chatId ? (staged[chatId] ?? []) : [];
  async function add(list: FileList | File[] | null) {
    if (!chatId || !list?.length) return;
    const files = [...list];
    if (attached.length + files.length > MAX_PER_MESSAGE) {
      onError(`每条最多 ${MAX_PER_MESSAGE} 个附件`);
      return;
    }
    setUploading(true);
    onError("");
    try {
      const uploaded: Attachment[] = [];
      for (const file of files) uploaded.push(await uploadAttachment(file));
      setStaged((old) => ({
        ...old,
        [chatId]: [...(old[chatId] ?? []), ...uploaded],
      }));
    } catch (e) {
      onError(String(e));
    } finally {
      setUploading(false);
    }
  }
  async function remove(id: string) {
    if (!chatId) return;
    try {
      await api(`/attachments/${id}`, "DELETE");
      setStaged((old) => ({
        ...old,
        [chatId]: (old[chatId] ?? []).filter((item) => item.id !== id),
      }));
    } catch (e) {
      onError(String(e));
    }
  }
  const clear = (id: string) => setStaged((old) => ({ ...old, [id]: [] }));
  return {
    attached,
    uploading,
    add,
    remove,
    clear,
    full: attached.length >= MAX_PER_MESSAGE,
  };
}
