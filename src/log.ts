import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fccHome } from "./paths.ts";

/** Hooks and background jobs must never break the user's session: log and swallow. */
export function logError(context: string, err: unknown): void {
  try {
    mkdirSync(fccHome(), { recursive: true });
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(path.join(fccHome(), "fcc.log"), `${new Date().toISOString()} [${context}] ${msg}\n`);
  } catch {
    // nothing left to do
  }
}
