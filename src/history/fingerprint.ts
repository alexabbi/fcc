import { createHash } from "node:crypto";

/**
 * Content fingerprint of a task: hashes of the meaningful lines it added and
 * removed, per file. Commits are matched against it by content, not by id, so
 * the link survives squash, rebase and cherry-pick (S5). It is also the only
 * way to match later: the before/after snapshot trees are unreferenced git
 * objects and get pruned by `git gc`.
 */
export interface Fingerprint {
  [path: string]: { add: string[]; del: string[] };
}

const MAX_LINES_PER_FILE = 2000;

/** Lines like `}`, `);` or `</div>` say nothing about which change they belong to. */
export function lineKey(line: string): string | null {
  const t = line.trim();
  if (t.replace(/[\s{}()[\];,<>/]/g, "").length < 3) return null;
  return createHash("sha1").update(t).digest("hex").slice(0, 10);
}

/** Parse a unified diff (git diff / git show, any context) into per-file added/removed keys. */
export function fingerprintFromDiff(diff: string): Fingerprint {
  const fp: Fingerprint = {};
  let current: { add: string[]; del: string[] } | undefined;
  // Only before a file's first hunk can `---`/`+++` be headers: inside a hunk,
  // "--- x" is a removed line starting with "--" (an SQL comment, say).
  let inHeader = false;
  const fileEntry = (p: string) => (fp[p] ??= { add: [], del: [] });
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      inHeader = true;
      current = undefined;
    } else if (inHeader) {
      if (line.startsWith("--- ") && line !== "--- /dev/null") current = fileEntry(line.slice(4).replace(/^a\//, ""));
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") current = fileEntry(line.slice(4).replace(/^b\//, ""));
      else if (line.startsWith("@@")) inHeader = false;
    } else if (current && line.startsWith("+")) {
      const k = lineKey(line.slice(1));
      if (k && current.add.length < MAX_LINES_PER_FILE) current.add.push(k);
    } else if (current && line.startsWith("-")) {
      const k = lineKey(line.slice(1));
      if (k && current.del.length < MAX_LINES_PER_FILE) current.del.push(k);
    }
  }
  for (const [p, v] of Object.entries(fp)) if (!v.add.length && !v.del.length) delete fp[p];
  return fp;
}
