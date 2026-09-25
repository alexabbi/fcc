import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FlowGraph } from "./graph/types.ts";
import { fccHome, repoDir, taskDir, tasksDir } from "./paths.ts";

const GRAPH = "graph.json";

/**
 * Write atomically so the server never serves a half-written file. The
 * conversation is stripped here: it lives in memory while the story is being
 * written and never reaches the disk, in the repo or in the cache.
 */
export function writeGraph(graph: FlowGraph): void {
  const dir = taskDir(graph.task.repoId, graph.task.id);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${GRAPH}.${process.pid}.tmp`);
  const { conversation, ...stored } = graph;
  writeFileSync(tmp, JSON.stringify(stored));
  renameSync(tmp, path.join(dir, GRAPH));
}

export function readGraph(repoId: string, taskId: string): FlowGraph | null {
  try {
    return JSON.parse(readFileSync(path.join(taskDir(repoId, taskId), GRAPH), "utf8"));
  } catch {
    return null;
  }
}

export interface TaskSummary {
  repoId: string;
  repoRoot: string;
  id: string;
  /** Story headline, or a factual fallback: never the user's own words. */
  headline: string;
  endedAt: string;
  status: FlowGraph["status"];
  stats?: FlowGraph["stats"];
}

/** Remember where a repo lives, so its history can be read even before its first local task. */
export function registerRepo(repoId: string, repoRoot: string): void {
  const dir = repoDir(repoId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "repo.json"), JSON.stringify({ root: repoRoot }));
}

export function listRepos(): { repoId: string; root: string; name: string }[] {
  const repos: { repoId: string; root: string; name: string }[] = [];
  for (const repoId of safeReaddir(path.join(fccHome(), "repos"))) {
    try {
      const { root } = JSON.parse(readFileSync(path.join(repoDir(repoId), "repo.json"), "utf8"));
      if (typeof root === "string") repos.push({ repoId, root, name: path.basename(root) });
    } catch {
      // repo known only from tasks written before M3
      const t = listTasks().find((x) => x.repoId === repoId);
      if (t) repos.push({ repoId, root: t.repoRoot, name: path.basename(t.repoRoot) });
    }
  }
  return repos;
}

/** Local tasks of one repo, as full graphs. */
export function readRepoGraphs(repoId: string): FlowGraph[] {
  return safeReaddir(tasksDir(repoId))
    .map((id) => readGraph(repoId, id))
    .filter((g): g is FlowGraph => g !== null);
}

/** All tasks across repos, newest first. */
export function listTasks(): TaskSummary[] {
  const reposRoot = path.join(fccHome(), "repos");
  const summaries: TaskSummary[] = [];
  for (const repoId of safeReaddir(reposRoot)) {
    for (const taskId of safeReaddir(tasksDir(repoId))) {
      const g = readGraph(repoId, taskId);
      // A turn whose changes were all filtered out has nothing to show.
      if (!g || isEmptyTask(g)) continue;
      summaries.push({
        repoId,
        repoRoot: g.task.repoRoot,
        id: g.task.id,
        headline: headlineOf(g),
        endedAt: g.task.endedAt,
        status: g.status,
        stats: g.stats,
      });
    }
  }
  return summaries.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}

/** Analyzed, but nothing visible came out of it. */
export function isEmptyTask(g: FlowGraph): boolean {
  return g.status === "ready" && g.nodes.length === 0;
}

function headlineOf(g: FlowGraph): string {
  if (g.narrative?.status === "ready" && g.narrative.data?.headline) return g.narrative.data.headline;
  const files = g.stats?.filesChanged ?? 0;
  return files ? `${files} file${files === 1 ? "" : "s"} changed` : "No visible changes";
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
