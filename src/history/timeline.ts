import path from "node:path";
import type { FileNode, FlowGraph, SymbolNode } from "../graph/types.ts";
import { readRepoGraphs } from "../tasks.ts";
import { linkTask, loadCommits, type CommitLink } from "./commits.ts";
import { buildRecord, historyDir, readRecords, type HistoryRecord } from "./record.ts";

export interface HistoryItem {
  id: string;
  startedAt: string;
  endedAt: string;
  headline: string;
  goal: string;
  feature?: string;
  session: string;
  files: number;
  asksMissing: number;
  verifyHigh: number;
  /** Full task (diffs, structure) available in this machine's cache. */
  local: boolean;
  /** `/flow private`: only in the local cache, never in the repo. */
  private: boolean;
  recordPath?: string;
  link: CommitLink;
  /** Lowercased text for the page's search box. */
  search: string;
}

export interface HistoryGroup {
  key: string;
  kind: "feature" | "commit" | "session";
  title: string;
  items: HistoryItem[];
  latest: string;
}

export interface History {
  repo: { repoId: string; root: string; name: string; dir: string };
  groups: HistoryGroup[];
  count: number;
}

/**
 * The project timeline (S11, S14): records from the repo (teammates' too)
 * merged with this machine's tasks, linked to commits by content, grouped by
 * explicit feature, else by commit, else by session.
 */
export function buildHistory(repoId: string, repoRoot: string): History {
  const byId = new Map<string, { record: HistoryRecord; path?: string; local: boolean; private: boolean }>();
  for (const { record, path: p } of readRecords(repoRoot)) {
    byId.set(record.task.id, { record, path: p, local: false, private: false });
  }
  for (const g of readRepoGraphs(repoId)) {
    if (g.status !== "ready") continue;
    const existing = byId.get(g.task.id);
    if (existing) existing.local = true;
    else byId.set(g.task.id, { record: buildRecord(g), path: g.recordPath, local: true, private: Boolean(g.task.private) });
  }

  const entries = [...byId.values()];
  const earliest = entries.map((e) => e.record.task.startedAt).sort()[0];
  const commits = earliest ? loadCommits(repoRoot, earliest) : [];

  const items: HistoryItem[] = entries.map(({ record: r, path: p, local, private: priv }) => ({
    id: r.task.id,
    startedAt: r.task.startedAt,
    endedAt: r.task.endedAt,
    headline: r.headline,
    goal: r.intent.goal,
    ...(r.task.feature ? { feature: r.task.feature } : {}),
    session: r.task.session,
    files: r.files.length,
    asksMissing: r.asks.filter((a) => a.status !== "done").length,
    verifyHigh: r.verify.filter((v) => v.priority === "high").length,
    local,
    private: priv,
    ...(p ? { recordPath: p } : {}),
    link: linkTask(repoRoot, r.fingerprint ?? {}, r.task.startedAt, commits),
    search: [
      r.headline,
      r.story,
      r.intent.goal,
      ...r.intent.decisions,
      ...r.intent.rejected,
      ...r.asks.map((a) => a.request),
      ...r.verify.map((v) => v.text),
      ...r.files.map((f) => f.path),
      r.task.feature ?? "",
    ]
      .join("\n")
      .toLowerCase(),
  }));

  const groups = new Map<string, HistoryGroup>();
  for (const it of items) {
    const commit = it.link.commits[0];
    const [key, kind, title] = it.feature
      ? [`feature:${it.feature}`, "feature" as const, it.feature]
      : commit && (it.link.state === "included" || it.link.state === "partial")
        ? [`commit:${commit.sha}`, "commit" as const, commit.subject]
        : [`session:${it.session}`, "session" as const, `Session ${it.session}`];
    const g = groups.get(key) ?? { key, kind, title, items: [], latest: "" };
    g.items.push(it);
    if (it.endedAt > g.latest) g.latest = it.endedAt;
    groups.set(key, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  for (const g of sorted) g.items.sort((a, b) => a.endedAt.localeCompare(b.endedAt));

  return {
    repo: { repoId, root: repoRoot, name: path.basename(repoRoot), dir: historyDir() },
    groups: sorted,
    count: items.length,
  };
}

/**
 * A teammate's task (or one whose local cache is gone) rebuilt from its repo
 * record, in the shape the Story view understands. No diffs: git has them.
 */
export function recordToGraph(repoId: string, repoRoot: string, taskId: string): FlowGraph | null {
  const found = readRecords(repoRoot).find((x) => x.record.task.id === taskId);
  if (!found) return null;
  const r = found.record;
  const files: FileNode[] = r.files.map((f) => ({
    kind: "file",
    id: `file:${f.path}`,
    label: path.posix.basename(f.path),
    parent: "pkg:",
    path: f.path,
    status: f.status as FileNode["status"],
    opaque: true,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    ...(f.by ? { attribution: f.by } : {}),
  }));
  const symbols: SymbolNode[] = r.symbols.map((s) => ({
    kind: "symbol",
    id: s.id,
    label: s.label,
    parent: `file:${s.path}`,
    path: s.path,
    symbolKind: s.kind as SymbolNode["symbolKind"],
    status: s.status as SymbolNode["status"],
    line: s.line,
  }));
  const graph: FlowGraph = {
    version: 1,
    task: {
      id: r.task.id,
      repoId,
      repoRoot,
      sessionId: r.task.session,
      startedAt: r.task.startedAt,
      endedAt: r.task.endedAt,
      before: "",
      after: "",
      claudeFiles: r.files.filter((f) => f.by === "claude").map((f) => f.path),
      usedBash: false,
      ...(r.task.feature ? { feature: r.task.feature } : {}),
    },
    status: "ready",
    nodes: [{ kind: "package", id: "pkg:", label: path.basename(repoRoot), dir: "" }, ...files, ...symbols],
    edges: [],
    warnings: ["Rebuilt from the repository history: diffs and call edges are not in this machine's cache."],
    recordPath: found.path,
  };
  if (r.flow) {
    graph.narrative = {
      status: "ready",
      ...(r.task.model ? { model: r.task.model } : {}),
      data: { intent: r.intent, headline: r.headline, story: r.story, asks: r.asks, verify: r.verify, flow: r.flow },
    };
  } else {
    graph.narrative = { status: "off" };
  }
  return graph;
}
