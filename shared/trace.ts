import { z } from "zod";
import { id } from "./schema.ts";
export const runtimeEvents = z
  .object({
    runtimeId: id,
    generation: id,
    sessionId: id,
    items: z
      .array(
        z
          .object({
            seq: z.number().int().positive(),
            at: z.number().int().nonnegative(),
            kind: z.enum([
              "session",
              "run_start",
              "run_end",
              "tool_start",
              "tool_end",
              "message",
              "delivery",
            ]),
            name: z.string().max(256).optional(),
            callId: z.string().max(256).optional(),
            text: z.string().max(8192).optional(),
            error: z.boolean().optional(),
            truncated: z.boolean().optional(),
          })
          .strict(),
      )
      .max(100),
    nextAfter: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    gap: z.boolean(),
  })
  .strict();
export type RuntimeEventPage = z.infer<typeof runtimeEvents>;
export type TraceItem = {
  id: number;
  session_id: string;
  generation: string;
  at: number;
  ended_at: number | null;
  kind: string;
  name: string;
  title: string;
  state: "running" | "complete" | "error" | "unknown";
  truncated: boolean;
};
export type TracePage = {
  items: TraceItem[];
  has_more: boolean;
  error: string | null;
};
export type TraceDetail = TraceItem & { input: string; output: string };
