import { readFileSync } from "node:fs";

export interface ConversationEntry {
  role: "user" | "assistant";
  text: string;
  at: string;
}

const MAX_USER_CHARS = 4000;
const MAX_ASSISTANT_CHARS = 3000;
/** The last assistant message before the task is usually the plan being approved. */
const MAX_LAST_ASSISTANT_CHARS = 10_000;
/** Budget for the whole conversation sent to the model; oldest assistant text goes first. */
const MAX_TOTAL_CHARS = 60_000;

/**
 * The conversation that led to a task: user messages and the assistant's
 * prose (no tool calls or results) with `since < timestamp <= until`, read
 * from the Claude Code transcript. User answers like "ok, go" only make sense
 * next to the proposals they accept, hence the assistant text.
 */
export function readConversation(transcriptPath: string, since: string | undefined, until: string): ConversationEntry[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const entries: ConversationEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof e.timestamp === "string" ? e.timestamp : "";
    if (!at || (since && at <= since) || at > until) continue;
    // subagents, skill expansions and other injected content are not the conversation
    if (e.isSidechain || e.isMeta) continue;
    if (e.type === "user" && e.message?.role === "user") {
      const text = userText(e.message.content);
      if (text) entries.push({ role: "user", text: clip(text, MAX_USER_CHARS), at });
    } else if (e.type === "assistant" && e.message?.role === "assistant") {
      const text = blocks(e.message.content, "text");
      if (text) appendAssistant(entries, text, at);
    }
  }
  const lastAssistant = entries.findLastIndex((e) => e.role === "assistant");
  entries.forEach((e, i) => {
    if (e.role === "assistant") e.text = clip(e.text, i === lastAssistant ? MAX_LAST_ASSISTANT_CHARS : MAX_ASSISTANT_CHARS);
  });
  return fitBudget(entries);
}

/** Plain text of a user message, or "" when it is not something the user typed. */
function userText(content: unknown): string {
  if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) return "";
  let text = typeof content === "string" ? content : blocks(content, "text");
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (/^\[Request interrupted by user/.test(text)) return "";
  // Slash commands and skills: keep what was typed ("/name args"), drop the markup.
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name) {
    if (/^\/(?:[\w-]+:)?flow$/.test(name)) return ""; // fcc's own commands are not requests
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
    return `${name} ${args}`.trim();
  }
  if (/^<(local-command|bash-)/.test(text)) return "";
  return text;
}

function blocks(content: unknown, type: string): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === type && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/** One assistant turn is streamed as several entries: merge consecutive ones. */
function appendAssistant(entries: ConversationEntry[], text: string, at: string): void {
  const last = entries[entries.length - 1];
  if (last?.role === "assistant") last.text = `${last.text}\n${text}`;
  else entries.push({ role: "assistant", text, at });
}

function fitBudget(entries: ConversationEntry[]): ConversationEntry[] {
  let total = entries.reduce((n, e) => n + e.text.length, 0);
  for (const e of entries.slice(0, -2)) {
    if (total <= MAX_TOTAL_CHARS) break;
    if (e.role !== "assistant") continue;
    total -= e.text.length - 1;
    e.text = "…";
  }
  return entries;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
