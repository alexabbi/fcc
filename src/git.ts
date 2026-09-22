import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BUFFER = 512 * 1024 * 1024;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Absolute repo root for `cwd`, or null when not inside a git work tree. */
export function findRepoRoot(cwd: string): string | null {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return null;
  }
}

/**
 * Snapshot the whole working tree (tracked + untracked, honoring .gitignore)
 * as a git tree object, without touching the real index, HEAD or stash.
 * Starts from a copy of the real index so unchanged files are not re-hashed.
 */
export function snapshotWorkTree(repoRoot: string): string {
  const tmp = mkdtempSync(path.join(tmpdir(), "fcc-index-"));
  const indexFile = path.join(tmp, "index");
  try {
    const realIndex = path.resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-path", "index"]).trim());
    if (existsSync(realIndex)) copyFileSync(realIndex, indexFile);
    const env = { GIT_INDEX_FILE: indexFile };
    git(repoRoot, ["add", "-A", "--", "."], env);
    return git(repoRoot, ["write-tree"], env).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export type ChangeStatus = "A" | "M" | "D" | "R";

export interface FileChange {
  status: ChangeStatus;
  path: string;
  /** Only for renames. */
  oldPath?: string;
}

/** Files that differ between two trees, with rename detection. */
export function diffTrees(repoRoot: string, before: string, after: string): FileChange[] {
  const out = git(repoRoot, ["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--name-status", before, after]);
  const parts = out.split("\0").filter((p) => p !== "");
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]!;
    const kind = code[0];
    if (kind === "R") {
      const oldPath = parts[i++]!;
      changes.push({ status: "R", oldPath, path: parts[i++]! });
    } else if (kind === "C") {
      i++; // copy source; treat the copy as an addition
      changes.push({ status: "A", path: parts[i++]! });
    } else if (kind === "A" || kind === "D") {
      changes.push({ status: kind, path: parts[i++]! });
    } else {
      // M, T (type change), U: treat as modified
      changes.push({ status: "M", path: parts[i++]! });
    }
  }
  return changes;
}

export interface TreeEntry {
  mode: string;
  sha: string;
  path: string;
}

/** All blob entries of a tree, recursively. */
export function listTree(repoRoot: string, tree: string): TreeEntry[] {
  const out = git(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  const entries: TreeEntry[] = [];
  for (const line of out.split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [mode, type, sha] = line.slice(0, tab).split(" ");
    if (type !== "blob") continue;
    entries.push({ mode: mode!, sha: sha!, path: line.slice(tab + 1) });
  }
  return entries;
}

/** Read many blobs in one `git cat-file --batch` call. Returns sha -> utf8 content. */
export function readBlobs(repoRoot: string, shas: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const unique = [...new Set(shas)];
  if (unique.length === 0) return result;
  const buf = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: unique.join("\n") + "\n",
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    const [sha, type, sizeStr] = header.split(" ");
    if (type === "missing" || sizeStr === undefined) continue;
    const size = Number(sizeStr);
    result.set(sha!, buf.subarray(pos, pos + size).toString("utf8"));
    pos += size + 1; // content + trailing LF
  }
  return result;
}

/** Zero-context diff of the whole change between two trees. */
export function treeDiff(repoRoot: string, before: string, after: string): string {
  return git(repoRoot, ["diff", "-M", "-U0", "--no-color", "--no-ext-diff", before, after]);
}

/** Current HEAD commit, or undefined in a repo without commits. */
export function headCommit(repoRoot: string): string | undefined {
  try {
    return git(repoRoot, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Unified diff of one file between two trees. */
export function fileDiff(repoRoot: string, before: string, after: string, change: FileChange): string {
  const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
  return git(repoRoot, ["diff", "-M", "--no-color", "--no-ext-diff", before, after, "--", ...paths]);
}
