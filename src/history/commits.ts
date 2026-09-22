import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fingerprintFromDiff, lineKey, type Fingerprint } from "./fingerprint.ts";

/**
 * Where a task's changes ended up (S5), decided by content:
 * included / partial: its lines are in commits of the current branch;
 * uncommitted: still only in the working tree;
 * discarded: neither committed nor in the working tree any more.
 */
export type CommitState = "included" | "partial" | "uncommitted" | "discarded" | "unknown";

export interface CommitRef {
  sha: string;
  subject: string;
  date: string;
}

export interface CommitLink {
  state: CommitState;
  /** Share of the task's lines found in commits, 0–1. */
  coverage: number;
  commits: CommitRef[];
}

interface ParsedCommit extends CommitRef {
  add: Set<string>;
  del: Set<string>;
}

const INCLUDED = 0.8;
const PARTIAL = 0.2;
const MAX_COMMITS = 500;

/** Commits of the current branch since `since`, oldest first, with their line keys. */
export function loadCommits(repoRoot: string, since: string): ParsedCommit[] {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["log", `--since=${since}`, `--max-count=${MAX_COMMITS}`, "--no-merges", "--reverse", "-p", "-U0", "--no-color", "--no-ext-diff", "-M",
        "--format=%x1e%H%x1f%s%x1f%cI"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return []; // no commits yet, or not a repo any more
  }
  const commits: ParsedCommit[] = [];
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf("\n");
    const [sha, subject, date] = chunk.slice(0, nl === -1 ? undefined : nl).split("\x1f");
    const fp = fingerprintFromDiff(nl === -1 ? "" : chunk.slice(nl + 1));
    const add = new Set<string>();
    const del = new Set<string>();
    for (const f of Object.values(fp)) {
      f.add.forEach((k) => add.add(k));
      f.del.forEach((k) => del.add(k));
    }
    commits.push({ sha: sha!, subject: subject ?? "", date: date ?? "", add, del });
  }
  return commits;
}

/**
 * Match a task against commits made after it started. Keys are compared
 * regardless of path, so later renames do not break the link.
 */
export function linkTask(repoRoot: string, fp: Fingerprint, startedAt: string, commits: ParsedCommit[]): CommitLink {
  const adds = new Set(Object.values(fp).flatMap((f) => f.add));
  // A task that only deleted code is traced through its deletions.
  const side: "add" | "del" = adds.size > 0 ? "add" : "del";
  const target = side === "add" ? adds : new Set(Object.values(fp).flatMap((f) => f.del));
  if (target.size === 0) return { state: "unknown", coverage: 0, commits: [] };

  const found = new Set<string>();
  const contributing: CommitRef[] = [];
  for (const c of commits) {
    if (c.date && c.date < startedAt) continue;
    let fresh = 0;
    for (const k of c[side]) {
      if (target.has(k) && !found.has(k)) {
        found.add(k);
        fresh++;
      }
    }
    if (fresh > 0 && (fresh >= 3 || fresh / target.size >= 0.1)) {
      contributing.push({ sha: c.sha, subject: c.subject, date: c.date });
    }
  }
  const coverage = found.size / target.size;
  if (coverage >= INCLUDED) return { state: "included", coverage, commits: contributing };
  if (coverage >= PARTIAL) return { state: "partial", coverage, commits: contributing };

  // Not (really) committed: is the change still sitting in the working tree?
  const present = keysInWorkTree(repoRoot, Object.keys(fp));
  const hits = [...target].filter((k) => present.has(k)).length / target.size;
  const stillThere = side === "add" ? hits >= 0.5 : hits <= 0.5;
  return { state: stillThere ? "uncommitted" : "discarded", coverage, commits: contributing };
}

function keysInWorkTree(repoRoot: string, paths: string[]): Set<string> {
  const keys = new Set<string>();
  for (const p of paths) {
    let text: string;
    try {
      text = readFileSync(path.join(repoRoot, p), "utf8");
    } catch {
      continue; // deleted or moved since
    }
    for (const line of text.split("\n")) {
      const k = lineKey(line);
      if (k) keys.add(k);
    }
  }
  return keys;
}
