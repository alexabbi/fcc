import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FlowGraph } from "./graph/types.ts";
import { fccHome, taskDir, tasksDir } from "./paths.ts";

const GRAPH = "graph.json";

/** Write atomically so the server never serves a half-written file. */
export function writeGraph(graph: FlowGraph): void {
  const dir = taskDir(graph.task.repoId, graph.task.id);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${GRAPH}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(graph));
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
  prompt: string;
  endedAt: string;
  status: FlowGraph["status"];
  stats?: FlowGraph["stats"];
}

/** All tasks across repos, newest first. */
export function listTasks(): TaskSummary[] {
  const reposRoot = path.join(fccHome(), "repos");
  const summaries: TaskSummary[] = [];
  for (const repoId of safeReaddir(reposRoot)) {
    for (const taskId of safeReaddir(tasksDir(repoId))) {
      const g = readGraph(repoId, taskId);
      if (!g) continue;
      summaries.push({
        repoId,
        repoRoot: g.task.repoRoot,
        id: g.task.id,
        prompt: g.task.prompt,
        endedAt: g.task.endedAt,
        status: g.status,
        stats: g.stats,
      });
    }
  }
  return summaries.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
