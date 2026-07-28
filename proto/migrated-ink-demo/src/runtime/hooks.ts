// LIA-495 — state-derivation hooks ported from web-first-demo's
// runtime/hooks.ts (itself ported from full-shell.tsx). All of these read
// from `useAuiState`, which is re-exported unchanged by both
// `@assistant-ui/react` and `@assistant-ui/react-ink` (both come from the
// single backend-neutral `@assistant-ui/store` package) — so the state
// SHAPE these hooks read (`s.thread.isRunning`, `s.thread.messages`,
// per-tool-call `.approval`/`.result`) is identical on ink. Only the import
// specifier changed back (`@assistant-ui/react-ink` instead of
// `@assistant-ui/react`, mirroring the same swap web-first-demo made in the
// other direction from full-shell.tsx).
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react-ink";
import { GERUND_WORDS } from "./tokens";

// ---------------------------------------------------------------------------
// useShellStatus — identical logic to full-shell.tsx's useShellStatus.
// ---------------------------------------------------------------------------
export type ShellStatus = "idle" | "working" | "awaiting approval";

export function useShellStatus(): ShellStatus {
  return useAuiState((s) => {
    if (s.thread.isRunning) return "working";
    const lastAssistant = [...s.thread.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant?.role === "assistant" && lastAssistant.status?.type === "requires-action") {
      return "awaiting approval";
    }
    return "idle";
  });
}

// ---------------------------------------------------------------------------
// useRotatingGerund — identical logic to full-shell.tsx's hook of the same
// name. Pure React state/interval; no ink or DOM API involved either way,
// so this needed no change beyond the import path.
// ---------------------------------------------------------------------------
export function useRotatingGerund(intervalMs = 950): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % GERUND_WORDS.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return GERUND_WORDS[i]!;
}

// ---------------------------------------------------------------------------
// Task-status hooks — ported verbatim from full-shell.tsx's
// useToolTaskStatus / useApprovalTaskStatus. Drive the web TasksFooter the
// same way they drove the ink LiveChecklist: real, observed thread state,
// never fabricated.
// ---------------------------------------------------------------------------
export type TaskStatus = "pending" | "active" | "done" | "blocked";

export function useToolTaskStatus(toolName: string, matchCommand?: string): TaskStatus {
  return useAuiState((s) => {
    for (const m of s.thread.messages) {
      if (m.role !== "assistant") continue;
      for (const c of m.content) {
        if (c.type !== "tool-call" || c.toolName !== toolName) continue;
        if (matchCommand !== undefined) {
          const cmd = (c.args as Record<string, unknown> | undefined)?.command;
          if (cmd !== matchCommand) continue;
        }
        if (c.approval && c.approval.approved === false) return "blocked";
        if (c.result !== undefined) return c.isError ? "blocked" : "done";
        return "active";
      }
    }
    return "pending";
  });
}

// delete_file's result is deliberately never set (see runtime/permissions.ts
// header comment), so its task's completion is read from
// `approval.approved` instead of `result` — same distinction full-shell.tsx
// makes.
export function useApprovalTaskStatus(toolName: string): TaskStatus {
  return useAuiState((s) => {
    for (const m of s.thread.messages) {
      if (m.role !== "assistant") continue;
      for (const c of m.content) {
        if (c.type !== "tool-call" || c.toolName !== toolName) continue;
        if (!c.approval) return "pending";
        if (c.approval.resolution) return "blocked";
        if (c.approval.approved === undefined) return "active";
        return c.approval.approved ? "done" : "blocked";
      }
    }
    return "pending";
  });
}
