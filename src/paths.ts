import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/** Root of all fcc state. Overridable for tests. */
export function fccHome(): string {
  return process.env.FCC_HOME ?? path.join(homedir(), ".claude", "flow");
}

/** Stable, readable id for a repository: `<basename>-<hash of absolute path>`. */
export function repoIdFor(repoRoot: string): string {
  const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
  const base = path.basename(repoRoot).replace(/[^\w.-]/g, "_");
  return `${base}-${hash}`;
}

export function repoDir(repoId: string): string {
  return path.join(fccHome(), "repos", sanitize(repoId));
}

export function sessionDir(sessionId: string): string {
  return path.join(fccHome(), "sessions", sanitize(sessionId));
}

export function tasksDir(repoId: string): string {
  return path.join(repoDir(repoId), "tasks");
}

export function taskDir(repoId: string, taskId: string): string {
  return path.join(tasksDir(repoId), sanitize(taskId));
}

export function serverInfoPath(): string {
  return path.join(fccHome(), "server.json");
}

/** Safe single path segment: ids come from URLs and hook input. */
export function sanitize(id: string): string {
  return id.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_");
}
