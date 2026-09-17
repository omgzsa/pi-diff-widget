import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateDiffString, isToolCallEventType, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TurnEdit {
  path: string;
  /** ANSI-rendered display diff. */
  diff: string;
}

export interface Turn {
  index: number;
  prompt: string;
  edits: TurnEdit[];
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
    )
    .map((block) => block.text)
    .join(" ")
    .trim();
}

/**
 * Rebuild per-turn edits from the session branch, using only data pi already
 * persisted. No git and no filesystem access. The `edit` tool stores its display
 * diff in `details.diff`; the `write` tool stores nothing, so pair this with
 * `registerWriteSnapshots` for full coverage.
 */
export function collectTurns(ctx: ExtensionContext): Turn[] {
  const branch = ctx.sessionManager.getBranch();

  const callArguments = new Map<string, Record<string, unknown>>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const block of entry.message.content) {
      if (block.type === "toolCall") callArguments.set(block.id, block.arguments ?? {});
    }
  }

  const turns: Turn[] = [];
  let current: Turn | undefined;

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "user") {
      current = { index: turns.length, prompt: extractText(message.content), edits: [] };
      turns.push(current);
      continue;
    }

    if (message.role !== "toolResult" || message.toolName !== "edit") continue;
    const diff = (message.details as { diff?: string } | undefined)?.diff;
    if (!diff) continue;

    const args = callArguments.get(message.toolCallId);
    const path = typeof args?.path === "string" ? args.path : "(unknown)";
    current?.edits.push({ path, diff });
  }

  return turns;
}

/**
 * The `write` result carries no diff (`details: undefined`). Capture the
 * previous file content before the write runs so a diff can be synthesized once
 * it finishes. New files diff against empty content, which is what we want.
 */
export function registerWriteSnapshots(pi: ExtensionAPI): void {
  const pending = new Map<string, { path: string; before?: string }>();

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("write", event)) return;
    const absolutePath = resolve(ctx.cwd, event.input.path);
    const before = await readFile(absolutePath, "utf8").catch(() => undefined);
    pending.set(event.toolCallId, { path: event.input.path, before });
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isWriteToolResult(event)) return;
    const snapshot = pending.get(event.toolCallId);
    if (!snapshot) return;
    pending.delete(event.toolCallId);

    const after = await readFile(resolve(ctx.cwd, snapshot.path), "utf8").catch(() => "");
    const { diff } = generateDiffString(snapshot.before ?? "", after);

    // TODO: attach `diff` to the active turn and persist it with
    // pi.appendEntry("pi-diff:turn", { turnIndex, path, diff }) so it survives
    // session reload. Unused until the per-turn UI lands.
    void diff;
  });
}
