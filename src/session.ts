import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sessionDir } from "./paths.ts";

/** State of the task currently running in a session (between prompt and Stop). */
export interface CurrentTask {
  repoRoot: string;
  beforeTree: string;
  startedAt: string;
  prompt: string;
}

export interface ToolRecord {
  tool: string;
  /** Absolute paths the tool wrote; empty for Bash. */
  files: string[];
}

const CURRENT = "current.json";
const TOOLS = "tools.jsonl";

export function beginTask(sessionId: string, task: CurrentTask): void {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  rmSync(path.join(dir, TOOLS), { force: true });
  writeFileSync(path.join(dir, CURRENT), JSON.stringify(task, null, 2));
}

export function readCurrentTask(sessionId: string): CurrentTask | null {
  try {
    return JSON.parse(readFileSync(path.join(sessionDir(sessionId), CURRENT), "utf8"));
  } catch {
    return null;
  }
}

/** Append-only so concurrent PostToolUse hooks never clobber each other. */
export function recordTool(sessionId: string, record: ToolRecord): void {
  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, TOOLS), JSON.stringify(record) + "\n");
}

export function readToolRecords(sessionId: string): ToolRecord[] {
  let text: string;
  try {
    text = readFileSync(path.join(sessionDir(sessionId), TOOLS), "utf8");
  } catch {
    return [];
  }
  const records: ToolRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // a torn line from a crashed hook; skip it
    }
  }
  return records;
}

export function endTask(sessionId: string): void {
  const dir = sessionDir(sessionId);
  rmSync(path.join(dir, CURRENT), { force: true });
  rmSync(path.join(dir, TOOLS), { force: true });
}
